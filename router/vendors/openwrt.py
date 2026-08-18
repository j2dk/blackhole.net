"""OpenWrt adapter, speaking ubus JSON-RPC over HTTP.

Requires the router to expose the RPC endpoint:

    opkg update && opkg install uhttpd-mod-ubus rpcd
    # optional, gives nicer client names:
    opkg install luci-mod-rpc

The login user needs ubus ACLs for the objects used below (`root` has them by
default). No extra Python dependency — this is plain JSON over HTTP.
"""
import requests

from . import blank_status, device

VENDOR = 'openwrt'
LABEL = 'OpenWrt (ubus RPC) — any supported device'

NULL_SESSION = '00000000000000000000000000000000'
# uci radio section -> the band we report it as
RADIO_BAND_HINTS = (('2', '2.4G'), ('5', '5G'), ('6', '6G'))


class UbusError(RuntimeError):
    pass


class Ubus:
    """Minimal ubus JSON-RPC client with a login session."""

    def __init__(self, host, username, password, timeout=20, use_ssl=False):
        h = str(host or '').replace('http://', '').replace('https://', '').split('/')[0]
        scheme = 'https' if use_ssl else 'http'
        self.url = f'{scheme}://{h}/ubus'
        self.username = username or 'root'
        self.password = password or ''
        self.timeout = timeout
        self.session = None
        self._id = 0
        self._http = requests.Session()
        self._http.verify = False

    # -- plumbing ----------------------------------------------------------
    def _rpc(self, params):
        self._id += 1
        payload = {'jsonrpc': '2.0', 'id': self._id, 'method': 'call', 'params': params}
        r = self._http.post(self.url, json=payload, timeout=self.timeout)
        if r.status_code == 404:
            raise UbusError('ubus RPC not found — install uhttpd-mod-ubus and rpcd')
        r.raise_for_status()
        body = r.json()
        if 'error' in body:
            raise UbusError(body['error'].get('message', 'ubus error'))
        result = body.get('result') or []
        # ubus returns [status, payload]; status 0 == OK, 6 == permission denied
        if not result:
            raise UbusError('empty ubus response')
        code = result[0]
        if code == 6:
            raise UbusError('ubus permission denied — check the rpcd ACLs for this user')
        if code != 0:
            raise UbusError(f'ubus status {code}')
        return result[1] if len(result) > 1 else {}

    def login(self):
        data = self._rpc([NULL_SESSION, 'session', 'login',
                          {'username': self.username, 'password': self.password}])
        self.session = (data or {}).get('ubus_rpc_session')
        if not self.session:
            raise UbusError('Login rejected')
        return self.session

    def call(self, obj, method, args=None):
        if not self.session:
            self.login()
        return self._rpc([self.session, obj, method, args or {}])

    def try_call(self, obj, method, args=None):
        """For optional objects (luci-mod-rpc may not be installed)."""
        try:
            return self.call(obj, method, args)
        except Exception:
            return None

    def close(self):
        try:
            if self.session:
                self.call('session', 'destroy', {'ubus_rpc_session': self.session})
        except Exception:
            pass
        try:
            self._http.close()
        except Exception:
            pass


def _connect(dev):
    u = Ubus(dev.get('host'), dev.get('username'), dev.get('password'),
             use_ssl=bool(dev.get('use_ssl')))
    u.login()
    return u


def _band_of_radio(radio_name, cfg):
    """Prefer the configured band/hwmode, else guess from the section name."""
    band = str((cfg or {}).get('band') or '').lower()
    if '6' in band:
        return '6G'
    if '5' in band:
        return '5G'
    if '2' in band:
        return '2.4G'
    hw = str((cfg or {}).get('hwmode') or '').lower()   # 11a => 5 GHz, 11g => 2.4
    if 'a' in hw:
        return '5G'
    if 'g' in hw or 'b' in hw:
        return '2.4G'
    for token, label in RADIO_BAND_HINTS:
        if token in str(radio_name):
            return label
    return None


def fetch(dev):
    u = _connect(dev)
    try:
        st = blank_status()

        board = u.try_call('system', 'board') or {}
        st['model'] = board.get('model') or board.get('board_name')
        st['firmware'] = ((board.get('release') or {}).get('description')
                          or (board.get('release') or {}).get('version'))
        st['hardware'] = board.get('board_name')

        info = u.try_call('system', 'info') or {}
        mem = info.get('memory') or {}
        total, free = mem.get('total'), mem.get('free')
        if total:
            avail = mem.get('available', free) or free or 0
            st['mem'] = round(max(0.0, (total - avail) / total), 4)
        load = info.get('load') or []
        if load:
            # ubus load is scaled by 65536; normalise the 1-minute figure
            st['cpu'] = round(min(1.0, (load[0] / 65536.0)), 4)

        wan = u.try_call('network.interface.wan', 'status') or {}
        addrs = wan.get('ipv4-address') or []
        st['wan_ip'] = addrs[0].get('address') if addrs else None
        routes = wan.get('route') or []
        st['wan_gateway'] = next((r.get('nexthop') for r in routes if r.get('target') in ('0.0.0.0', '::')), None)
        lan = u.try_call('network.interface.lan', 'status') or {}
        lan_addrs = lan.get('ipv4-address') or []
        st['lan_ip'] = lan_addrs[0].get('address') if lan_addrs else None
        st['ipv4'] = {
            'wan_ip': st['wan_ip'], 'wan_gateway': st['wan_gateway'],
            'wan_netmask': str(addrs[0].get('mask')) if addrs else None,
            'wan_conntype': wan.get('proto'), 'lan_ip': st['lan_ip'],
            'wan_pridns': (wan.get('dns-server') or [None])[0],
        }

        # ---- name hints: MAC/IP -> hostname (luci-mod-rpc, then DHCP leases)
        names_by_mac, ip_by_mac = {}, {}
        hints = u.try_call('luci-rpc', 'getHostHints') or {}
        for mac, h in (hints.items() if isinstance(hints, dict) else []):
            key = str(mac).lower()
            if isinstance(h, dict):
                if h.get('name'):
                    names_by_mac[key] = h['name']
                ipv4 = h.get('ipv4') or (h.get('ipaddrs') or [None])[0]
                if ipv4:
                    ip_by_mac[key] = ipv4
        leases = []
        dhcp = u.try_call('luci-rpc', 'getDHCPLeases') or {}
        for l in (dhcp.get('dhcp_leases') or []):
            mac = str(l.get('macaddr') or '').lower()
            if l.get('hostname'):
                names_by_mac.setdefault(mac, l['hostname'])
            if l.get('ipaddr'):
                ip_by_mac.setdefault(mac, l['ipaddr'])
            leases.append({'ip': l.get('ipaddr'), 'mac': l.get('macaddr'),
                           'hostname': l.get('hostname'), 'lease': l.get('expires')})
        st['leases'] = leases

        # ---- wireless: radios and their associated clients
        devs, wireless_n = [], 0
        wireless = u.try_call('network.wireless', 'status') or {}
        seen_bands = {}
        for radio, rinfo in (wireless.items() if isinstance(wireless, dict) else []):
            if not isinstance(rinfo, dict):
                continue
            band = _band_of_radio(radio, rinfo.get('config') or {})
            up = rinfo.get('up')
            if band:
                seen_bands[band] = bool(up) if up is not None else seen_bands.get(band, True)
            for iface in (rinfo.get('interfaces') or []):
                ifname = iface.get('ifname')
                if not ifname:
                    continue
                assoc = u.try_call('iwinfo', 'assoclist', {'device': ifname}) or {}
                for c in (assoc.get('results') or []):
                    mac = c.get('mac')
                    key = str(mac or '').lower()
                    devs.append(device(
                        hostname=names_by_mac.get(key), ip=ip_by_mac.get(key), mac=mac,
                        wireless=True, band=band, signal=c.get('signal'),
                        down=c.get('rx', {}).get('rate') if isinstance(c.get('rx'), dict) else None,
                        up=c.get('tx', {}).get('rate') if isinstance(c.get('tx'), dict) else None,
                    ))
                    wireless_n += 1
        st['wifi_2g'] = seen_bands.get('2.4G')
        st['wifi_5g'] = seen_bands.get('5G')

        # ---- wired: anything with a lease that isn't already a Wi-Fi client
        wifi_macs = {d['mac_key'] for d in devs}
        for mac, name in names_by_mac.items():
            from . import norm_mac
            if norm_mac(mac) in wifi_macs:
                continue
            devs.append(device(hostname=name, ip=ip_by_mac.get(mac), mac=mac, wireless=False))

        st['devices'] = devs
        st['wireless_clients'] = wireless_n
        st['wifi_clients_total'] = wireless_n
        st['wired_total'] = len(devs) - wireless_n
        st['clients_total'] = len(devs)
        return st
    finally:
        u.close()


def test(dev):
    u = _connect(dev)
    try:
        board = u.try_call('system', 'board') or {}
        model = board.get('model') or board.get('board_name')
        return {'ok': True, 'model': model,
                'message': f'Connected{" to " + model if model else ""} using {LABEL}'}
    finally:
        u.close()


def reboot(dev):
    u = _connect(dev)
    try:
        u.call('system', 'reboot')
    finally:
        u.close()


def _radio_sections(u):
    """uci wireless radio sections with their resolved band."""
    cfg = u.call('uci', 'get', {'config': 'wireless'}) or {}
    out = {}
    for name, section in (cfg.get('values') or {}).items():
        if not isinstance(section, dict) or section.get('.type') != 'wifi-device':
            continue
        out[name] = _band_of_radio(name, section)
    return out


def set_wifi(dev, band, enable):
    want = {'host_2g': '2.4G', 'guest_2g': '2.4G',
            'host_5g': '5G', 'guest_5g': '5G'}.get(band)
    if not want:
        raise ValueError(f'Unsupported band "{band}" for OpenWrt')
    u = _connect(dev)
    try:
        radios = _radio_sections(u)
        targets = [name for name, b in radios.items() if b == want]
        if not targets:
            raise UbusError(f'No {want} radio found on this device')
        for name in targets:
            # disabled='0' enables the radio; '1' disables it
            u.call('uci', 'set', {'config': 'wireless', 'section': name,
                                  'values': {'disabled': '0' if enable else '1'}})
        u.call('uci', 'commit', {'config': 'wireless'})
        u.call('network', 'reload')          # applies the wireless change
    finally:
        u.close()
