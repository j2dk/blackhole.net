"""Vendor adapters.

Every adapter turns a vendor's own API into the one normalised shape the rest of
Blackhole.Net consumes, so the Network Map / Wi-Fi Health / roaming / Routers &
APs features work identically no matter what hardware is behind them.

Contract — each adapter module exposes:

    VENDOR    : str                      # 'asus' | 'openwrt' | ...
    LABEL     : str                      # human name for the picker
    fetch(dev)              -> dict      # normalised status (see NORMALISED)
    test(dev)               -> dict      # {ok, message, model?}
    reboot(dev)             -> None      # raises on failure
    set_wifi(dev, band, on) -> None      # band: host_2g|host_5g|guest_2g|guest_5g

`dev` is a mapping with: host, username, password, and optionally port/use_ssl.

NORMALISED status keys (all optional except ok):
    ok, model, firmware, hardware, cpu (0..1), mem (0..1),
    wan_ip, wan_gateway, lan_ip, lan_mac,
    clients_total, wired_total, wifi_clients_total, guest_clients_total,
    wifi_2g, wifi_5g, wireless_clients,
    devices[ {hostname, ip, mac, mac_key, type, wireless, band, signal, down, up} ],
    ipv4{...}, leases[...], reservations[...],
    can_reboot, can_wifi
"""
import re


def norm_mac(m):
    """Canonical MAC key: lowercase hex only — joins across Pi-hole/router/AP."""
    return re.sub(r'[^0-9a-f]', '', str(m or '').lower())


def blank_status(**kw):
    """A normalised status skeleton so every adapter returns the same keys."""
    base = {
        'ok': True, 'model': None, 'firmware': None, 'hardware': None,
        'cpu': None, 'mem': None,
        'wan_ip': None, 'wan_gateway': None, 'lan_ip': None, 'lan_mac': None,
        'clients_total': None, 'wired_total': None,
        'wifi_clients_total': None, 'guest_clients_total': None,
        'wifi_2g': None, 'wifi_5g': None,
        'devices': [], 'wireless_clients': 0,
        'ipv4': None, 'leases': [], 'reservations': [],
        'can_reboot': True, 'can_wifi': True,
    }
    base.update(kw)
    return base


def device(hostname=None, ip=None, mac=None, wireless=False, band=None,
           signal=None, down=None, up=None, kind=None):
    """One client entry in the normalised shape."""
    if ip in ('0.0.0.0', ''):
        ip = None
    return {
        'hostname': hostname or None, 'ip': ip,
        'mac': str(mac or ''), 'mac_key': norm_mac(mac),
        'type': kind or ('wireless' if wireless else 'wired'),
        'wireless': bool(wireless), 'band': band,
        'signal': signal, 'down': down, 'up': up,
    }


def registry():
    """vendor id -> adapter module. Imported lazily so a missing optional
    dependency disables only that vendor instead of the whole sidecar."""
    out = {}
    for mod_name in ('asus', 'openwrt'):
        try:
            mod = __import__(f'vendors.{mod_name}', fromlist=['*'])
            out[mod.VENDOR] = mod
        except Exception:   # noqa: BLE001 — a broken adapter must not kill startup
            continue
    return out
