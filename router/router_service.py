"""Sidecar that logs into TP-Link network gear and exposes it as JSON.

Handles the main gateway (TP-Link Aginet/OID, e.g. XC220-G3v) plus any number
of access points (Archer AX10, Archer C5, ...). Keeps the encrypted RSA+AES
login logic out of the Node app, and samples in background threads so HTTP
requests never wait on a router login.
"""
import os
import re
import time
import threading
from collections import deque

from flask import Flask, jsonify, request
from tplinkrouterc6u import TPLinkEXClient, TplinkRouterProvider
from tplinkrouterc6u.common.package_enum import Connection

import vendors as _vendors

VENDORS = _vendors.registry()          # {'asus': mod, 'openwrt': mod}
TPLINK = 'tplink'


def vendor_catalog():
    """Every vendor this build can manage."""
    out = [{'id': TPLINK, 'label': 'TP-Link (Archer / EX / MR / Deco / …)',
            'drivers': True}]
    for vid, mod in sorted(VENDORS.items()):
        out.append({'id': vid, 'label': mod.LABEL, 'drivers': False})
    return out


def _vendor_of(dev):
    v = (dev or {}).get('vendor') or TPLINK
    return v if v == TPLINK or v in VENDORS else TPLINK

# Some TP-Link firmwares append a stray NUL byte to "$.ret=0;", which trips the
# library's strict numeric parser (seen on the XC220-G3v GPON gateway). Patch the
# shared MR base class so every derived client (EX / VR / MR / …) benefits, and
# fall through to the original parser when there is genuinely no return code —
# otherwise a real failure would be silently reported as success.
from tplinkrouterc6u.client.mr import TPLinkMRClient as _MRBase   # noqa: E402

assert hasattr(_MRBase, '_parse_ret_val'), \
    'tplinkrouterc6u changed: TPLinkMRClient._parse_ret_val is gone — re-check the NUL-byte workaround'
_ORIGINAL_PARSE_RET = _MRBase._parse_ret_val


def _tolerant_ret(self, response):
    m = re.search(r'\$\.ret\s*=\s*(-?\d+)', response)
    if m:
        return int(m.group(1))
    return _ORIGINAL_PARSE_RET(self, response)


_MRBase._parse_ret_val = _tolerant_ret

# ---------------------------------------------------------------------------
# Driver registry — every client the library ships, with a human label so the
# admin panel can offer them. "" / "auto" means probe for the right one.
# ---------------------------------------------------------------------------
DRIVER_LABELS = {
    'TplinkRouter': 'Archer (modern) — C6U, AX10/AX20/AX50/AX55, AX73…',
    'TplinkRouterV1_11': 'Archer, firmware 1.11+ (RSA-only login)',
    'TplinkRouterSG': 'Archer with SG_L1_S2 / CE_RED firmware (SHA256)',
    'TplinkC1200Router': 'Archer C1200',
    'TplinkC3200Router': 'Archer C3200',
    'TplinkC5400XRouter': 'Archer C5400X / AX11000',
    'TplinkC80Router': 'Archer C80',
    'TplinkWDRRouter': 'TL-WDR series',
    'TplinkRE330Router': 'RE330 range extender',
    'TPLinkC50Client': 'Archer C50 / AC1200 (GDPR-encrypted)',
    'TPLinkWR841NClient': 'TL-WR841N and GDPR RSA-512 routers',
    'TPLinkVRClient': 'Archer VR DSL series (VR600 / VR900 / VR2100…)',
    'TPLinkVR400v2Client': 'Archer VR400 v2 / older DSL & Archer C5 v4',
    'TplinkVR1200vRouter': 'Archer VR1200v',
    'TPLinkEXClient': 'EX / XC GPON gateway (XC220-G3v, EX220, EX510…)',
    'TPLinkEXClientGCM': 'EX / XC GPON gateway — AES-GCM firmware',
    'TPLinkMRClient': 'TL-MR LTE series (MR600…)',
    'TPLinkMRClientGCM': 'TL-MR LTE series — AES-GCM firmware',
    'TPLinkMR200Client': 'TL-MR200',
    'TPLinkMR600Client': 'TL-MR600',
    'TPLinkMR6400v7Client': 'TL-MR6400 v7',
    'TPLinkDecoClient': 'Deco mesh (M4 / M5 / X20 / X60…)',
    'TPLinkXDRClient': 'XDR / 7DR series (TL-XDR, TL-7DR)',
    'TPLinkRClient': 'TL-R router/VPN series',
    'TPLinkEAP115Client': 'EAP115 access point',
    'TPLinkCPE210Client': 'CPE210 outdoor CPE',
    'TPLinkSG108EClient': 'TL-SG108E managed switch',
}


def driver_catalog():
    """All drivers actually present in the installed library, labelled."""
    out = []
    for name in TplinkRouterProvider.get_clients():
        out.append({'id': name, 'label': DRIVER_LABELS.get(name, name)})
    out.sort(key=lambda d: d['label'].lower())
    return out


def _make_client(url, pw, user, driver=None, timeout=25):
    """Build a client for a device. An explicit driver skips detection (faster
    and more reliable); otherwise probe every supported model.
    Returns (client, resolved_driver_name)."""
    clients = TplinkRouterProvider.get_clients()
    if driver and driver not in ('auto', '') and driver in clients:
        return clients[driver](url, pw, username=user, timeout=timeout), driver
    c = TplinkRouterProvider.get_client(url, pw, username=user, timeout=timeout)
    return c, type(c).__name__

# Credentials are NOT read from the environment. The app owns them (SQLite) and
# pushes them to POST /config at boot and whenever they change, so no secret
# ever lives in this container's env or image.
HOST = ''
USER = 'admin'
PW = ''
# '' / 'auto' => probe for the right driver; otherwise a name from DRIVER_LABELS
DRIVER = ''            # set by POST /config ('' = auto-detect, TP-Link only)
GW_VENDOR = TPLINK     # set by POST /config
POLL_INTERVAL = float(os.environ.get('ROUTER_POLL_INTERVAL', '20'))
AP_POLL_INTERVAL = float(os.environ.get('AP_POLL_INTERVAL', '45'))
HISTORY_LEN = int(os.environ.get('ROUTER_HISTORY_LEN', '540'))  # ~3h at 20s
STALE_AFTER = max(POLL_INTERVAL * 3, 60)
AP_STALE_AFTER = max(AP_POLL_INTERVAL * 3, 150)


APS = []          # populated by POST /config

app = Flask(__name__)

_lock = threading.Lock()
_cache = {'data': None, 'ts': 0.0, 'error': None}
_history = deque(maxlen=HISTORY_LEN)
_ap_cache = {}      # ap id -> {'data':…, 'ts':…, 'error':…}
_ap_clients = {}    # resolved client class per AP host (auto-detect is slow)
_assoc = {}         # mac -> current association {ap, label, band, signal, since, hostname, roams}
_roams = deque(maxlen=int(os.environ.get('ROAM_HISTORY_LEN', '300')))
ASSOC_INTERVAL = 10.0   # cheap: reads cached AP data, no network I/O


def _s(v):
    """Stringify address-like objects (IPv4Address, etc.); keep None as None."""
    return str(v) if v is not None else None


def _norm_mac(m):
    """Canonical MAC key: lowercase hex only — joins across Pi-hole/router/AP."""
    return re.sub(r'[^0-9a-f]', '', str(m or '').lower())


def _friendly_error(e):
    name = type(e).__name__
    text = str(e).lower()
    if 'login' in text or 'password' in text or 'auth' in text or 'credential' in text:
        return 'auth_failed', 'Device rejected the credentials.'
    if 'timed out' in text or 'timeout' in name.lower():
        return 'timeout', 'Device did not respond in time.'
    if 'connection' in text or 'refused' in text or 'unreachable' in text or 'resolve' in text:
        return 'unreachable', 'Could not reach the device.'
    return 'device_error', f'Unexpected device error ({name}).'


def _try(fn, *a, **kw):
    """Call an optional router API; return None if this firmware lacks it."""
    try:
        return fn(*a, **kw)
    except Exception:
        return None


# Explicit source -> output mapping. String surgery on these names is fragile
# ("lan_ipv4_ipaddress" has no "_address" substring), so spell it out.
IPV4_FIELDS = {
    'wan_ipv4_ipaddress': 'wan_ip',
    'wan_ipv4_gateway_address': 'wan_gateway',
    'wan_ipv4_netmask_address': 'wan_netmask',
    'wan_ipv4_pridns_address': 'wan_pridns',
    'wan_ipv4_snddns_address': 'wan_snddns',
    'wan_ipv4_conntype': 'wan_conntype',
    'lan_ipv4_ipaddress': 'lan_ip',
    'lan_ipv4_netmask_address': 'lan_netmask',
    'lan_macaddress': 'lan_mac',
    'lan_ipv4_dhcp_enable': 'lan_dhcp_enable',
}


def _ipv4(obj):
    """Flatten an IPv4Status dataclass into plain JSON."""
    if obj is None:
        return None
    out = {}
    for src, dst in IPV4_FIELDS.items():
        v = getattr(obj, src, None)
        if v is None:
            continue
        out[dst] = v if isinstance(v, bool) else _s(v)
    return out


def _authorize(client, attempts=2, delay=2.0):
    """Log in, retrying once. This gateway intermittently answers its own login
    handshake with HTTP 406 when it is busy; a single retry rides that out."""
    last = None
    for i in range(attempts):
        try:
            client.authorize()
            return
        except Exception as e:
            last = e
            if i + 1 < attempts:
                time.sleep(delay)
    raise last


def _leases(client):
    try:
        return [{
            'ip': _s(getattr(l, 'ipaddress', None)),
            'mac': str(getattr(l, 'macaddress', '') or ''),
            'hostname': getattr(l, 'hostname', None),
            'lease': getattr(l, 'lease_time', None),
        } for l in (client.get_ipv4_dhcp_leases() or [])]
    except Exception:
        return []


def _reservations(client):
    try:
        return [{
            'ip': _s(getattr(r, 'ipaddress', None)),
            'mac': str(getattr(r, 'macaddress', '') or ''),
            'hostname': getattr(r, 'hostname', None),
            'enabled': getattr(r, 'enabled', None),
        } for r in (client.get_ipv4_reservations() or [])]
    except Exception:
        return []   # many firmwares (and APs in bridge mode) don't expose this


def _extract_devices(st):
    """Normalize a status object's device list, preserving the connection type
    (WIRED / HOST_2G / HOST_5G / GUEST_*) which is what tells us whether a
    client is actually associated with an access point's radio."""
    out = []
    for d in (getattr(st, 'devices', []) or []):
        raw_type = str(getattr(d, 'type', '') or '').replace('Connection.', '').upper()
        ip = _s(getattr(d, 'ipaddress', None))
        if ip in ('0.0.0.0', ''):
            ip = None  # APs in bridge mode don't know DHCP-assigned addresses
        out.append({
            'hostname': getattr(d, 'hostname', None),
            'ip': ip,
            'mac': str(getattr(d, 'macaddress', None) or ''),
            'mac_key': _norm_mac(getattr(d, 'macaddress', None)),
            'type': raw_type.lower(),
            'wireless': raw_type.startswith('HOST_') or raw_type.startswith('GUEST_'),
            'band': '2.4G' if '2G' in raw_type else ('5G' if '5G' in raw_type else None),
            'signal': getattr(d, 'signal', None),
            'down': getattr(d, 'down_speed', None),
            'up': getattr(d, 'up_speed', None),
        })
    return out


# ---------------------------------------------------------------------------
# Gateway
# ---------------------------------------------------------------------------
# WAN/lease/reservation data barely changes and each query is another request
# against a gateway that rate-limits, so refresh it on a slow cadence and reuse
# the last good copy in between.
EXTRAS_TTL = float(os.environ.get('ROUTER_EXTRAS_TTL', '150'))
_extras = {}   # device id -> {'ts': float, 'data': {...}}


def _get_extras(dev_id, client, want_leases=False):
    ent = _extras.get(dev_id)
    if ent and time.time() - ent['ts'] < EXTRAS_TTL:
        return ent['data']
    data = {'ipv4': _ipv4(_try(client.get_ipv4_status)),
            'reservations': _reservations(client)}
    if want_leases:
        data['leases'] = _leases(client)
    _extras[dev_id] = {'ts': time.time(), 'data': data}
    return data


def _fetch_gateway():
    if GW_VENDOR != TPLINK:
        dev = {'host': HOST, 'username': USER, 'password': PW}
        st = VENDORS[GW_VENDOR].fetch(dev)
        st['driver'] = GW_VENDOR
        st['driver_label'] = VENDORS[GW_VENDOR].LABEL
        st['vendor'] = GW_VENDOR
        st.setdefault('can_reboot', True)
        st.setdefault('can_wifi', True)
        return st
    r, resolved = _make_client(HOST, PW, USER, DRIVER, timeout=20)
    _authorize(r)
    try:
        st = r.get_status()
        try:
            fw = r.get_firmware()
        except Exception:
            fw = None
        return {
            'ok': True,
            'wan_ip': _s(getattr(st, 'wan_ipv4_address', None)),
            'wan_gateway': _s(getattr(st, 'wan_ipv4_gateway', None)),
            'wan_mac': str(getattr(st, 'wan_macaddress', None) or ''),
            'lan_ip': _s(getattr(st, 'lan_ipv4_address', None)),
            'lan_mac': str(getattr(st, 'lan_macaddress', None) or ''),
            'cpu': getattr(st, 'cpu_usage', None),
            'mem': getattr(st, 'mem_usage', None),
            'clients_total': getattr(st, 'clients_total', None),
            'wired_total': getattr(st, 'wired_total', None),
            'wifi_clients_total': getattr(st, 'wifi_clients_total', None),
            'guest_clients_total': getattr(st, 'guest_clients_total', None),
            'wifi_2g': getattr(st, 'wifi_2g_enable', None),
            'wifi_5g': getattr(st, 'wifi_5g_enable', None),
            'firmware': getattr(fw, 'firmware_version', None) if fw else None,
            'model': getattr(fw, 'model', None) if fw else None,
            'hardware': getattr(fw, 'hardware_version', None) if fw else None,
            'devices': _extract_devices(st),
            **_get_extras('gateway', r, want_leases=True),
            'driver': resolved, 'driver_label': DRIVER_LABELS.get(resolved, resolved),
            'vendor': TPLINK,
            'vendor': TPLINK, 'can_reboot': True, 'can_wifi': True,
        }
    finally:
        try:
            r.logout()
        except Exception:
            pass


def _sample_gateway():
    data = _fetch_gateway()
    with _lock:
        _cache['data'] = data
        _cache['ts'] = time.time()
        _cache['error'] = None
        if data.get('ok') and data.get('cpu') is not None:
            _history.append({
                't': int(time.time()),
                'cpu': round((data.get('cpu') or 0) * 100, 1),
                'mem': round((data.get('mem') or 0) * 100, 1),
            })
    return data


def _gateway_loop():
    while True:
        if not (PW and HOST):
            time.sleep(3)          # not configured yet — wait for the app's push
            continue
        try:
            _sample_gateway()
        except Exception as e:
            code, msg = _friendly_error(e)
            app.logger.warning('gateway sample failed: %s: %s', type(e).__name__, e)
            with _lock:
                _cache['error'] = {'error': code, 'message': msg, 'ts': time.time()}
        time.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------------
# Access points
# ---------------------------------------------------------------------------
def _fetch_ap(ap):
    vendor = _vendor_of(ap)
    if vendor != TPLINK:
        st = VENDORS[vendor].fetch(ap)
        st.update({'id': ap['id'], 'label': ap['label'], 'ip': ap['ip'],
                   'vendor': vendor, 'driver': vendor,
                   'driver_label': VENDORS[vendor].LABEL})
        st['wireless_macs'] = [d['mac_key'] for d in st.get('devices', [])
                               if d.get('wireless') and d.get('mac_key')]
        return st
    # An explicit driver is used as-is; otherwise detect once and remember the
    # resolved class so later polls skip the probe.
    driver = ap.get('driver') or _ap_clients.get(ap['id']) or ''
    r, resolved = _make_client(ap['host'], ap['password'], ap['username'], driver, timeout=20)
    _ap_clients[ap['id']] = resolved
    _authorize(r)
    try:
        st = r.get_status()
        try:
            fw = r.get_firmware()
        except Exception:
            fw = None
        devices = _extract_devices(st)
        return {
            'ok': True,
            'id': ap['id'], 'label': ap['label'], 'ip': ap['ip'],
            'model': getattr(fw, 'model', None) if fw else None,
            'firmware': getattr(fw, 'firmware_version', None) if fw else None,
            'cpu': getattr(st, 'cpu_usage', None),
            'mem': getattr(st, 'mem_usage', None),
            'clients_total': getattr(st, 'clients_total', None),
            'wifi_clients_total': getattr(st, 'wifi_clients_total', None),
            'wired_total': getattr(st, 'wired_total', None),
            'guest_clients_total': getattr(st, 'guest_clients_total', None),
            'wifi_2g': getattr(st, 'wifi_2g_enable', None),
            'wifi_5g': getattr(st, 'wifi_5g_enable', None),
            'lan_mac': str(getattr(st, 'lan_macaddress', None) or ''),
            'devices': devices,
            # Only radio-associated clients prove attachment; in bridge mode a
            # "wired" entry just means the AP can see it on the LAN segment.
            'wireless_macs': [d['mac_key'] for d in devices if d['wireless'] and d['mac_key']],
            'wireless_clients': sum(1 for d in devices if d['wireless']),
            'driver': resolved, 'driver_label': DRIVER_LABELS.get(resolved, resolved),
            'vendor': TPLINK,
            **_get_extras(ap['id'], r),
            'can_reboot': True, 'can_wifi': True,
        }
    finally:
        try:
            r.logout()
        except Exception:
            pass


def _ap_loop(ap_id):
    """Poll one AP forever. The config is looked up by id on every cycle so a
    credential change from the admin panel is picked up without a restart, and
    a removed AP simply ends its own thread."""
    while True:
        ap = next((a for a in APS if a['id'] == ap_id), None)
        if ap is None:
            app.logger.warning('AP %s removed — stopping its poller', ap_id)
            return
        try:
            data = _fetch_ap(ap)
            with _lock:
                _ap_cache[ap_id] = {'data': data, 'ts': time.time(), 'error': None}
        except Exception as e:
            code, msg = _friendly_error(e)
            app.logger.warning('AP %s sample failed: %s: %s', ap_id, type(e).__name__, e)
            with _lock:
                prev = _ap_cache.get(ap_id, {})
                prev['error'] = {'error': code, 'message': msg, 'ts': time.time()}
                _ap_cache[ap_id] = prev
        time.sleep(AP_POLL_INTERVAL)


# ---------------------------------------------------------------------------
# Roaming tracker
#
# Runs on its own timer and only reads the cached AP snapshots, so it never
# races the per-AP polling threads and costs no extra router logins. A device
# "roams" when the AP reporting it as radio-associated changes; a band change on
# the same AP is recorded as band-steering.
# ---------------------------------------------------------------------------
def _reconcile_assoc():
    now = time.time()
    with _lock:
        snapshot = {k: (v.get('data') or {}) for k, v in _ap_cache.items()}

    # Build the current global picture. If two APs both claim a client (can
    # happen mid-roam), prefer the stronger signal, else the fresher sample.
    current = {}
    for ap_id, data in snapshot.items():
        if not data.get('ok'):
            continue
        for d in data.get('devices', []):
            if not d.get('wireless') or not d.get('mac_key'):
                continue
            mac = d['mac_key']
            cand = {'ap': ap_id, 'label': data.get('label'), 'band': d.get('band'),
                    'signal': d.get('signal'), 'hostname': d.get('hostname') or None,
                    'mac': d.get('mac')}
            prev = current.get(mac)
            if prev is None:
                current[mac] = cand
            else:
                ps, cs = prev.get('signal'), cand.get('signal')
                if ps is None and cs is not None:
                    current[mac] = cand
                elif ps is not None and cs is not None and cs > ps:
                    current[mac] = cand

    with _lock:
        for mac, cur in current.items():
            old = _assoc.get(mac)
            if old is None:
                _assoc[mac] = {**cur, 'since': now, 'first_seen': now, 'roams': 0, 'online': True}
                continue
            moved_ap = old.get('ap') != cur['ap']
            moved_band = (not moved_ap) and old.get('band') != cur.get('band') and cur.get('band')
            if moved_ap or moved_band:
                _roams.append({
                    't': int(now), 'mac': cur.get('mac') or mac,
                    'hostname': cur.get('hostname') or old.get('hostname'),
                    'from_ap': old.get('ap'), 'from_label': old.get('label'), 'from_band': old.get('band'),
                    'to_ap': cur['ap'], 'to_label': cur.get('label'), 'to_band': cur.get('band'),
                    'kind': 'roam' if moved_ap else 'band-steer',
                    'held': round(now - (old.get('since') or now), 1),
                })
                _assoc[mac] = {**cur, 'since': now, 'first_seen': old.get('first_seen', now),
                               'roams': old.get('roams', 0) + 1, 'online': True}
            else:
                # same AP+band: refresh live fields, keep the association start
                _assoc[mac] = {**old, **cur, 'since': old.get('since', now), 'online': True}
        for mac, rec in _assoc.items():
            if mac not in current:
                rec['online'] = False


def _assoc_loop():
    while True:
        try:
            _reconcile_assoc()
        except Exception as e:
            app.logger.warning('assoc reconcile failed: %s: %s', type(e).__name__, e)
        time.sleep(ASSOC_INTERVAL)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route('/status')
def status():
    if not (PW and HOST):
        return jsonify({'ok': False, 'error': 'awaiting_config',
                        'message': 'Waiting for the app to push device configuration'}), 503
    with _lock:
        cached, ts, err = _cache['data'], _cache['ts'], _cache.get('error')
    if cached and cached.get('ok'):
        age = time.time() - ts
        payload = dict(cached, ts=int(ts), age=round(age, 1), stale=age > STALE_AFTER)
        if age > STALE_AFTER:
            payload['ok'] = False
            payload.setdefault('error', (err or {}).get('error', 'stale'))
            payload['message'] = (err or {}).get('message', f'No fresh sample for {int(age)}s.')
            return jsonify(payload), 502
        return jsonify(payload), 200
    if err:
        return jsonify({'ok': False, **err}), 502
    try:
        data = _sample_gateway()
        return jsonify(dict(data, ts=int(time.time()), age=0.0, stale=False)), 200
    except Exception as e:
        code, msg = _friendly_error(e)
        app.logger.warning('gateway status failed: %s: %s', type(e).__name__, e)
        return jsonify({'ok': False, 'error': code, 'message': msg}), 502


@app.route('/aps')
def aps():
    """All access points, each with its client list and wireless MAC set."""
    if not APS:
        return jsonify({'ok': True, 'configured': False, 'aps': []})
    now = time.time()
    out = []
    with _lock:
        snapshot = {k: dict(v) for k, v in _ap_cache.items()}
    for ap in APS:
        entry = snapshot.get(ap['id'])
        if entry and entry.get('data'):
            age = now - entry['ts']
            d = dict(entry['data'], ts=int(entry['ts']), age=round(age, 1), stale=age > AP_STALE_AFTER)
            if age > AP_STALE_AFTER:
                d['ok'] = False
                d['message'] = (entry.get('error') or {}).get('message', f'No fresh sample for {int(age)}s.')
            out.append(d)
        else:
            err = (entry or {}).get('error') or {'error': 'warming_up', 'message': 'First sample not taken yet.'}
            out.append({'ok': False, 'id': ap['id'], 'label': ap['label'], 'ip': ap['ip'], **err})
    return jsonify({'ok': True, 'configured': True, 'aps': out})


@app.route('/roaming')
def roaming():
    """Current radio associations + recent roam / band-steer events."""
    now = time.time()
    with _lock:
        assoc = {m: dict(v) for m, v in _assoc.items()}
        events = list(_roams)
    for m, v in assoc.items():
        v['held'] = round(now - (v.get('since') or now), 1)
        v['tracked_for'] = round(now - (v.get('first_seen') or now), 1)
    return jsonify({
        'ok': True,
        'assoc': assoc,
        'events': list(reversed(events)),   # newest first
        'tracking_since': int(_TRACK_START),
        'interval': ASSOC_INTERVAL,
    })


# ---------------------------------------------------------------------------
# Control plane — reboot / Wi-Fi radios. Every action opens its own short-lived
# authenticated session; nothing here runs on a schedule.
# ---------------------------------------------------------------------------
BANDS = {
    'host_2g': Connection.HOST_2G, 'host_5g': Connection.HOST_5G,
    'guest_2g': Connection.GUEST_2G, 'guest_5g': Connection.GUEST_5G,
}


def _resolve_device(dev_id):
    """(device-dict, vendor) for 'gateway' or an AP id; (None, message) if unknown."""
    if dev_id == 'gateway':
        if not (PW and HOST):
            return None, 'Gateway is not configured yet'
        return {'host': HOST, 'username': USER, 'password': PW,
                'driver': DRIVER, 'vendor': GW_VENDOR}, GW_VENDOR
    ap = next((a for a in APS if a['id'] == dev_id), None)
    if not ap:
        return None, f'Unknown device "{dev_id}"'
    return ap, _vendor_of(ap)


def _open_client(dev_id):
    """Authorized client for 'gateway' or an AP id, or (None, error)."""
    if dev_id == 'gateway':
        if not (PW and HOST):
            return None, 'Gateway is not configured yet'
        c, _ = _make_client(HOST, PW, USER, DRIVER, timeout=25)
        _authorize(c)
        return c, None
    ap = next((a for a in APS if a['id'] == dev_id), None)
    if not ap:
        return None, f'Unknown device "{dev_id}"'
    driver = ap.get('driver') or _ap_clients.get(ap['id']) or ''
    c, _ = _make_client(ap['host'], ap['password'], ap['username'], driver, timeout=25)
    _authorize(c)
    return c, None


@app.route('/control/<dev_id>/reboot', methods=['POST'])
def control_reboot(dev_id):
    client = None
    try:
        dev, vendor = _resolve_device(dev_id)
        if dev is None:
            return jsonify({'ok': False, 'error': 'bad_device', 'message': vendor}), 400
        if vendor != TPLINK:
            VENDORS[vendor].reboot(dev)
        else:
            client, err = _open_client(dev_id)
            if err:
                return jsonify({'ok': False, 'error': 'bad_device', 'message': err}), 400
            client.reboot()
        app.logger.warning('reboot issued to %s (%s)', dev_id, vendor)
        # the device is going down; drop its cached sample so the UI shows reality
        with _lock:
            if dev_id == 'gateway':
                _cache['data'] = None
                _cache['error'] = {'error': 'rebooting', 'message': 'Reboot issued — device is restarting.'}
            else:
                _ap_cache[dev_id] = {'data': None, 'ts': 0,
                                     'error': {'error': 'rebooting', 'message': 'Reboot issued — device is restarting.'}}
        return jsonify({'ok': True, 'action': 'reboot', 'device': dev_id})
    except Exception as e:
        code, msg = _friendly_error(e)
        app.logger.warning('reboot %s failed: %s: %s', dev_id, type(e).__name__, e)
        return jsonify({'ok': False, 'error': code, 'message': msg}), 502
    finally:
        if client:
            try:
                client.logout()
            except Exception:
                pass


@app.route('/control/<dev_id>/wifi', methods=['POST'])
def control_wifi(dev_id):
    body = request.get_json(silent=True) or {}
    band = str(body.get('band', '')).lower()
    enable = bool(body.get('enable'))
    if band not in BANDS:
        return jsonify({'ok': False, 'error': 'bad_band',
                        'message': f'band must be one of {", ".join(BANDS)}'}), 400
    client = None
    try:
        dev, vendor = _resolve_device(dev_id)
        if dev is None:
            return jsonify({'ok': False, 'error': 'bad_device', 'message': vendor}), 400
        if vendor != TPLINK:
            VENDORS[vendor].set_wifi(dev, band, enable)
        else:
            client, err = _open_client(dev_id)
            if err:
                return jsonify({'ok': False, 'error': 'bad_device', 'message': err}), 400
            client.set_wifi(BANDS[band], enable)
        app.logger.warning('wifi %s %s on %s', band, 'ENABLED' if enable else 'DISABLED', dev_id)
        # force a fresh sample so the UI reflects the new radio state promptly
        with _lock:
            if dev_id == 'gateway':
                _cache['ts'] = 0
            elif dev_id in _ap_cache:
                _ap_cache[dev_id]['ts'] = 0
        return jsonify({'ok': True, 'action': 'wifi', 'device': dev_id, 'band': band, 'enable': enable})
    except Exception as e:
        code, msg = _friendly_error(e)
        app.logger.warning('wifi %s on %s failed: %s: %s', band, dev_id, type(e).__name__, e)
        return jsonify({'ok': False, 'error': code, 'message': msg}), 502
    finally:
        if client:
            try:
                client.logout()
            except Exception:
                pass


@app.route('/history')
def history():
    with _lock:
        return jsonify({'samples': list(_history), 'interval': POLL_INTERVAL})


@app.route('/config', methods=['POST'])
def push_config():
    """Re-target the sidecar at runtime (called by the admin panel).

    New AP threads are started for hosts we haven't seen; removed APs simply
    stop being reported. Existing threads read the shared APS list each cycle.
    """
    global HOST, USER, PW, APS, DRIVER, GW_VENDOR
    body = request.get_json(silent=True) or {}
    gw = body.get('gateway') or {}
    if gw.get('host'):
        h = gw['host']
        HOST = h if str(h).startswith('http') else 'http://' + str(h)
    if gw.get('username'):
        USER = gw['username']
    if gw.get('password'):
        PW = gw['password']
    DRIVER = gw.get('driver') or ''
    GW_VENDOR = gw.get('vendor') or TPLINK

    incoming = []
    for i, a in enumerate(body.get('aps') or [], start=1):
        host = str(a.get('host') or '').strip()
        if not host or not a.get('password'):
            continue
        incoming.append({
            'id': a.get('id') or f'ap{i}',
            'host': host if host.startswith('http') else 'http://' + host,
            'ip': host.replace('http://', '').replace('https://', '').split('/')[0],
            'label': a.get('label') or f'AP {i}',
            'username': a.get('username') or 'admin',
            'password': a.get('password'),
            'driver': a.get('driver') or '',
            'vendor': a.get('vendor') or TPLINK,
        })
    known = {a['id'] for a in APS}
    APS[:] = incoming
    with _lock:
        _extras.clear()
        for ap_id in list(_ap_cache):
            if ap_id not in {a['id'] for a in incoming}:
                _ap_cache.pop(ap_id, None)
    for ap in incoming:
        _ap_clients.pop(ap['id'], None)   # re-resolve; the driver may have changed
        if ap['id'] not in known:
            threading.Thread(target=_ap_loop, args=(ap['id'],), daemon=True).start()
    app.logger.warning('config updated: gateway=%s aps=%d', HOST, len(incoming))
    return jsonify({'ok': True, 'gateway': HOST, 'aps': [a['id'] for a in incoming]})


@app.route('/test', methods=['POST'])
def test_credentials():
    """Try a login against a device without storing anything."""
    body = request.get_json(silent=True) or {}
    host = str(body.get('host') or '').strip()
    if not host:
        return jsonify({'ok': False, 'message': 'Host is required'})
    url = host if host.startswith('http') else 'http://' + host
    user = body.get('username') or 'admin'
    pw = body.get('password') or ''
    kind = body.get('kind') or 'ap'
    driver = body.get('driver') or ''
    vendor = body.get('vendor') or TPLINK
    if vendor != TPLINK:
        if vendor not in VENDORS:
            return jsonify({'ok': False, 'message': f'Vendor "{vendor}" is not available in this build'})
        try:
            res = VENDORS[vendor].test({'host': host, 'username': user, 'password': pw})
            res.setdefault('driver', vendor)
            res.setdefault('driver_label', VENDORS[vendor].LABEL)
            return jsonify(res)
        except Exception as e:
            _, msg = _friendly_error(e)
            return jsonify({'ok': False, 'message': msg})
    # A GPON/Aginet gateway is not resolved by auto-detection, so when the caller
    # has not pinned a driver we start from the EX client for gateways.
    if not driver and kind == 'gateway':
        driver = 'TPLinkEXClient'
    client = None
    try:
        client, resolved = _make_client(url, pw, user, driver, timeout=25)
        _authorize(client, attempts=2)
        fw = _try(client.get_firmware)
        model = getattr(fw, 'model', None) if fw else None
        return jsonify({
            'ok': True,
            'message': f'Connected{" to " + model if model else ""} using {DRIVER_LABELS.get(resolved, resolved)}',
            'model': model, 'driver': resolved,
            'driver_label': DRIVER_LABELS.get(resolved, resolved),
        })
    except Exception as e:
        _, msg = _friendly_error(e)
        return jsonify({'ok': False, 'message': msg})
    finally:
        if client:
            try:
                client.logout()
            except Exception:
                pass


@app.route('/clients')
def clients_catalog():
    """Every router/AP model driver this build supports."""
    return jsonify({'ok': True, 'drivers': driver_catalog(), 'vendors': vendor_catalog()})


@app.route('/health')
def health():
    return jsonify({'service': 'router', 'host': HOST, 'user': USER, 'configured': bool(PW),
                    'history': len(_history), 'interval': POLL_INTERVAL,
                    'driver': DRIVER or 'auto', 'drivers_supported': len(DRIVER_LABELS),
                    'vendors': [v['id'] for v in vendor_catalog()],
                    'aps': [{'id': a['id'], 'ip': a['ip'], 'label': a['label'],
                             'driver': a.get('driver') or 'auto'} for a in APS]})


_TRACK_START = time.time()

# Both loops start immediately and idle until POST /config arrives.
threading.Thread(target=_gateway_loop, daemon=True).start()
threading.Thread(target=_assoc_loop, daemon=True).start()

if __name__ == '__main__':
    # Production WSGI server (multi-threaded) — the Flask dev server serializes
    # requests, which made every UI panel wait behind a slow router login.
    #
    # Loopback by default: this now runs as a supervised child process inside the
    # application container, so the port must not be reachable from the LAN.
    # Set ROUTER_BIND=0.0.0.0 only when deliberately running it standalone.
    from waitress import serve
    bind = os.environ.get('ROUTER_BIND', '127.0.0.1')
    port = int(os.environ.get('ROUTER_PORT', '5000'))
    print(f'vendor sidecar listening on {bind}:{port}', flush=True)
    serve(app, host=bind, port=port, threads=16)
