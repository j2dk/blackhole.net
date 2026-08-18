"""Asus (AsusWRT / Asuswrt-Merlin) adapter, built on the `asusrouter` library.

That library is asyncio-native while this sidecar is a synchronous WSGI app, so
every call opens a short-lived event loop, connects, does its work and
disconnects. Sampling happens on a background thread, so the cost is off the
request path.
"""
import asyncio

import aiohttp

from asusrouter import AsusRouter, AsusData
from asusrouter.modules.wlan import AsusWLAN, Wlan
from asusrouter.modules.system import AsusSystem

from . import blank_status, device

VENDOR = 'asus'
LABEL = 'Asus (AsusWRT / Merlin) — RT / ZenWiFi / TUF / ROG'

# Radio index used by AsusWRT nvram (wl0_* = 2.4 GHz, wl1_* = first 5 GHz band)
BAND_TO_API_ID = {'host_2g': 0, 'host_5g': 1, 'guest_2g': 0, 'guest_5g': 1}
BAND_TO_WLAN = {'host_2g': Wlan.FREQ_2G, 'host_5g': Wlan.FREQ_5G,
                'guest_2g': Wlan.FREQ_2G, 'guest_5g': Wlan.FREQ_5G}


def _client(dev, session):
    return AsusRouter(
        hostname=str(dev.get('host', '')).replace('http://', '').replace('https://', '').split('/')[0],
        username=dev.get('username') or 'admin',
        password=dev.get('password') or '',
        use_ssl=bool(dev.get('use_ssl')),
        port=dev.get('port') or None,
        session=session,
    )


def _run(dev, coro_fn, timeout=30):
    """Drive one async interaction to completion on a private event loop.

    We own the aiohttp session rather than letting the library create one: if
    async_connect() fails (unreachable host, bad password) a library-owned
    session is never closed, leaking one socket pool per failed poll — and the
    sampler polls forever.
    """
    async def _outer():
        async with aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(ssl=False),
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as session:
            r = _client(dev, session)
            try:
                await r.async_connect()
                return await coro_fn(r)
            finally:
                try:
                    await r.async_disconnect()
                except Exception:
                    pass

    return asyncio.run(asyncio.wait_for(_outer(), timeout + 5))


def _pct(value):
    """AsusWRT reports usage as 0-100; normalise to the 0..1 the UI expects."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return round(v / 100, 4) if v > 1 else round(v, 4)


def _first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ''):
            return d[k]
    return None


async def _collect(r):
    """Pull everything we need in one session."""
    async def get(kind):
        try:
            return await r.async_get_data(kind)
        except Exception:
            return None

    identity = None
    try:
        identity = await r.async_get_identity()
    except Exception:
        pass

    cpu, ram, wan, wlan, clients, fw, sysinfo = (
        await get(AsusData.CPU), await get(AsusData.RAM), await get(AsusData.WAN),
        await get(AsusData.WLAN), await get(AsusData.CLIENTS),
        await get(AsusData.FIRMWARE), await get(AsusData.SYSINFO),
    )
    return identity, cpu, ram, wan, wlan, clients, fw, sysinfo


def _shape(identity, cpu, ram, wan, wlan, clients, fw, sysinfo):
    st = blank_status()

    st['model'] = (getattr(identity, 'model', None) or getattr(identity, 'product_id', None)
                   or _first(identity if isinstance(identity, dict) else {}, 'model', 'productid'))
    st['firmware'] = (str(getattr(fw, 'current', None) or _first(fw or {}, 'current', 'firmware') or '')
                      or getattr(identity, 'firmware', None) and str(identity.firmware) or None)
    st['hardware'] = getattr(identity, 'product_id', None)
    st['lan_mac'] = getattr(identity, 'mac', None) or _first(identity if isinstance(identity, dict) else {}, 'mac')

    # CPU/RAM: asusrouter exposes {'total': {'usage': x}} style maps
    if isinstance(cpu, dict):
        st['cpu'] = _pct(_first(cpu.get('total') or {}, 'usage') or _first(cpu, 'usage'))
    if isinstance(ram, dict):
        used, total = _first(ram, 'used'), _first(ram, 'total')
        if used and total:
            try:
                st['mem'] = round(float(used) / float(total), 4)
            except (TypeError, ValueError, ZeroDivisionError):
                st['mem'] = None
        else:
            st['mem'] = _pct(_first(ram, 'usage'))

    if isinstance(wan, dict):
        st['wan_ip'] = _first(wan, 'ip', 'ipaddr', 'wan_ipaddr')
        st['wan_gateway'] = _first(wan, 'gateway', 'gw', 'wan_gateway')
        st['ipv4'] = {
            'wan_ip': st['wan_ip'], 'wan_gateway': st['wan_gateway'],
            'wan_netmask': _first(wan, 'mask', 'netmask'),
            'wan_pridns': _first(wan, 'dns', 'dns1'),
            'wan_conntype': _first(wan, 'proto', 'type'),
        }

    # radios: WLAN is keyed by Wlan enum / band string
    def radio_on(*names):
        if not isinstance(wlan, dict):
            return None
        for n in names:
            for key in (n, getattr(n, 'value', None)):
                if key is None:
                    continue
                entry = wlan.get(key)
                if isinstance(entry, dict):
                    v = _first(entry, 'radio', 'radio_state', 'enabled')
                    if v is not None:
                        return bool(v)
        return None

    st['wifi_2g'] = radio_on(Wlan.FREQ_2G, '2ghz')
    st['wifi_5g'] = radio_on(Wlan.FREQ_5G, '5ghz')

    # clients: dict keyed by MAC
    devs, wireless_n, wired_n = [], 0, 0
    if isinstance(clients, dict):
        for mac, c in clients.items():
            if not isinstance(c, dict):
                continue
            if not (c.get('online') if 'online' in c else True):
                continue
            conn = str(_first(c, 'connection_type', 'connectionType', 'node') or '').lower()
            band = '5G' if '5' in conn else ('2.4G' if '2' in conn else None)
            is_wifi = bool(band) or 'wireless' in conn or 'wl' in conn
            rssi = _first(c, 'rssi', 'signal')
            devs.append(device(
                hostname=_first(c, 'name', 'nickName', 'hostname'),
                ip=_first(c, 'ip', 'ipaddr'), mac=mac,
                wireless=is_wifi, band=band,
                signal=int(rssi) if str(rssi or '').lstrip('-').isdigit() else None,
                down=_first(c, 'rx_speed'), up=_first(c, 'tx_speed'),
            ))
            wireless_n += 1 if is_wifi else 0
            wired_n += 0 if is_wifi else 1

    st['devices'] = devs
    st['wireless_clients'] = wireless_n
    st['wifi_clients_total'] = wireless_n
    st['wired_total'] = wired_n
    st['clients_total'] = len(devs)
    return st


def fetch(dev):
    data = _run(dev, _collect, timeout=40)
    return _shape(*data)


def test(dev):
    async def _probe(r):
        ident = None
        try:
            ident = await r.async_get_identity()
        except Exception:
            pass
        return getattr(ident, 'model', None) or getattr(ident, 'product_id', None)

    model = _run(dev, _probe, timeout=30)
    return {'ok': True, 'model': model,
            'message': f'Connected{" to " + model if model else ""} using {LABEL}'}


def reboot(dev):
    async def _do(r):
        return await r.async_set_state(AsusSystem.REBOOT)

    if not _run(dev, _do, timeout=30):
        raise RuntimeError('Router rejected the reboot request')


def set_wifi(dev, band, enable):
    api_id = BAND_TO_API_ID.get(band)
    if api_id is None:
        raise ValueError(f'Unsupported band "{band}" for Asus')

    async def _do(r):
        return await r.async_set_state(
            AsusWLAN.ON if enable else AsusWLAN.OFF,
            api_type='gwlan' if band.startswith('guest') else 'wlan',
            api_id=api_id,
        )

    if not _run(dev, _do, timeout=40):
        raise RuntimeError('Router rejected the Wi-Fi change')
