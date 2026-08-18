'use strict';

// ===========================================================================
//  Core helpers
// ===========================================================================
// Which Pi-hole instance the section-level calls act on. Persisted so a reload
// keeps the operator on the instance they were working with.
let activePh = localStorage.getItem('bh-active-ph') || '';

function phUrl(path) {
  if (!activePh) return `/ph/${path}`;
  return `/ph/${path}${path.includes('?') ? '&' : '?'}ph=${encodeURIComponent(activePh)}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(phUrl(path), opts);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
  return data;
}
const cfgPut = (element, value) => api(`config/${element}/${encodeURIComponent(value)}`, { method: 'PUT' });
const cfgDel = (element, value) => api(`config/${element}/${encodeURIComponent(value)}`, { method: 'DELETE' });
const patchConfig = (obj) => api('config', { method: 'PATCH', body: { config: obj } });

// GET-JSON with in-flight dedupe: identical concurrent requests share one round-trip.
const _inflight = new Map();
function getJson(url) {
  if (_inflight.has(url)) return _inflight.get(url);
  const p = fetch(url).then((r) => r.json()).finally(() => _inflight.delete(url));
  _inflight.set(url, p);
  return p;
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const fmt = (n) => (Number(n) || 0).toLocaleString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms = 160) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 3400);
}
function relTime(epoch) {
  const s = Math.floor(Date.now() / 1000 - epoch);
  if (s < 0) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const clockFmt = (epoch) => new Date(epoch * 1000).toLocaleTimeString([], { hour12: false });
const fmtUptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };

// Themed confirm dialog (replaces native confirm())
function confirmDialog(message, { title = 'Are you sure?', yes = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = message;
    $('#confirmYes').textContent = yes;
    const modal = $('#confirmModal');
    modal.classList.add('show');
    const done = (v) => { modal.classList.remove('show'); yesBtn.removeEventListener('click', onYes); noBtn.removeEventListener('click', onNo); resolve(v); };
    const yesBtn = $('#confirmYes'), noBtn = $('#confirmNo');
    const onYes = () => done(true), onNo = () => done(false);
    yesBtn.addEventListener('click', onYes); noBtn.addEventListener('click', onNo);
  });
}

// Animated number counter (timer fallback so the value always lands, even
// when requestAnimationFrame is throttled in background tabs).
function animateCount(el, to) {
  const from = Number(el.dataset.v || 0); el.dataset.v = to;
  const start = performance.now(), dur = 700;
  let done = false;
  const finish = () => { if (!done) { done = true; el.textContent = Math.round(to).toLocaleString(); } };
  function step(now) {
    if (done) return;
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * e).toLocaleString();
    if (p < 1) requestAnimationFrame(step); else finish();
  }
  requestAnimationFrame(step);
  setTimeout(finish, dur + 120);
}

// ===========================================================================
//  Client identity resolver
//  Priority: admin DHCP static name -> hostname the client shares (lease) ->
//  reverse-DNS -> raw IP/MAC. Router hostnames are merged in when available.
// ===========================================================================
const identity = { byIp: {}, byMac: {}, loaded: 0, promise: null };
async function loadIdentity(force = false) {
  if (!force && identity.loaded && Date.now() - identity.loaded < 60000) return identity;
  // Dedupe concurrent callers so the 3-request batch runs once.
  if (identity.promise) return identity.promise;
  identity.promise = _loadIdentity().finally(() => { identity.promise = null; });
  return identity.promise;
}
async function _loadIdentity() {
  const [leasesR, dhcpR, devR] = await Promise.allSettled([api('dhcp/leases'), api('config/dhcp'), api('network/devices')]);
  const byIp = {}, byMac = {};
  if (leasesR.status === 'fulfilled') (leasesR.value.leases || []).forEach((l) => {
    if (!l.name) return;
    if (l.ip && !byIp[l.ip]) byIp[l.ip] = l.name;
    if (l.hwaddr && !byMac[l.hwaddr.toLowerCase()]) byMac[l.hwaddr.toLowerCase()] = l.name;
  });
  if (devR.status === 'fulfilled') (devR.value.devices || []).forEach((d) => {
    (d.ips || []).forEach((i) => { if (i.name && i.ip && !byIp[i.ip]) byIp[i.ip] = i.name; });
  });
  if (dhcpR.status === 'fulfilled') ((dhcpR.value.config?.dhcp?.hosts) || []).forEach((h) => {
    const [mac, ip, name] = h.split(',');
    if (!name) return;
    if (ip) byIp[ip] = name;
    if (mac) byMac[mac.toLowerCase()] = name;
  });
  identity.byIp = byIp; identity.byMac = byMac; identity.loaded = Date.now();
  return identity;
}
const nameForIp = (ip) => identity.byIp[ip] || ip || '?';
function nameForClientId(id) {
  const low = String(id).toLowerCase();
  return identity.byMac[low] || identity.byIp[id] || id;
}

// ===========================================================================
//  Favicons — letter tile always renders behind; icon fades in when loaded
// ===========================================================================
const regDomain = (d) => { const p = String(d).split('.'); return p.length > 2 ? p.slice(-2).join('.') : d; };
function favicon(domain) {
  const rd = regDomain(domain);
  const letter = ((rd.match(/[a-z0-9]/i) || ['?'])[0]).toUpperCase();
  const hue = [...rd].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  // The letter tile is the whole control now. It previously sat behind an
  // <img> from icons.duckduckgo.com, which meant every row of the Query Log,
  // Domains and Network Map leaked the browsed domain to a third party — and
  // stalled behind a network timeout whenever DNS was the thing being fixed.
  return `<span class="fav" style="--h:${hue}"><i>${esc(letter)}</i></span>`;
}

// ===========================================================================
//  Device icons — inline SVG (24×24), classified from hostname + MAC vendor
// ===========================================================================
const ICONS = {
  phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><line x1="10.5" y1="18.6" x2="13.5" y2="18.6"/>',
  tablet: '<rect x="4" y="2.5" width="16" height="19" rx="2"/><line x1="10.5" y1="18.7" x2="13.5" y2="18.7"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  tv: '<rect x="2.5" y="4" width="19" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>',
  camera: '<path d="M3 8h3l1.5-2h5L14 8h7v11H3z"/><circle cx="12" cy="13" r="3.4"/>',
  printer: '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="8" rx="1.5"/><rect x="7" y="15" width="10" height="6"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><line x1="7" y1="6.5" x2="7.01" y2="6.5"/><line x1="7" y1="17.5" x2="7.01" y2="17.5"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 01-12 0z"/><path d="M12 17v5"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 2a6 6 0 00-3.5 10.9c.6.5.9 1.2.9 1.9V15h5.2v-.2c0-.7.3-1.4.9-1.9A6 6 0 0012 2z"/>',
  watch: '<rect x="7" y="6" width="10" height="12" rx="2.5"/><path d="M9.5 6l.5-4h4l.5 4M9.5 18l.5 4h4l.5-4"/>',
  speaker: '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><circle cx="12" cy="15" r="3.5"/><circle cx="12" cy="7" r="1.4"/>',
  energy: '<path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/>',
  router: '<rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 17h.01M11 17h5"/><path d="M8.5 8.5a5 5 0 017 0M6 6a8.5 8.5 0 0112 0"/>',
  ap: '<circle cx="12" cy="17" r="2.5"/><path d="M8.2 13.6a5.5 5.5 0 017.6 0M5.4 10.6a9.5 9.5 0 0113.2 0"/>',
  shield: '<path d="M12 2.5l8 3v6c0 5-3.4 8.9-8 10-4.6-1.1-8-5-8-10v-6z"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h11"/>',
  percent: '<circle cx="7.5" cy="7.5" r="2.6"/><circle cx="16.5" cy="16.5" r="2.6"/><path d="M18.5 5.5L5.5 18.5"/>',
  bolt: '<path d="M13 2.5L5.5 13.2h5L11 21.5 18.5 10.8h-5z"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 2"/>',

  // --- header (HUD) -------------------------------------------------------
  sun: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.4v2.3M12 19.3v2.3M2.4 12h2.3M19.3 12h2.3M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>',
  moon: '<path d="M20.4 14.9A8.5 8.5 0 019.1 3.6 8.5 8.5 0 1020.4 14.9z"/>',
  power: '<path d="M12 3.4v7.4"/><path d="M7.5 6.6a7.2 7.2 0 109 0"/>',
  refresh: '<path d="M20 12a8 8 0 10-2.6 5.9"/><path d="M20 5.5V12h-6"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h8V4M8 20v-5h8v5"/>',
  radar: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="3.6"/><path d="M12 12l6-4.5"/>',
  device: '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2L21 21"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.8a1 1 0 011-1h3a1 1 0 011 1V7"/><path d="M6.3 7l.9 12.2a1.8 1.8 0 001.8 1.7h6a1.8 1.8 0 001.8-1.7L17.7 7"/><path d="M10.4 11.3v6M13.6 11.3v6"/>',
  globe: '<circle cx="12" cy="12" r="9.2"/><path d="M2.8 12h18.4M12 2.8c2.4 2.5 3.7 5.8 3.7 9.2s-1.3 6.7-3.7 9.2c-2.4-2.5-3.7-5.8-3.7-9.2S9.6 5.3 12 2.8z"/>',
  chip: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21"/>',
};

// Ordered rules — first match wins. Function keywords are checked BEFORE brand
// names, so e.g. "OnePlus-TV-LAN" is a TV rather than a OnePlus phone.
const NAME_RULES = [
  // --- what the device *is*
  [/watch|iwatch|\bband\b|fitbit/i, 'watch'],
  [/ipad|tablet|\btab\b/i, 'tablet'],
  [/\btv\b|roku|firestick|chromecast|appletv|bravia|smarttv|android.?tv/i, 'tv'],
  [/\bcam\d*\b|camera|ipcam|doorbell|\bnvr\b/i, 'camera'],
  [/print|epson|canon|brother|deskjet|laserjet/i, 'printer'],
  [/nas|truenas|synology|unraid|proxmox|server|ubuntu|debian|docker|pihole|\bvm\b/i, 'server'],
  [/switch|plug|socket|relay/i, 'plug'],
  [/bulb|light|lamp/i, 'bulb'],
  [/echo|alexa|speaker|sonos|homepod|nest.?mini/i, 'speaker'],
  [/inverter|solar|meter|energy/i, 'energy'],
  [/router|gateway|archer|deco|\bap\d/i, 'router'],
  [/macbook|laptop|thinkpad|notebook|\bxps\b/i, 'laptop'],
  [/desktop|workstation|imac|\bpc\b/i, 'desktop'],
  // --- brand hints (weaker: only reached if nothing above matched)
  [/iphone|galaxy|pixel|redmi|vivo|oneplus|moto|oppo|realme|nokia|poco|xiaomi|\bm52\b|phone/i, 'phone'],
  [/\bmsi\b|dell|lenovo|asus/i, 'laptop'],
];
const VENDOR_RULES = [
  [/hikvision|dahua|reolink|amcrest/i, 'camera'],
  [/espressif|tuya|sonoff|shelly|itead|tasmota/i, 'plug'],
  [/synology|qnap|seagate|western digital/i, 'server'],
  [/raspberry/i, 'server'],
  [/tp-link|ubiquiti|netgear|d-link|mikrotik/i, 'router'],
  [/sony|lg electronics|vizio|hisense/i, 'tv'],
  [/apple/i, 'phone'],
  [/samsung|vivo mobile|guangdong oppo|xiaomi|huawei/i, 'phone'],
  [/intel|dell|lenovo|asus|micro-star|hewlett/i, 'laptop'],
];

function deviceIconKey(n) {
  if (n.kind === 'pihole') return 'shield';
  if (n.kind === 'ap') return 'ap';
  const name = String(n.name || '');
  for (const [re, key] of NAME_RULES) if (re.test(name)) return key;
  const vendor = String(n.vendor || '');
  for (const [re, key] of VENDOR_RULES) if (re.test(vendor)) return key;
  return n.viaAp ? 'phone' : 'chip'; // wireless-with-no-hints is usually mobile
}
const ICON_LABEL = { phone: 'Phone', tablet: 'Tablet', laptop: 'Laptop', desktop: 'Desktop', tv: 'TV',
  camera: 'Camera', printer: 'Printer', server: 'Server / NAS', plug: 'Smart switch', bulb: 'Smart light',
  watch: 'Wearable', speaker: 'Speaker', energy: 'Energy device', router: 'Router', ap: 'Access point',
  shield: 'Pi-hole', globe: 'Internet', chip: 'Device' };

// SVG <g> centred at (cx,cy), scaled to `size` px
function iconSvg(key, cx, cy, size, color = 'currentColor') {
  const s = size / 24;
  return `<g transform="translate(${(cx - size / 2).toFixed(1)},${(cy - size / 2).toFixed(1)}) scale(${s.toFixed(3)})"
    fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[key] || ICONS.chip}</g>`;
}
// Inline HTML icon (for tables)
function iconHtml(key, size = 15) {
  return `<svg class="dev-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[key] || ICONS.chip}</svg>`;
}

// ===========================================================================
//  Theme (light / dark) — persisted, defaults to the OS preference
// ===========================================================================
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('#themeBtn');
  if (btn) {
    // shows the TARGET state, as before; the innerHTML swap replays the bounce
    btn.querySelector('.hud-ico').dataset.icon = t === 'light' ? 'moon' : 'sun';
    paintHudIcons(btn);
    btn.title = t === 'light' ? 'Switch to dark' : 'Switch to light';
  }
  // canvases read CSS variables, so repaint whatever is on screen
  const active = document.querySelector('.nav-item.active')?.dataset.section;
  if (active === 'overview') { loaders.overview?.(); }
  else if (active === 'gateway') { drawRouterHistory(); }
  else if (active === 'mesh') { loaders.mesh?.(); }
}
function initTheme() {
  const saved = localStorage.getItem('phc-theme');
  // Light is the product's default look. A saved preference still wins, and a
  // user who has explicitly asked their OS for dark still gets dark.
  const t = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('#themeBtn');
  if (btn) {
    btn.querySelector('.hud-ico').dataset.icon = t === 'light' ? 'moon' : 'sun';
    paintHudIcons(btn);
    btn.title = t === 'light' ? 'Switch to dark' : 'Switch to light';
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      localStorage.setItem('phc-theme', next);
      applyTheme(next);
    });
  }
}
const cssVar = (n, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback);

// ===========================================================================
//  Navigation (loaders are guarded: overlapping runs are skipped)
// ===========================================================================
const loaders = {};
function guard(fn) {
  let busy = false;
  return async (...a) => {
    if (busy) return;
    busy = true;
    try { await fn(...a); } catch (e) { console.error(e); } finally { busy = false; }
  };
}
const titles = { profile: 'Your Profile', overview: 'Overview', mesh: 'Network Map', insights: 'Insights', automation: 'Automation', queries: 'Query Log', domains: 'Domains', lists: 'Filter Lists', groups: 'Groups', clients: 'Clients', localdns: 'Local DNS', dhcp: 'DHCP', gateway: 'Gateway', infra: 'Routers & APs', admin: 'Admin', network: 'Network', diagnostics: 'Diagnostics', backup: 'Backup & Restore', settings: 'Settings' };
function activateSection(sec) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.section === sec));
  $$('.section').forEach((s) => s.classList.remove('active'));
  $(`#s-${sec}`)?.classList.add('active');
  $('#sectionTitle').textContent = titles[sec] || sec;
  loaders[sec]?.();
}
$$('.nav-item').forEach((item) => item.addEventListener('click', () => activateSection(item.dataset.section)));

// ===========================================================================
//  Header (HUD)
// ===========================================================================
// index.html carries no inline SVG for the header: ICONS stays the single
// source of path data, and each slot declares its own key and size so the
// markup is self-describing. Idempotent — safe to re-run on one subtree.
// Any element carrying data-icon becomes an SVG slot, so ICONS stays the single
// source of path data and markup stays self-describing. Idempotent.
function paintHudIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((s) => {
    s.innerHTML = iconHtml(s.dataset.icon, Number(s.dataset.size) || 16);
  });
}

// Engine state and poll state both live on ONE attribute on ONE element.
// Deliberately kept OFF #statusDot and #toggleBtn, whose className and
// textContent are reassigned on every 15s poll and would drop anything added.
function hudEngine(state) { $('#hud')?.setAttribute('data-engine', state); }

// Fired when a poll RESOLVES or REJECTS — never on a timer. loadBlocking() runs
// every 15s from every section, so this is the one honest liveness signal
// available without a single new request. remove -> reflow -> set restarts the
// sweep on each tick; without the reflow the animation would only ever play once.
function hudPoll(ok) {
  const h = $('#hud'); if (!h) return;
  h.removeAttribute('data-poll');
  void h.offsetWidth;
  h.dataset.poll = ok ? 'ok' : 'fail';
}

// The try/catch is deliberate: this runs at module level, and one early throw
// here would take every line after it in app.js down with it — which is how a
// typo'd id has broken this app before. A typo now costs four missing icons and
// a console error instead of the whole page.
function initHud() {
  try {
    paintHudIcons();
    const plat = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
    if (/mac|iphone|ipad/i.test(plat)) {
      $('#cmdKey').textContent = '\u2318';
      $('#cmdBtn').setAttribute('aria-keyshortcuts', 'Meta+K');
    }
    $('#cmdBtn').addEventListener('click', cpOpen);   // hoisted decl. at line 2541
  } catch (e) { console.error('HUD init failed', e); }
}

// ===========================================================================
//  Blocking control (with live countdown in the header clock tick)
// ===========================================================================
let blockingState = null;
let blockTimerEnd = null; // ms epoch when blocking auto-resumes

async function loadBlocking() {
  try {
    const d = await api('dns/blocking'); blockingState = d.blocking; renderBlocking(d);
    hudPoll(true);
  } catch {
    // blockTimerEnd MUST be cleared here. Without it, tickClock() keeps writing a
    // stale "resumes Ns" into #blockingSub every second for the rest of the
    // session after an outage, because blockingState retains its last value.
    blockingState = null; blockTimerEnd = null;
    $('#blockingLabel').textContent = 'Offline';
    $('#blockingSub').textContent = 'unreachable';
    $('#statusDot').className = 'status-ring';
    const b = $('#toggleBtn');
    // className reset too, or a stale green .on / red .off toggle sits inside an
    // amber "down" capsule after the first failure.
    b.disabled = true; b.textContent = 'Standby'; b.className = 'btn btn-toggle';
    b.setAttribute('aria-label', 'DNS blocking control, instance unreachable');
    hudEngine('down'); hudPoll(false);
  }
}
function renderBlocking(d) {
  const on = d.blocking === 'enabled';
  blockTimerEnd = d.timer ? Date.now() + d.timer * 1000 : null;
  $('#statusDot').className = `status-ring ${on ? 'on' : 'off'}`;
  $('#blockingLabel').textContent = on ? 'Enabled' : 'Disabled';
  // "resumes in 900s" overflows the fixed 96px state box at the 430px tier;
  // "resumes 900s" always fits, so a countdown can never reflow the bar.
  $('#blockingSub').textContent = d.timer ? `resumes ${Math.round(d.timer)}s` : 'DNS blocking';
  const b = $('#toggleBtn'); b.disabled = false; b.textContent = on ? 'Disable' : 'Enable';
  b.className = `btn btn-toggle ${on ? 'off' : 'on'}`;
  // "Disable" alone announces as a verb with no object — this is the app's
  // primary control. Set in the same function that sets the text so the two
  // cannot desync.
  b.setAttribute('aria-label', on ? 'Disable DNS blocking' : 'Enable DNS blocking');
  // State lives on ONE attribute on the header, deliberately NOT on #statusDot
  // or #toggleBtn, whose className is reassigned on every 15s poll.
  hudEngine(on ? 'on' : 'off');
}
async function setBlocking(enabled, timer = null) {
  try { renderBlocking(await api('dns/blocking', { method: 'POST', body: { blocking: enabled, timer } })); toast(enabled ? 'Blocking enabled' : 'Blocking disabled', 'ok'); }
  catch (e) { toast(`Could not change the DNS blocking state: ${e.message}`, 'err'); }
}
$('#toggleBtn').addEventListener('click', () => {
  if (blockingState === 'enabled') $('#durationModal').classList.add('show'); else setBlocking(true);
});
$$('#durationModal [data-secs]').forEach((b) => b.addEventListener('click', () => {
  const s = Number(b.dataset.secs); $('#durationModal').classList.remove('show'); setBlocking(false, s === 0 ? null : s);
}));
$('#durationCancel').addEventListener('click', () => $('#durationModal').classList.remove('show'));

// ===========================================================================
//  Reusable renderers
// ===========================================================================
function barList(el, items, { red = false } = {}) {
  if (!items.length) { el.innerHTML = '<div class="empty">No data</div>'; return; }
  const max = Math.max(...items.map((i) => i.count), 1);
  el.innerHTML = items.map((i) => `
    <div class="bar-item">
      <div class="bar-row"><span class="name" title="${esc(i.name)}">${esc(i.name)}${i.sub ? ` <span class="sub">${esc(i.sub)}</span>` : ''}</span><span class="val">${fmt(i.count)}</span></div>
      <div class="bar-track"><div class="bar-fill ${red ? 'red' : ''}" style="width:${(i.count / max * 100).toFixed(1)}%"></div></div>
    </div>`).join('');
}
const kv = (rows) => rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v ?? '—'}</div>`).join('');

function gauge(el, pct, name, color, label) {
  pct = Math.max(0, Math.min(100, pct || 0));
  const r = 38, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  el.innerHTML = `<svg width="92" height="92" viewBox="0 0 92 92">
    <circle class="g-track" cx="46" cy="46" r="${r}"/>
    <circle class="g-fill" cx="46" cy="46" r="${r}" stroke="${color}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
  </svg><div class="g-label"><span class="g-val" style="color:${color}">${label}</span><span class="g-name">${name}</span></div>`;
}

const isBlockedStatus = (s) => /GRAVITY|DENY|REGEX|BLACK|BLOCKED|SPECIAL/i.test(String(s));

// ===========================================================================
//  Pi-hole instances — switcher, fleet table and aggregate rollup
// ===========================================================================
let phFleet = null;

async function loadPiholeFleet() {
  try { phFleet = await getJson('/manager/piholes'); }
  catch { phFleet = null; return null; }
  const list = phFleet.instances || [];

  // header switcher only earns its space with more than one instance
  const sel = $('#phSwitch');
  sel.hidden = list.length < 2;
  if (list.length >= 2) {
    if (!list.some((i) => i.id === activePh)) activePh = list[0].id;
    sel.innerHTML = list.map((i) =>
      `<option value="${esc(i.id)}" ${i.id === activePh ? 'selected' : ''}>${esc(i.label)}${i.ok ? '' : ' (offline)'}</option>`).join('');
  }

  const card = $('#phFleetCard');
  card.hidden = list.length < 2;
  if (list.length >= 2) {
    const agg = phFleet.aggregate || {};
    $('#phFleetCount').textContent = `${agg.online}/${agg.instances} online`;
    $('#phFleetAgg').textContent =
      `combined ${fmt(agg.total)} queries · ${fmt(agg.blocked)} blocked · ${(agg.percentBlocked || 0).toFixed(1)}%`;
    $('#phFleetTable tbody').innerHTML = list.map((i) => `<tr>
      <td><b>${esc(i.label)}</b>${i.primary ? ' <span class="pill blue">primary</span>' : ''}${i.id === activePh ? ' <span class="pill green">active</span>' : ''}</td>
      <td class="mono">${esc(i.url)}</td>
      <td>${i.ok ? '<span class="pill green">online</span>' : `<span class="pill red">${esc(i.message || 'unreachable')}</span>`}</td>
      <td>${i.blocking === 'enabled' ? '<span class="pill green">enabled</span>'
        : i.blocking === 'disabled' ? '<span class="pill red">disabled</span>' : '<span class="pill gray">—</span>'}</td>
      <td class="mono num">${i.ok ? fmt(i.total) : '—'}</td>
      <td class="mono num">${i.ok ? fmt(i.blocked) : '—'}</td>
      <td class="mono num">${i.ok ? (i.percentBlocked || 0).toFixed(1) + '%' : '—'}</td>
      <td class="mono num">${i.ok ? fmt(i.activeClients) : '—'}</td>
      <td class="dim">${esc(i.core || '—')}</td></tr>`).join('');
  }
  return phFleet;
}

$('#phSwitch').addEventListener('change', (e) => {
  activePh = e.target.value;
  localStorage.setItem('bh-active-ph', activePh);
  const label = phFleet?.instances?.find((i) => i.id === activePh)?.label || activePh;
  toast(`Switched to ${label}`);
  identity.loaded = 0;                 // names are per-instance
  loadBlocking();
  loaders[document.querySelector('.nav-item.active')?.dataset.section]?.();
});

// ===========================================================================
//  Overview — Pi-hole + router + connectivity fused, all fetched in parallel
// ===========================================================================
async function loadOverview() {
  loadPiholeFleet();     // independent; updates the switcher and fleet card
  const [summaryR, ftlR, gwR, routerR, historyR, typesR, upstreamsR, blockedR, permittedR, clientsR] = await Promise.allSettled([
    api('stats/summary'), api('info/ftl'),
    getJson('/manager/gateway/health'), getJson('/manager/router/status'),
    api('history'), api('stats/query_types'), api('stats/upstreams'),
    api('stats/top_domains?blocked=true&count=8'), api('stats/top_domains?count=8'), api('stats/top_clients?count=8'),
  ]);

  // --- stat tiles
  if (summaryR.status === 'fulfilled') {
    const q = summaryR.value.queries || {};
    animateCount($('#s-total'), q.total || 0);
    animateCount($('#s-blocked'), q.blocked || 0);
    $('#s-pct').textContent = `${(q.percent_blocked ?? 0).toFixed(1)}%`;
    animateCount($('#stat-clients'), summaryR.value.clients?.active ?? 0); // NB: #s-clients is the section
    animateCount($('#s-gravity'), summaryR.value.gravity?.domains_being_blocked ?? 0);
  }
  const ftl = ftlR.status === 'fulfilled' ? ftlR.value.ftl || {} : {};
  // FTL reports uptime in MILLISECONDS (system.uptime is seconds) — 174660317
  // read as seconds rendered as "2021d" instead of ~2 days.
  const ftlUptimeSecs = ftl.uptime ? ftl.uptime / 1000 : null;
  $('#s-uptime').textContent = ftlUptimeSecs ? fmtUptime(ftlUptimeSecs) : '—';
  const router = routerR.status === 'fulfilled' && routerR.value.ok ? routerR.value : null;
  $('#s-routercpu').textContent = router ? `${Math.round((router.cpu || 0) * 100)}%` : '—';
  const gw = gwR.status === 'fulfilled' ? gwR.value : null;
  $('#s-inet').textContent = gw?.internet?.up ? `${gw.internet.latency} ms` : gw ? 'Offline' : '—';

  // --- additional operational metrics
  const dm = ftl.dnsmasq || {};
  const cacheHits = dm.dns_cache_inserted != null
    ? (dm.dns_stale_answered || 0) + (dm.dns_local_answered || 0) : null;
  if (summaryR.status === 'fulfilled') {
    const t = summaryR.value.queries || {};
    const cached = t.cached ?? null;
    const total = t.total || 0;
    $('#s-cachehit').textContent = (cached != null && total)
      ? `${((cached / total) * 100).toFixed(1)}%` : '—';
  }
  $('#s-qps').textContent = ftl.query_frequency != null ? ftl.query_frequency.toFixed(2) : '—';
  if (upstreamsR.status === 'fulfilled') {
    const ups = (upstreamsR.value.upstreams || [])
      .filter((u) => u.statistics?.response > 0 && u.port > 0);
    const avg = ups.length
      ? ups.reduce((a, u) => a + u.statistics.response, 0) / ups.length : null;
    $('#s-upstream').textContent = avg != null ? `${(avg * 1000).toFixed(0)} ms` : '—';
  }
  // weak Wi-Fi clients need AP data; fetched separately so it never blocks
  getJson('/manager/router/aps').then((d) => {
    const weak = (d.aps || []).filter((a) => a.ok)
      .flatMap((a) => (a.devices || []).filter((x) => x.wireless && x.signal != null && x.signal <= -72));
    $('#s-weak').textContent = String(weak.length);
  }).catch(() => { $('#s-weak').textContent = '—'; });

  // --- infrastructure strip
  $('#ov-pihole-badge').innerHTML = summaryR.status === 'fulfilled' ? '<span class="pill green">online</span>' : '<span class="pill red">offline</span>';
  $('#ov-pihole').innerHTML = kv([
    ['DNS uptime', ftlUptimeSecs ? fmtUptime(ftlUptimeSecs) : '—'],
    ['Query rate', `${(ftl.query_frequency ?? 0).toFixed(2)} queries/s`],
    ['Gravity domains', fmt(ftl.database?.gravity)],
    ['Lists / Groups', `${fmt(ftl.database?.lists)} / ${fmt(ftl.database?.groups)}`],
    ['Privacy level', ftl.privacy_level ?? '—'],
  ]);
  $('#ov-router-badge').innerHTML = router ? '<span class="pill green">connected</span>' : '<span class="pill gray">n/a</span>';
  $('#ov-router').innerHTML = router ? kv([
    ['Model', esc(router.model || '—')],
    ['CPU / RAM', `${Math.round((router.cpu || 0) * 100)}% / ${Math.round((router.mem || 0) * 100)}%`],
    ['WAN IP', `<span class="mono">${esc(router.wan_ip || '—')}</span>`],
    ['Wi-Fi', `${router.wifi_2g ? '2.4G ✓' : '2.4G ✕'} · ${router.wifi_5g ? '5G ✓' : '5G ✕'}`],
    ['Clients (router)', fmt(router.clients_total)],
  ]) : kv([['Status', 'Deep integration not configured']]);
  $('#ov-net-badge').innerHTML = gw?.internet?.up ? '<span class="pill green">online</span>' : '<span class="pill red">check</span>';
  $('#ov-net').innerHTML = gw ? kv([
    ['Gateway', gw.gateway?.up ? `${gw.gateway.latency} ms · jitter ${gw.gateway.jitter} ms` : '<span class="pill red">down</span>'],
    ['Internet', gw.internet?.up ? `${gw.internet.latency} ms · jitter ${gw.internet.jitter} ms` : '<span class="pill red">down</span>'],
    ['Packet loss', `${gw.internet?.loss ?? '—'}%`],
    ['Probe target', esc(gw.internet?.target || '—')],
  ]) : kv([['Status', 'unavailable']]);

  // --- charts & lists
  if (historyR.status === 'fulfilled') { drawHistory(historyR.value); initHistoryHover(); }
  if (typesR.status === 'fulfilled') drawDonut(typesR.value);
  if (upstreamsR.status === 'fulfilled') {
    const items = (upstreamsR.value.upstreams || []).map((u) => ({
      name: u.name || u.ip, count: u.count,
      sub: u.statistics?.response ? `${(u.statistics.response * 1000).toFixed(0)}ms` : '',
    })).sort((a, b) => b.count - a.count);
    barList($('#upstreams'), items);
  }
  if (blockedR.status === 'fulfilled') barList($('#topBlocked'), (blockedR.value.domains || []).map((x) => ({ name: x.domain, count: x.count })), { red: true });
  if (permittedR.status === 'fulfilled') barList($('#topPermitted'), (permittedR.value.domains || []).map((x) => ({ name: x.domain, count: x.count })));
  loadIdentity().then(() => {
    if (clientsR.status === 'fulfilled') barList($('#topClients'), (clientsR.value.clients || []).map((x) => ({ name: nameForIp(x.ip), sub: nameForIp(x.ip) !== x.ip ? x.ip : '', count: x.count })));
  }).catch(() => {});
  loadSystemWidget();
}

async function loadSystemWidget() {
  try {
    const [sysR, sensR] = await Promise.allSettled([api('info/system'), api('info/sensors')]);
    if (sysR.status !== 'fulfilled') return;
    const sys = sysR.value.system || {};
    const cpu = sys.cpu?.['%cpu'] ?? 0, ram = sys.memory?.ram?.['%used'] ?? 0;
    gauge($('#g-cpu'), cpu, 'CPU', 'var(--cyan)', `${cpu.toFixed(0)}%`);
    gauge($('#g-ram'), ram, 'RAM', 'var(--violet)', `${ram.toFixed(0)}%`);
    const temp = sensR.status === 'fulfilled' ? (sensR.value.sensors?.cpu_temp ?? 0) : 0;
    gauge($('#g-temp'), Math.min(100, temp), 'TEMP', temp > 75 ? 'var(--red)' : 'var(--green)', `${temp.toFixed(0)}°`);
    $('#uptimeLabel').textContent = `up ${fmtUptime(sys.uptime)}`;
    $('#sysMini').innerHTML = kv([
      ['Load (1m)', `${(sys.cpu?.load?.percent?.[0] ?? 0).toFixed(1)}%`],
      ['Processes', sys.procs], ['Cores', sys.cpu?.nprocs],
      ['RAM free', `${((sys.memory?.ram?.available || 0) / 1024).toFixed(0)} MB`],
    ]);
  } catch {}
}

// Shared canvas setup: size the backing store to the CSS box * DPR so lines
// are crisp and the drawing code can work in CSS pixels.
function prepCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth));
  const h = Math.max(1, Math.round(cv.clientHeight));
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const compactNum = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
};
// "nice" axis maximum so gridlines land on round numbers
function niceMax(v) {
  if (v <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}

let historyState = null;   // kept for the hover readout

function drawHistory(data) {
  const cv = $('#historyChart');
  if (!cv) return;
  const hist = (data.history || []).filter((p) => p && p.timestamp);
  const { ctx, w, h } = prepCanvas(cv);
  const dim = cssVar('--muted', '#8090b5');
  const grid = cssVar('--grid', 'rgba(120,160,255,0.10)');

  if (hist.length < 2) {
    ctx.fillStyle = dim; ctx.font = '12px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No query history available yet', w / 2, h / 2);
    historyState = null;
    return;
  }

  const padL = 46, padR = 10, padT = 12, padB = 24;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const totals = hist.map((p) => p.total || 0);
  const blocked = hist.map((p) => p.blocked || 0);
  const max = niceMax(Math.max(...totals, 1));
  const X = (i) => padL + (plotW * i) / (hist.length - 1);
  const Y = (v) => padT + plotH * (1 - v / max);

  // ---- gridlines + y labels
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  ctx.fillStyle = dim; ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(compactNum(v), padL - 8, y + 3);
  }

  // ---- x labels every ~4 hours
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(hist.length / 6));
  for (let i = 0; i < hist.length; i += step) {
    const t = new Date(hist[i].timestamp * 1000);
    ctx.fillText(`${String(t.getHours()).padStart(2, '0')}:00`, X(i), h - 8);
  }

  // ---- filled series
  const series = (vals, hex, fill = true) => {
    if (fill) {
      const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      g.addColorStop(0, hex + '4d'); g.addColorStop(1, hex + '05');
      ctx.beginPath(); ctx.moveTo(X(0), padT + plotH);
      vals.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
      ctx.lineTo(X(vals.length - 1), padT + plotH); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
    }
    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = hex; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.stroke();
  };
  series(totals, cssVar('--cyan', '#22d3ee'));
  series(blocked, cssVar('--red', '#ff5c7a'));

  historyState = { hist, X, Y, padL, padR, padT, plotH, plotW, w, h,
    colors: { total: cssVar('--cyan', '#22d3ee'), blocked: cssVar('--red', '#ff5c7a'),
      allowed: cssVar('--green', '#34e5b0') } };
}

// Hover readout: nearest bucket, with allowed derived from total - blocked.
function initHistoryHover() {
  const cv = $('#historyChart'), tip = $('#historyTip');
  if (!cv || !tip || cv.dataset.hoverWired) return;
  cv.dataset.hoverWired = '1';
  cv.addEventListener('mousemove', (e) => {
    if (!historyState) return;
    const st = historyState;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const frac = (x - st.padL) / Math.max(1, st.plotW);
    const i = Math.max(0, Math.min(st.hist.length - 1, Math.round(frac * (st.hist.length - 1))));
    const p = st.hist[i];
    const total = p.total || 0, blk = p.blocked || 0;
    const t = new Date(p.timestamp * 1000);
    tip.style.display = 'block';
    tip.innerHTML = `<div class="ct-t">${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
      <div><span class="sw" style="background:${st.colors.total}"></span><b>${fmt(total)}</b> total</div>
      <div><span class="sw" style="background:${st.colors.blocked}"></span><b>${fmt(blk)}</b> blocked${total ? ` · ${((blk / total) * 100).toFixed(1)}%` : ''}</div>
      <div><span class="sw" style="background:${st.colors.allowed}"></span><b>${fmt(total - blk)}</b> allowed</div>`;
    const tw = tip.offsetWidth || 150;
    tip.style.left = `${Math.max(0, Math.min(st.X(i) - tw / 2, st.w - tw))}px`;
    tip.style.top = '6px';
  });
  cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

const TYPE_COLORS = ['#22d3ee', '#a78bfa', '#4f8bff', '#34e5b0', '#ffb547', '#ff5c7a', '#7788ad', '#f0f'];
function drawDonut(data) {
  const types = data.types || {};
  const entries = Object.entries(types).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const cv = $('#typesDonut'), ctx = cv.getContext('2d'); ctx.clearRect(0, 0, 160, 160);
  let ang = -Math.PI / 2;
  entries.forEach(([, v], i) => {
    const slice = (v / total) * 2 * Math.PI;
    ctx.beginPath(); ctx.moveTo(80, 80); ctx.arc(80, 80, 70, ang, ang + slice); ctx.closePath();
    ctx.fillStyle = TYPE_COLORS[i % TYPE_COLORS.length]; ctx.fill(); ang += slice;
  });
  ctx.globalCompositeOperation = 'destination-out'; ctx.beginPath(); ctx.arc(80, 80, 42, 0, 2 * Math.PI); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  $('#typesLegend').innerHTML = entries.map(([k, v], i) =>
    `<div class="dl"><span><i style="background:${TYPE_COLORS[i % TYPE_COLORS.length]}"></i>${esc(k)}</span><span class="v">${((v / total) * 100).toFixed(0)}%</span></div>`).join('');
}

// ===========================================================================
//  Network mesh — real-time topology of the whole LAN
// ===========================================================================
let meshNodes = [];
const fmtDur = (secs) => {
  if (!secs || secs < 0) return '—';
  const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
// Home networks cache DNS aggressively, so a 5-minute window would read "0
// active" most of the time. 15 min / 2 h are the useful buckets here.
const ACTIVE_WINDOW = 900, IDLE_WINDOW = 7200;
const activityClass = (n) => {
  const now = Date.now() / 1000;
  if (n.lastQuery && now - n.lastQuery < ACTIVE_WINDOW) return 'active';
  if ((n.lastQuery && now - n.lastQuery < IDLE_WINDOW) || n.recentlySeen) return 'idle';
  return 'stale';
};

async function loadMesh() {
  $('#meshUpdated').textContent = 'scanning…';
  let d;
  try { d = await getJson('/manager/mesh'); if (!d.ok) throw new Error(d.message || 'mesh unavailable'); }
  catch (e) { toast(`Could not build the network map: ${e.message}`, 'err'); $('#meshUpdated').textContent = 'error'; return; }
  meshNodes = d.nodes || [];
  renderMeshStats(d);
  renderMeshSvg(d);
  renderWifiHealth(d);
  renderRoaming(d);
  renderMeshTable();
  $('#meshUpdated').textContent = new Date().toLocaleTimeString([], { hour12: false });
  $('#meshCount').textContent = meshNodes.length;
}

function renderMeshStats(d) {
  const now = Date.now() / 1000;
  const activeNow = meshNodes.filter((n) => activityClass(n) === 'active').length;
  const online = meshNodes.filter((n) => n.recentlySeen).length;
  const probed = meshNodes.filter((n) => n.latency != null);
  const avgLat = probed.length ? (probed.reduce((a, n) => a + n.latency, 0) / probed.length).toFixed(1) : null;
  const newest = meshNodes.reduce((m, n) => Math.max(m, n.lastQuery || 0), 0);
  const aps = (d.aps || []).filter((a) => a.ok);
  const wifiCount = meshNodes.filter((n) => n.viaAp).length;
  const apSub = aps.length
    ? aps.map((a) => `${a.label.replace(/^Archer\s*/i, '')} ${meshNodes.filter((n) => n.viaAp === a.id).length}`).join(' · ')
    : 'no APs configured';
  $('#meshStats').innerHTML = [
    { cls: 'hot', label: 'Devices Mapped', value: fmt(meshNodes.length), sub: `${online} seen in last hour` },
    { cls: activeNow ? 'good' : 'warn', label: 'Recently Active', value: fmt(activeNow), sub: newest ? `newest query ${relTime(newest)}` : 'no recent DNS activity' },
    { cls: 'good', label: 'On Wi-Fi (via APs)', value: fmt(wifiCount), sub: apSub },
    { cls: d.internet?.up ? 'good' : 'bad', label: 'Internet', value: d.internet?.up ? `${d.internet.latency} ms` : 'down', sub: avgLat ? `LAN avg ${avgLat} ms (${probed.length} probed)` : 'LAN probes: none replied' },
  ].map((c) => `<div class="insight-card ${c.cls}"><div class="ic-label">${c.label}</div><div class="ic-value">${c.value}</div><div class="ic-sub">${esc(c.sub)}</div></div>`).join('');

  // AP status strip
  const strip = $('#apStrip');
  if (!strip) return;
  const all = d.aps || [];
  strip.innerHTML = all.length ? all.map((a) => {
    const kids = meshNodes.filter((n) => n.viaAp === a.id).length;
    return `<div class="ap-card ${a.ok ? '' : 'down'}">
      <div class="ap-head"><b>📶 ${esc(a.label)}</b>${a.ok ? '<span class="pill green">online</span>' : `<span class="pill red">${esc(a.message || 'offline')}</span>`}</div>
      <div class="ap-body mono">${esc(a.ip)}${a.model ? ' · ' + esc(a.model) : ''}</div>
      <div class="ap-meta">
        <span>${a.wifi_2g ? '<span class="pill blue">2.4 GHz</span>' : ''} ${a.wifi_5g ? '<span class="pill violet">5 GHz</span>' : ''}</span>
        <span class="mono dim">${kids} client${kids === 1 ? '' : 's'}${a.latency != null ? ` · ${a.latency} ms` : ''}${a.cpu != null ? ` · cpu ${Math.round(a.cpu * 100)}%` : ''}</span>
      </div></div>`;
  }).join('') : '';
}

// True 3-tier topology: Internet → Router → (APs) → devices.
// Nodes are transform-positioned inside a pan/zoom viewport so they can be
// dragged; custom positions persist in localStorage.
// ---------------------------------------------------------------------------
const MESH_W = 1000, MESH_H = 660;
const meshView = { k: 1, tx: 0, ty: 0 };          // pan/zoom of the viewport group
let meshVB = { x: 0, y: 0, w: MESH_W, h: MESH_H }; // fitted viewBox
let meshCustom = {};                               // id -> {x,y} user-placed
let meshPos = {};                                  // id -> {x,y,r} current layout
let meshLinks = [];                                // {a,b,cls,apid}
let meshBusy = false;                              // user is panning/dragging → skip auto-refresh
let meshDragging = false;
const MESH_LS = 'phc-mesh-layout';
const MESH_MODE_LS = 'phc-mesh-mode';
let meshMode = localStorage.getItem(MESH_MODE_LS) || 'auto';   // 'auto' | 'tiers'

// A node's footprint is its circle PLUS the label underneath, otherwise names
// overlap even when the circles don't.
function collisionRadius(r, label) {
  const labelW = String(label || '').length * 5.6;
  return Math.max(r + 30, labelW / 2 + 12);
}

// Fruchterman–Reingold with a light tier bias, then hard separation passes.
// Deterministic (no RNG) so the map doesn't jump around between refreshes.
function forceLayout(nodes, links, { iters = 340, tierPull = 0.14, gravity = 0.075 } = {}) {
  const n = nodes.length;
  if (!n) return;
  const byId = {};
  nodes.forEach((nd) => { byId[nd.id] = nd; });
  // Ideal separation. Plain Fruchterman–Reingold repulsion is long-range (k²/d)
  // and blows the graph out to thousands of units, so it is damped, cut off
  // beyond CUTOFF, and balanced by centering gravity.
  const k = Math.sqrt((MESH_W * MESH_H) / n) * 0.55;
  const CUTOFF = k * 2.4;
  const cx = MESH_W / 2, cy = MESH_H / 2;
  let temp = MESH_W / 7;

  for (let it = 0; it < iters; it++) {
    nodes.forEach((nd) => { nd.dx = 0; nd.dy = 0; });
    // repulsion (O(n²) — fine well past 100 nodes)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d = Math.hypot(dx, dy) || 0.01;
        const minD = a.collR + b.collR;
        if (d > CUTOFF && d > minD) continue;    // ignore far pairs → compact graph
        let f = (k * k) / d;
        if (d < minD) f += (minD - d) * 3;       // firm shove out of overlap
        const ux = dx / d, uy = dy / d;
        a.dx += ux * f; a.dy += uy * f;
        b.dx -= ux * f; b.dy -= uy * f;
      }
    }
    // spring attraction along links
    for (const l of links) {
      const a = byId[l.a], b = byId[l.b];
      if (!a || !b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const ideal = l.dist || k;
      const f = (d * d) / (ideal * 3.2);
      const ux = dx / d, uy = dy / d;
      a.dx -= ux * f; a.dy -= uy * f;
      b.dx += ux * f; b.dy += uy * f;
    }
    // keep the hierarchy readable: gentle pull toward each node's tier row
    for (const nd of nodes) if (nd.tierY != null) nd.dy += (nd.tierY - nd.y) * tierPull;
    // centering gravity stops the graph drifting apart indefinitely
    for (const nd of nodes) { nd.dx += (cx - nd.x) * gravity; nd.dy += (cy - nd.y) * gravity; }

    for (const nd of nodes) {
      if (nd.fixed) continue;
      const d = Math.hypot(nd.dx, nd.dy) || 0.01;
      const lim = Math.min(d, temp);
      nd.x += (nd.dx / d) * lim;
      nd.y += (nd.dy / d) * lim;
    }
    temp *= 0.976;
  }
  separate(nodes, 60);
}

// Hard de-overlap: push any pair whose footprints still intersect.
function separate(nodes, passes = 60) {
  const n = nodes.length;
  for (let p = 0; p < passes; p++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy) || 0.01;
        const minD = a.collR + b.collR;
        if (d >= minD) continue;
        moved = true;
        const push = (minD - d) / 2;
        const ux = dx / d, uy = dy / d;
        if (!a.fixed) { a.x -= ux * push; a.y -= uy * push; }
        if (!b.fixed) { b.x += ux * push; b.y += uy * push; }
        if (a.fixed && !b.fixed) { b.x += ux * push; b.y += uy * push; }
        if (b.fixed && !a.fixed) { a.x -= ux * push; a.y -= uy * push; }
      }
    }
    if (!moved) break;
  }
}

try { meshCustom = JSON.parse(localStorage.getItem(MESH_LS) || '{}'); } catch { meshCustom = {}; }
const saveLayout = debounce(() => {
  try { localStorage.setItem(MESH_LS, JSON.stringify(meshCustom)); } catch {}
}, 400);

function applyMeshView() {
  const vp = $('#meshViewport');
  if (vp) vp.setAttribute('transform', `translate(${meshView.tx.toFixed(2)},${meshView.ty.toFixed(2)}) scale(${meshView.k.toFixed(4)})`);
  const z = $('#meshZoomLabel');
  if (z) z.textContent = `${Math.round(meshView.k * 100)}%`;
}

// Bezier between two nodes, trimmed to each node's radius so lines don't
// disappear under the circles.
function linkPath(aId, bId) {
  const a = meshPos[aId], b = meshPos[bId];
  if (!a || !b) return '';
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const x1 = a.x + ux * (a.r + 2), y1 = a.y + uy * (a.r + 2);
  const x2 = b.x - ux * (b.r + 2), y2 = b.y - uy * (b.r + 2);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const bow = Math.min(26, len * 0.13);
  return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${(mx - uy * bow).toFixed(1)},${(my + ux * bow).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

function refreshLinksFor(id) {
  const svg = $('#meshSvg');
  meshLinks.forEach((l, i) => {
    if (l.a !== id && l.b !== id) return;
    svg.querySelector(`[data-lid="${i}"]`)?.setAttribute('d', linkPath(l.a, l.b));
  });
}

function renderMeshSvg(d) {
  const svg = $('#meshSvg');
  svg.setAttribute('viewBox', `0 0 ${MESH_W} ${MESH_H}`);

  const aps = (d.aps || []).filter((a) => a.ok);
  const leaves = meshNodes.filter((n) => n.kind === 'device');

  const byAp = new Map(aps.map((a) => [a.id, []]));
  const routerKids = [];
  leaves.forEach((n) => (n.viaAp && byAp.has(n.viaAp) ? byAp.get(n.viaAp) : routerKids).push(n));

  // ---------- build the node set (radius + label-aware footprint) ----------
  const sim = [];
  const add = (id, x, y, r, label, tierY) => {
    const nd = { id, x, y, r, collR: collisionRadius(r, label), tierY };
    if (meshCustom[id]) { nd.x = meshCustom[id].x; nd.y = meshCustom[id].y; nd.fixed = true; }
    sim.push(nd);
    return nd;
  };
  const leafR = (k) => 11 + Math.min(11, Math.log2((k.numQueries || 0) + 1) * 1.3);

  add('internet', MESH_W / 2, 70, 22, 'Internet', 70);
  add('router', MESH_W / 2, 215, 27, String(d.gateway?.model || 'Router'), 215);
  add('pihole', 150, 215, 24, 'Pi-hole', 215);

  const apSlot = MESH_W / (aps.length + 1);
  aps.forEach((a, i) => add(a.id, apSlot * (i + 1), 415, 22, `${a.ip} · 2.4G+5G · 9 clients`, 415));

  // seed leaves on an arc under their parent so the simulation starts sane
  const seedFan = (kids, hubId, radius, spread, base, tierY) => {
    const hub = sim.find((s) => s.id === hubId) || { x: MESH_W / 2, y: 300 };
    kids.forEach((kd, i) => {
      const t = kids.length === 1 ? 0.5 : i / (kids.length - 1);
      const ang = ((base - spread / 2 + t * spread) * Math.PI) / 180;
      add(kd.id, hub.x + radius * Math.cos(ang), hub.y + radius * Math.sin(ang),
        leafR(kd), kd.name || kd.ip, tierY);
    });
  };
  seedFan(routerKids, 'router', 250, 170, 90, 330);
  aps.forEach((a) => seedFan(byAp.get(a.id) || [], a.id, 190, 170, 90, 580));

  // ---------- run the layout ----------
  const simLinks = [];
  const pushLink = (a, b, dist) => simLinks.push({ a, b, dist });
  pushLink('router', 'internet', 150);
  pushLink('router', 'pihole', 170);
  aps.forEach((a) => {
    pushLink('router', a.id, 210);
    (byAp.get(a.id) || []).forEach((kd) => pushLink(a.id, kd.id, 165));
  });
  routerKids.forEach((kd) => pushLink('router', kd.id, 230));

  if (meshMode === 'auto') {
    forceLayout(sim, simLinks);
  } else {
    // tier mode keeps the hierarchy but still de-overlaps everything
    separate(sim, 80);
  }

  meshPos = {};
  sim.forEach((nd) => { meshPos[nd.id] = { x: nd.x, y: nd.y, r: nd.r }; });

  // ---------- fit the viewBox to the laid-out graph ----------
  const pad = 60;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  sim.forEach((nd) => {
    minX = Math.min(minX, nd.x - nd.collR); maxX = Math.max(maxX, nd.x + nd.collR);
    minY = Math.min(minY, nd.y - nd.r - 46); maxY = Math.max(maxY, nd.y + nd.r + 40);
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = MESH_W; maxY = MESH_H; }
  meshVB = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
  svg.setAttribute('viewBox', `${meshVB.x.toFixed(0)} ${meshVB.y.toFixed(0)} ${meshVB.w.toFixed(0)} ${meshVB.h.toFixed(0)}`);

  // ---------- links ----------
  meshLinks = [];
  meshLinks.push({ a: 'router', b: 'internet', cls: d.internet?.up ? 'trunk' : 'trunk-down' });
  meshLinks.push({ a: 'router', b: 'pihole', cls: d.pihole?.up ? 'trunk' : 'trunk-down' });
  aps.forEach((a) => {
    meshLinks.push({ a: 'router', b: a.id, cls: 'trunk', apid: a.id });
    (byAp.get(a.id) || []).forEach((k) => meshLinks.push({
      a: a.id, b: k.id, apid: a.id,
      cls: `${k.band === '5G' ? 'band5' : 'band24'} ${activityClass(k) === 'active' ? 'active' : ''}`,
    }));
  });
  routerKids.forEach((k) => meshLinks.push({
    a: 'router', b: k.id,
    cls: `${k.direct ? 'direct' : 'indirect'} ${activityClass(k) === 'active' ? 'active' : ''}`,
  }));

  const linkSvg = meshLinks.map((l, i) =>
    `<path class="mlink ${l.cls}" data-lid="${i}"${l.apid ? ` data-apid="${l.apid}"` : ''} d="${linkPath(l.a, l.b)}"/>`).join('');

  // ---------- nodes (all contents relative to 0,0) ----------
  const at = (id) => `translate(${meshPos[id].x.toFixed(1)},${meshPos[id].y.toFixed(1)})`;
  const nodeSvg = [];

  nodeSvg.push(`<g class="mnode ${d.internet?.up ? 'hub' : 'hub hub-down'}" data-id="internet" transform="${at('internet')}">
    <circle class="body" r="22"/>${iconSvg('globe', 0, 0, 22, 'var(--green)')}
    <text class="mlabel" y="-32">Internet</text>
    <text class="msub" y="-19">${d.internet?.up ? d.internet.latency + ' ms' : 'down'}</text></g>`);

  nodeSvg.push(`<g class="mnode ${d.gateway?.up ? 'hub' : 'hub hub-down'}" data-id="router" transform="${at('router')}">
    ${d.gateway?.up ? '<circle class="pulse-ring" r="27"/>' : ''}
    <circle class="body" r="27"/>${iconSvg('router', 0, 0, 26, 'var(--green)')}
    <text class="mlabel" x="46" y="-4" style="text-anchor:start">${esc(d.gateway?.model || 'Router')}</text>
    <text class="msub" x="46" y="9" style="text-anchor:start">${esc(d.gateway?.host || '')}${d.gateway?.cpu != null ? ' · cpu ' + Math.round(d.gateway.cpu * 100) + '%' : ''}</text></g>`);

  nodeSvg.push(`<g class="mnode pihole" data-id="pihole" data-pihole="1" transform="${at('pihole')}">
    ${d.pihole?.up ? '<circle class="pulse-ring" r="24"/>' : ''}
    <circle class="body" r="24"/>${iconSvg('shield', 0, 0, 23, 'var(--cyan)')}
    <text class="mlabel" y="-34">Pi-hole</text>
    <text class="msub" y="-21">${esc(d.pihole?.host || '')}${d.pihole?.up ? ' · ' + d.pihole.latency + ' ms' : ''}</text></g>`);

  aps.forEach((a, i) => {
    const kids = (byAp.get(a.id) || []).length;
    const bands = [a.wifi_2g ? '2.4G' : null, a.wifi_5g ? '5G' : null].filter(Boolean).join('+');
    nodeSvg.push(`<g class="mnode ap" data-id="${a.id}" data-ap="${i}" data-apid="${a.id}" transform="${at(a.id)}">
      <circle class="pulse-ring" r="22"/><circle class="body" r="22"/>${iconSvg('ap', 0, 0, 22, 'var(--amber)')}
      <text class="mlabel" y="-32">${esc(a.label)}</text>
      <text class="msub" y="-19">${esc(a.ip)} · ${bands || 'radios off'} · ${kids} client${kids === 1 ? '' : 's'}</text></g>`);
  });

  leaves.forEach((n) => {
    const p = meshPos[n.id];
    if (!p) return;
    const cls = activityClass(n);
    const col = cls === 'active' ? 'var(--cyan)' : cls === 'idle' ? 'var(--violet)' : 'var(--muted)';
    const sub = n.signal != null ? `${n.signal} dBm` : (n.latency != null ? `${n.latency} ms` : (n.ip || ''));
    nodeSvg.push(`<g class="mnode ${cls}" data-id="${n.id}" data-i="${meshNodes.indexOf(n)}"${n.viaAp ? ` data-apid="${n.viaAp}"` : ''} transform="${at(n.id)}">
      ${cls === 'active' ? `<circle class="pulse-ring" r="${p.r}"/>` : ''}
      <circle class="body" r="${p.r}"/>${iconSvg(deviceIconKey(n), 0, 0, p.r * 1.15, col)}
      <text class="mlabel" y="${(p.r + 14).toFixed(1)}">${esc((n.name || n.ip || '?').slice(0, 15))}</text>
      <text class="msub" y="${(p.r + 26).toFixed(1)}">${esc(sub)}</text></g>`);
  });

  svg.innerHTML = `<g id="meshViewport">${linkSvg}${nodeSvg.join('')}</g>`;
  applyMeshView();
  initMeshCanvas();              // one-time pan/zoom wiring
  wireMeshInteractions(d, aps);  // per-render node wiring

  const present = [...new Set(leaves.map(deviceIconKey))].sort();
  $('#meshLegend').innerHTML = present.map((k) =>
    `<span class="lg-ico">${iconHtml(k, 13)}${esc(ICON_LABEL[k] || k)}</span>`).join('');
}

// ---------------------------------------------------------------------------
//  Mesh interactions: tooltip, drag-to-reposition, pan, zoom
// ---------------------------------------------------------------------------
function wireMeshInteractions(d, aps) {
  const svg = $('#meshSvg'), vp = $('#meshViewport');
  const tip = $('#meshTip'), wrap = $('#meshWrap');

  // screen point -> viewport-local coords (handles viewBox scaling AND zoom)
  const toLocal = (ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    return pt.matrixTransform(vp.getScreenCTM().inverse());
  };

  const showTip = (e, html) => {
    const wr = wrap.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = Math.max(4, Math.min(e.clientX - wr.left + 16, wr.width - 275)) + 'px';
    tip.style.top = (e.clientY - wr.top + 14) + 'px';
    tip.innerHTML = html;
  };
  const hideTip = () => { tip.style.display = 'none'; };

  // ---------- hover focus ----------
  const setFocus = (apId) => {
    svg.classList.toggle('focused', !!apId);
    svg.querySelectorAll('[data-apid]').forEach((el) => el.classList.toggle('lit', el.dataset.apid === apId));
  };

  // ---------- node drag ----------
  let drag = null;
  svg.querySelectorAll('.mnode').forEach((g) => {
    const id = g.dataset.id;
    g.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();               // don't start a pan
      const p = toLocal(ev);
      drag = { id, g, dx: p.x - meshPos[id].x, dy: p.y - meshPos[id].y, moved: false };
      meshDragging = true; meshBusy = true;
      // pointer capture can throw on a stale/synthetic id — never let that
      // abort the drag (it would also skip the save on release)
      try { g.setPointerCapture(ev.pointerId); } catch {}
      g.classList.add('dragging');
      hideTip();
    });
    g.addEventListener('pointermove', (ev) => {
      if (!drag || drag.id !== id) return;
      const p = toLocal(ev);
      const nx = p.x - drag.dx, ny = p.y - drag.dy;
      if (Math.abs(nx - meshPos[id].x) > 1.5 || Math.abs(ny - meshPos[id].y) > 1.5) drag.moved = true;
      meshPos[id].x = nx; meshPos[id].y = ny;
      g.setAttribute('transform', `translate(${nx.toFixed(1)},${ny.toFixed(1)})`);
      refreshLinksFor(id);
    });
    const endDrag = (ev) => {
      if (!drag || drag.id !== id) return;
      try { g.releasePointerCapture?.(ev.pointerId); } catch {}
      g.classList.remove('dragging');
      if (drag.moved) {
        meshCustom[id] = { x: meshPos[id].x, y: meshPos[id].y };
        saveLayout();
        $('#meshResetLayout').classList.add('has-custom');
      }
      const wasMoved = drag.moved;
      drag = null; meshDragging = false; meshBusy = false;
      if (wasMoved) ev.stopPropagation();   // suppress the click that follows a drag
    };
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);
  });

  // ---------- tooltips + clicks (skipped right after a drag) ----------
  svg.querySelectorAll('.mnode[data-i]').forEach((g) => {
    const n = meshNodes[Number(g.dataset.i)];
    if (!n) return;
    g.addEventListener('mousemove', (e) => {
      if (drag) return;
      showTip(e, `<b>${esc(n.name || 'Unknown device')}</b><br>
        <span class="mono">${esc(n.ip)}${n.ips && n.ips.length > 1 ? ` (+${n.ips.length - 1})` : ''} · ${esc(n.mac || '')}</span><br>
        ${n.vendor ? esc(n.vendor) + '<br>' : ''}
        ${esc(ICON_LABEL[deviceIconKey(n)] || 'Device')} · Path: ${n.viaAp ? `Wi-Fi <b>${esc(n.band || '')}</b> via <b>${esc(n.viaApLabel)}</b>` : n.direct ? 'wired, direct to router' : 'via switch'}<br>
        ${n.signal != null ? `Signal <b>${n.signal} dBm</b> · ` : ''}${n.latency != null ? `Latency <b>${n.latency} ms</b>` : 'latency —'}<br>
        Connected for ${fmtDur(Date.now() / 1000 - (n.firstSeen || Date.now() / 1000))} · last active ${n.lastQuery ? relTime(n.lastQuery) : '—'}<br>
        ${fmt(n.numQueries)} DNS queries · drag to move · click to inspect`);
    });
    g.addEventListener('mouseenter', () => { if (!drag && g.dataset.apid) setFocus(g.dataset.apid); });
    g.addEventListener('mouseleave', () => { hideTip(); setFocus(null); });
    g.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      activateSection('queries'); $('#queryFilter').value = n.ip; loadQueries();
    });
  });

  svg.querySelectorAll('.mnode[data-ap]').forEach((g) => {
    const a = aps[Number(g.dataset.ap)];
    if (!a) return;
    g.addEventListener('mouseenter', () => { if (!drag) setFocus(a.id); });
    g.addEventListener('mouseleave', () => { hideTip(); setFocus(null); });
    g.addEventListener('mousemove', (e) => {
      if (drag) return;
      showTip(e, `<b>${esc(a.label)}</b><br>
        <span class="mono">${esc(a.ip)}</span> · ${esc(a.model || '')}<br>
        ${a.firmware ? esc(String(a.firmware).split(' ').slice(0, 2).join(' ')) + '<br>' : ''}
        Radios: ${a.wifi_2g ? '2.4G ✓' : '2.4G ✕'} ${a.wifi_5g ? '5G ✓' : '5G ✕'}<br>
        ${a.wireless_clients} wireless client(s) · ${a.clients_total ?? '—'} total seen<br>
        ${a.cpu != null ? `CPU ${Math.round(a.cpu * 100)}%` : ''} ${a.mem != null ? `· RAM ${Math.round(a.mem * 100)}%` : ''}
        ${a.latency != null ? `<br>Latency <b>${a.latency} ms</b>` : ''}<br>drag to move · click to filter`);
    });
    g.addEventListener('click', () => {
      $('#meshFilter').value = a.label;
      renderMeshTable();
      toast(`Filtered to ${a.label}`);
    });
  });

  svg.querySelector('[data-pihole]')?.addEventListener('click', () => activateSection('diagnostics'));

  $('#meshResetLayout').classList.toggle('has-custom', Object.keys(meshCustom).length > 0);
}

// Pan/zoom live on the <svg> element itself, which survives re-renders — so
// these are wired exactly ONCE (otherwise every 15s refresh would stack another
// handler and multiply each wheel tick).
let meshCanvasWired = false;
function initMeshCanvas() {
  if (meshCanvasWired) return;
  const svg = $('#meshSvg');
  if (!svg) return;
  meshCanvasWired = true;

  const toLocal = (ev) => {
    const vp = $('#meshViewport');
    if (!vp) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    return pt.matrixTransform(vp.getScreenCTM().inverse());
  };

  // viewBox units per CSS pixel (the viewBox is refitted on every render)
  const unitsPerPx = () => meshVB.w / (svg.clientWidth || meshVB.w);

  let pan = null;
  const pointers = new Map();     // active touches, for pinch
  let pinch = null;

  svg.addEventListener('pointerdown', (ev) => {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {          // second finger down → pinch, cancel pan/drag
      const [p1, p2] = [...pointers.values()];
      pinch = {
        d: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
        k: meshView.k,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        tx: meshView.tx, ty: meshView.ty,
      };
      pan = null;
      svg.classList.remove('panning');
      meshBusy = true;
      return;
    }
    if (ev.button !== 0 || meshDragging || pinch) return;   // node drag wins
    meshBusy = true;
    pan = { x: ev.clientX, y: ev.clientY, tx: meshView.tx, ty: meshView.ty };
    svg.classList.add('panning');
    try { svg.setPointerCapture(ev.pointerId); } catch {}
  });

  svg.addEventListener('pointermove', (ev) => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (pinch && pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const k = Math.min(4, Math.max(0.35, pinch.k * (dist / pinch.d)));
      // keep the pinch midpoint anchored under the fingers
      const s = unitsPerPx();
      const r = svg.getBoundingClientRect();
      const mx = (pinch.mid.x - r.left) * s + meshVB.x;
      const my = (pinch.mid.y - r.top) * s + meshVB.y;
      meshView.tx = mx - (mx - pinch.tx) * (k / pinch.k);
      meshView.ty = my - (my - pinch.ty) * (k / pinch.k);
      meshView.k = k;
      applyMeshView();
      return;
    }
    if (!pan) return;
    const s = unitsPerPx();
    meshView.tx = pan.tx + (ev.clientX - pan.x) * s;
    meshView.ty = pan.ty + (ev.clientY - pan.y) * s;
    applyMeshView();
  });

  const endPointer = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pan) {
      try { svg.releasePointerCapture?.(ev.pointerId); } catch {}
      svg.classList.remove('panning');
      pan = null;
    }
    if (pointers.size === 0) meshBusy = false;
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', endPointer);

  // wheel zoom anchored at the cursor
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const before = toLocal(ev);
    meshView.k = Math.min(4, Math.max(0.35, meshView.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
    applyMeshView();
    const after = toLocal(ev);
    meshView.tx += (after.x - before.x) * meshView.k;
    meshView.ty += (after.y - before.y) * meshView.k;
    applyMeshView();
  }, { passive: false });
}

function meshZoom(factor) {
  const k = Math.min(4, Math.max(0.35, meshView.k * factor));
  // keep the map centre fixed while zooming with the buttons
  const cx = MESH_W / 2, cy = MESH_H / 2;
  meshView.tx = cx - (cx - meshView.tx) * (k / meshView.k);
  meshView.ty = cy - (cy - meshView.ty) * (k / meshView.k);
  meshView.k = k;
  applyMeshView();
}

// ---------------------------------------------------------------------------
//  Wi-Fi health — signal quality distribution + actionable advice
// ---------------------------------------------------------------------------
// Standard Wi-Fi RSSI bands. Anything at or below -70 dBm is where throughput
// and latency start degrading noticeably.
function sigQuality(dbm) {
  if (dbm == null) return { key: 'unknown', label: 'not reported', cls: 'sg-unknown', pill: 'gray' };
  if (dbm >= -55) return { key: 'excellent', label: 'excellent', cls: 'sg-excellent', pill: 'green' };
  if (dbm >= -65) return { key: 'good', label: 'good', cls: 'sg-good', pill: 'blue' };
  if (dbm >= -72) return { key: 'fair', label: 'fair', cls: 'sg-fair', pill: 'amber' };
  return { key: 'weak', label: 'weak', cls: 'sg-weak', pill: 'red' };
}

function renderWifiHealth(d) {
  const aps = (d.aps || []).filter((a) => a.ok);
  const wifi = meshNodes.filter((n) => n.viaAp);
  const apById = Object.fromEntries(aps.map((a) => [a.id, a]));

  if (!wifi.length) {
    $('#wifiScore').textContent = '—';
    $('#wifiBars').innerHTML = '';
    $('#wifiAdvice').innerHTML = `<div class="empty">${aps.length ? 'No wireless clients currently associated.' : 'No access points configured.'}</div>`;
    $('#wifiTable tbody').innerHTML = '<tr><td colspan="5" class="empty">No Wi-Fi clients</td></tr>';
    return;
  }

  // --- distribution
  const buckets = { excellent: 0, good: 0, fair: 0, weak: 0, unknown: 0 };
  wifi.forEach((n) => buckets[sigQuality(n.signal).key]++);
  const order = [['excellent', 'Excellent', 'sg-excellent'], ['good', 'Good', 'sg-good'],
    ['fair', 'Fair', 'sg-fair'], ['weak', 'Weak', 'sg-weak'], ['unknown', 'Not reported', 'sg-unknown']];
  const total = wifi.length;
  $('#wifiBars').innerHTML = order.filter(([k]) => buckets[k] > 0).map(([k, label, cls]) => `
    <div class="sig-row"><span class="sg-name">${label}</span>
      <span class="sg-track"><span class="sg-fill ${cls}" style="width:${(buckets[k] / total * 100).toFixed(0)}%"></span></span>
      <span class="sg-val">${buckets[k]}</span></div>`).join('');

  // --- graded score (unknown-signal clients are excluded, not penalised)
  const known = wifi.filter((n) => n.signal != null);
  const healthy = known.filter((n) => n.signal > -72).length;
  $('#wifiScore').textContent = known.length ? `${healthy}/${known.length} healthy` : 'signal n/a';

  // --- advice
  const li = (lvl, t, s) => `<div class="sec-item"><div class="sec-icon ${lvl}">${{ ok: '✓', warn: '!', bad: '✕' }[lvl]}</div><div class="sec-text"><b>${esc(t)}</b><span>${esc(s)}</span></div></div>`;
  const advice = [];
  const weak = known.filter((n) => n.signal <= -72).sort((a, b) => a.signal - b.signal);
  if (weak.length) {
    const alt = aps.filter((a) => a.id !== weak[0].viaAp).map((a) => a.label);
    advice.push(li('bad', `${weak.length} client(s) on a weak signal`,
      `${weak.slice(0, 3).map((n) => `${n.name || n.ip} (${n.signal} dBm on ${n.viaApLabel})`).join(', ')}. ` +
      (alt.length ? `Relocate the client, or move it to ${alt.join(' or ')}.` : 'Relocate the client or the access point.')));
  } else if (known.length) {
    advice.push(li('ok', 'All measured signals are healthy', `Every client with a reported RSSI is above -72 dBm.`));
  }

  const fair = known.filter((n) => n.signal > -72 && n.signal <= -65);
  if (fair.length) advice.push(li('warn', `${fair.length} client(s) at fair signal`, `${fair.slice(0, 3).map((n) => `${n.name || n.ip} (${n.signal} dBm)`).join(', ')}. Usable, but subject to intermittent loss.`));

  // 2.4 GHz clients that could move to 5 GHz (only where an AP offers 5 GHz)
  const fiveGhzAps = aps.filter((a) => a.wifi_5g);
  const on24 = wifi.filter((n) => n.band === '2.4G');
  if (on24.length && fiveGhzAps.length) {
    advice.push(li('warn', `${on24.length} client(s) on 2.4 GHz`,
      `${fiveGhzAps.map((a) => a.label).join(' and ')} also provide${fiveGhzAps.length === 1 ? 's' : ''} 5 GHz. Moving capable clients to 5 GHz reduces contention on 2.4 GHz and typically lowers latency. Some clients support 2.4 GHz only.`));
  }

  // APs that report no signal at all
  const blindAps = aps.filter((a) => wifi.some((n) => n.viaAp === a.id && n.signal == null));
  if (blindAps.length) advice.push(li('warn', 'Signal not reported by some APs',
    `${blindAps.map((a) => a.label).join(', ')}: this firmware does not report per-client signal strength, so those clients are excluded from the score.`));

  // load balance across APs
  if (aps.length > 1) {
    const counts = aps.map((a) => ({ label: a.label, n: wifi.filter((x) => x.viaAp === a.id).length }));
    const max = Math.max(...counts.map((c) => c.n)), min = Math.min(...counts.map((c) => c.n));
    if (max - min >= 4) advice.push(li('warn', 'Uneven AP load',
      `${counts.map((c) => `${c.label}: ${c.n}`).join(' · ')}. One access point is carrying a disproportionate share of clients.`));
    else advice.push(li('ok', 'Access point load is balanced', counts.map((c) => `${c.label}: ${c.n}`).join(' · ')));
  }
  $('#wifiAdvice').innerHTML = advice.join('');

  // --- per-client table, worst signal first
  const rows = [...wifi].sort((a, b) => (a.signal ?? 999) - (b.signal ?? 999)).map((n) => {
    const q = sigQuality(n.signal);
    const ap = apById[n.viaAp];
    const pct = n.signal == null ? 0 : Math.max(0, Math.min(100, Math.round((n.signal + 90) / 40 * 100)));
    return `<tr><td>${iconHtml(deviceIconKey(n))} ${esc(n.name || n.ip)}</td>
      <td class="dim">${esc(ap ? ap.label : n.viaApLabel || '')}</td>
      <td><span class="pill ${n.band === '5G' ? 'violet' : 'blue'}">${esc(n.band || '—')}</span></td>
      <td class="mono num">${n.signal != null ? n.signal + ' dBm' : '—'}
        ${n.signal != null ? `<span class="sg-track" style="display:block;margin-top:4px"><span class="sg-fill ${q.cls}" style="width:${pct}%"></span></span>` : ''}</td>
      <td><span class="pill ${q.pill}">${q.label}</span></td></tr>`;
  }).join('');
  $('#wifiTable tbody').innerHTML = rows;
}

// ---------------------------------------------------------------------------
//  Roaming activity
// ---------------------------------------------------------------------------
function renderRoaming(d) {
  const r = d.roaming;
  const tl = $('#roamTimeline'), tb = $('#roamTable tbody');
  if (!r) {
    $('#roamCount').textContent = '0';
    $('#roamSince').textContent = '';
    tl.innerHTML = '<div class="empty">Roaming tracker unavailable (no access points configured).</div>';
    tb.innerHTML = '<tr><td colspan="4" class="empty">—</td></tr>';
    return;
  }
  const events = r.events || [];
  $('#roamCount').textContent = events.length;
  $('#roamSince').textContent = r.trackingSince ? `tracking since ${relTime(r.trackingSince)}` : '';

  // devices that hop a lot are worth surfacing even with few total events
  const perDevice = {};
  meshNodes.filter((n) => n.viaAp).forEach((n) => { if (n.roams) perDevice[n.name || n.ip] = n.roams; });
  const flappy = Object.entries(perDevice).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);

  if (!events.length) {
    tl.innerHTML = '<div class="empty">No roaming events recorded. All clients have remained on the same access point since tracking began.</div>';
    tb.innerHTML = '<tr><td colspan="4" class="empty">No roam events</td></tr>';
    return;
  }

  tl.innerHTML = `<div class="roam-time">${events.slice(0, 6).map((e) => `
    <div class="roam-ev ${e.kind === 'band-steer' ? 'steer' : ''}">
      <b>${esc(e.name || e.hostname || e.mac)}</b>
      ${e.kind === 'band-steer'
        ? `switched <span class="roam-arrow">→</span> ${esc(e.from_band || '?')} to ${esc(e.to_band || '?')} on ${esc(e.to_label || '')}`
        : `${esc(e.from_label || '?')} <span class="roam-arrow">→</span> ${esc(e.to_label || '?')}${e.to_band ? ` (${esc(e.to_band)})` : ''}`}
      <div class="rt">${relTime(e.t)} · held ${fmtDur(e.held)}</div>
    </div>`).join('')}</div>`;

  const flapNote = flappy.length
    ? `<tr><td colspan="4" class="dim" style="padding-top:10px">Frequent roaming: ${flappy.slice(0, 4).map(([n, c]) => `${esc(n)} (${c})`).join(', ')}. This indicates sticky-client behaviour or overlapping coverage.</td></tr>`
    : '';
  tb.innerHTML = events.map((e) => `<tr>
    <td class="dim">${relTime(e.t)}</td>
    <td>${esc(e.name || e.hostname || e.mac)}</td>
    <td>${e.kind === 'band-steer'
      ? `<span class="pill blue">band</span> ${esc(e.from_band || '?')} → ${esc(e.to_band || '?')}`
      : `<span class="pill violet">roam</span> ${esc(e.from_label || '?')} → ${esc(e.to_label || '?')}`}</td>
    <td class="mono">${fmtDur(e.held)}</td></tr>`).join('') + flapNote;
}

function renderMeshTable() {
  const f = ($('#meshFilter').value || '').toLowerCase();
  const now = Date.now() / 1000;
  const rows = meshNodes.filter((n) =>
    !f || (n.name || '').toLowerCase().includes(f) || (n.ip || '').includes(f)
    || (n.vendor || '').toLowerCase().includes(f) || (n.viaApLabel || '').toLowerCase().includes(f)
    || (n.band || '').toLowerCase().includes(f))
    .map((n) => {
      const cls = activityClass(n);
      const dot = { active: 'green', idle: 'violet', stale: 'gray' }[cls];
      const kindTag = n.kind === 'pihole' ? ' <span class="pill blue">DNS</span>'
        : n.kind === 'ap' ? ' <span class="pill amber">AP</span>' : '';
      const conn = n.viaAp
        ? `<span class="pill ${n.band === '5G' ? 'violet' : 'blue'}">${esc(n.band || 'Wi-Fi')}</span> <span class="dim">${esc(n.viaApLabel)}</span>`
        : `<span class="pill ${n.direct ? 'green' : 'gray'}">${n.direct ? 'wired · router' : 'via switch'}</span>`;
      return `<tr>
        <td><span class="pill ${dot}">●</span> ${iconHtml(deviceIconKey(n))} ${esc(n.name || '—')}${kindTag}</td>
        <td class="mono">${esc(n.ip)}</td><td>${esc(n.vendor || '')}</td>
        <td>${conn}</td>
        <td class="mono num">${n.signal != null ? n.signal + ' dBm' : '—'}</td>
        <td class="mono num">${n.latency != null ? n.latency + ' ms' : '—'}</td>
        <td class="mono">${n.firstSeen ? fmtDur(now - n.firstSeen) : '—'}</td>
        <td class="dim">${n.lastQuery ? relTime(n.lastQuery) : '—'}</td>
        <td class="mono num">${fmt(n.numQueries)}</td></tr>`;
    }).join('');
  $('#meshTable tbody').innerHTML = rows || '<tr><td colspan="9" class="empty">No devices</td></tr>';
  $('#meshDevCount').textContent = meshNodes.length;
}
$('#meshFilter').addEventListener('input', debounce(renderMeshTable));

// --- map toolbar
$('#meshZoomIn').addEventListener('click', () => meshZoom(1.25));
$('#meshZoomOut').addEventListener('click', () => meshZoom(1 / 1.25));
$('#meshFitView').addEventListener('click', () => {
  meshView.k = 1; meshView.tx = 0; meshView.ty = 0; applyMeshView(); toast('View reset');
});
function syncMeshModeBtn() {
  const b = $('#meshModeBtn');
  if (!b) return;
  b.textContent = meshMode === 'auto' ? 'Auto' : 'Tiers';
  b.classList.toggle('mode-auto', meshMode === 'auto');
  b.title = meshMode === 'auto'
    ? 'Force-directed layout — click for tiered'
    : 'Tiered layout — click for force-directed';
}
$('#meshModeBtn').addEventListener('click', () => {
  meshMode = meshMode === 'auto' ? 'tiers' : 'auto';
  localStorage.setItem(MESH_MODE_LS, meshMode);
  syncMeshModeBtn();
  meshView.k = 1; meshView.tx = 0; meshView.ty = 0;
  loaders.mesh();
  toast(meshMode === 'auto' ? 'Force-directed layout' : 'Tiered layout');
});
syncMeshModeBtn();

$('#meshResetLayout').addEventListener('click', async () => {
  if (!Object.keys(meshCustom).length) { toast('Layout is already automatic'); return; }
  if (!(await confirmDialog('Restore automatic node placement?\nYour custom positions will be discarded.',
    { title: 'Reset layout', yes: 'Reset' }))) return;
  meshCustom = {};
  try { localStorage.removeItem(MESH_LS); } catch {}
  $('#meshResetLayout').classList.remove('has-custom');
  loaders.mesh();
  toast('Layout reset', 'ok');
});

// ===========================================================================
//  Query Log
// ===========================================================================
let allQueries = [];
async function loadQueries() {
  try {
    await loadIdentity();
    allQueries = (await api(`queries?length=${$('#queryCount').value}`)).queries || [];
    renderQueries();
  } catch (e) { toast(`Could not load the query log: ${e.message}`, 'err'); }
}
function statusPill(s) {
  const u = String(s || '').toUpperCase();
  if (isBlockedStatus(u)) return `<span class="pill red">${esc(u)}</span>`;
  if (u.includes('CACHE')) return `<span class="pill violet">${esc(u)}</span>`;
  if (u.includes('FORWARD')) return `<span class="pill green">${esc(u)}</span>`;
  return `<span class="pill gray">${esc(u || '—')}</span>`;
}
function renderQueries() {
  const f = $('#queryFilter').value.toLowerCase();
  const icons = $('#queryIcons').checked;
  const rows = allQueries.filter((q) => {
    if (!f) return true;
    const c = nameForIp(q.client?.ip) + ' ' + (q.client?.ip || '');
    return (q.domain || '').toLowerCase().includes(f) || c.toLowerCase().includes(f);
  }).map((q) => {
    const ip = q.client?.ip || '', name = nameForIp(ip);
    const client = name !== ip ? `${esc(name)} <span class="dim">${esc(ip)}</span>` : `${esc(ip)}`;
    const blocked = isBlockedStatus(q.status);
    const act = blocked
      ? `<button class="btn btn-sm" data-allow="${esc(q.domain)}">Allow</button>`
      : `<button class="btn btn-sm btn-danger" data-deny="${esc(q.domain)}">Deny</button>`;
    const dom = `<div class="dom-cell">${icons ? favicon(q.domain) : ''}<span class="mono">${esc(q.domain)}</span></div>`;
    return `<tr><td class="mono">${clockFmt(q.time)}</td><td>${esc(q.type)}</td><td>${dom}</td><td class="mono">${client}</td><td>${statusPill(q.status)}</td><td class="mono dim">${esc(q.reply?.type || '')}</td><td>${act}</td></tr>`;
  }).join('');
  $('#queriesTable tbody').innerHTML = rows || '<tr><td colspan="7" class="empty">No queries</td></tr>';
}
$('#queryFilter').addEventListener('input', debounce(renderQueries));
$('#queryIcons').addEventListener('change', renderQueries);
$('#queryCount').addEventListener('change', () => loadQueries());
$('#queriesTable').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-allow]'), d = e.target.closest('[data-deny]');
  if (!a && !d) return;
  const domain = (a || d).dataset.allow || (a || d).dataset.deny;
  const type = a ? 'allow' : 'deny';
  try { await api(`domains/${type}/exact`, { method: 'POST', body: { domain, comment: 'From query log', enabled: true, groups: [0] } }); toast(`${domain} added to ${type}`, 'ok'); }
  catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
});

// ===========================================================================
//  Domains
// ===========================================================================
let allDomains = [];

// Enum -> [pill class, product label]. Table-driven so no class name is ever
// interpolated from API data, and the table teaches the same words as the form.
const TYPE_PILL = { allow: ['green', 'Allow'], deny: ['red', 'Deny'] };
const KIND_PILL = { exact: ['ghost', 'Exact'], regex: ['violet', 'Pattern'] };
const enumPill = (map, v) => {
  const [cls, label] = map[v] || ['gray', v || '—'];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
};

const DOMAIN_COLS = 7;

// Row identity. Prefer the API's id, but never depend on it: the composite is
// unique on its own, which matters because the same domain can legitimately
// exist as both an allow and a deny entry, and as both exact and pattern.
const domainKey = (d) => `${d.type}|${d.kind}|${d.domain}`;

async function loadDomains() {
  // Outside the try: loaders.* run under guard(), which swallows throws to
  // console.error, so a failure here must not be able to skip the table render.
  $('#domainMsg').textContent = ''; $('#domainMsg').className = 'hint';
  syncDomainMode();
  // One row, not 4x7: a screen reader dropped into this table would otherwise
  // browse 28 cells of ellipsis characters while the fetch is in flight.
  $('#domainsTable tbody').innerHTML =
    `<tr><td colspan="${DOMAIN_COLS}" class="empty"><span class="skeleton">Loading…</span></td></tr>`;
  try {
    const [dR, gR] = await Promise.allSettled([api('domains'), api('groups')]);
    if (dR.status !== 'fulfilled') throw dR.reason;
    if (gR.status === 'fulfilled') allGroups = gR.value.groups || [];
    allDomains = dR.value.domains || [];
    renderDomainGroupOptions();
    renderDomains();
  } catch (e) {
    $('#domainsTable tbody').innerHTML = `<tr><td colspan="${DOMAIN_COLS}" class="empty">Could not load managed domains</td></tr>`;
    toast(`Could not load managed domains: ${e.message}`, 'err');
  }
}

function renderDomainGroupOptions() {
  const sel = $('#domainGroupSel');
  const keep = sel.value;
  const groups = allGroups.length ? allGroups : [{ id: 0, name: 'Default' }];
  sel.innerHTML = groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  sel.value = groups.some((g) => String(g.id) === keep) ? keep : '0';
}

function renderDomains() {
  const f = $('#domainFilter').value.toLowerCase().trim();
  const ft = $('#domainTypeFilter').value, fk = $('#domainKindFilter').value;
  // d.unicode is searchable so an IDN entry is findable by its readable form,
  // but only the punycode is ever DISPLAYED — rendering the unicode form alone
  // would turn the table into a homograph-spoofing surface.
  const shown = allDomains
    .filter((d) => (!ft || d.type === ft) && (!fk || d.kind === fk)
      && (!f || `${d.domain} ${d.unicode || ''} ${d.comment || ''}`.toLowerCase().includes(f)))
    .sort((a, b) => (b.date_modified || b.date_added || 0) - (a.date_modified || a.date_added || 0));

  $('#domainCount').textContent = shown.length === allDomains.length
    ? allDomains.length : `${shown.length} of ${allDomains.length}`;

  if (!shown.length) {
    const es = allDomains.length
      ? ['No entries match this filter', `Adjust or clear the filter to see all ${allDomains.length} entries.`]
      : ['No managed domains', 'Add an allow or deny entry to control how a domain is resolved.'];
    $('#domainsTable tbody').innerHTML = `<tr><td colspan="${DOMAIN_COLS}"><div class="empty-state">`
      + `<span class="es-ico">${iconHtml('globe', 20)}</span><b>${esc(es[0])}</b><span>${esc(es[1])}</span></div></td></tr>`;
    return;
  }

  const gmap = {};
  allGroups.forEach((g) => { gmap[g.id] = g.name; });

  $('#domainsTable tbody').innerHTML = shown.map((d) => `
    <tr><td class="mono trunc" title="${esc(d.domain)}">${esc(d.domain)}</td>
      <td>${enumPill(TYPE_PILL, d.type)}</td>
      <td>${enumPill(KIND_PILL, d.kind)}</td>
      <td class="trunc">${(d.groups || []).map((gid) => `<span class="pill violet">${esc(gmap[gid] ?? gid)}</span>`).join(' ') || '<span class="dim">—</span>'}</td>
      <td class="cmt trunc" title="${esc(d.comment || '')}">${esc(d.comment || '')}</td>
      <td><label class="switch"><input type="checkbox" ${d.enabled ? 'checked' : ''} aria-label="${d.enabled ? 'Disable' : 'Enable'} ${esc(d.domain)}" data-key="${esc(domainKey(d))}" data-tog-domain="1"><span></span></label></td>
      <td class="acts">
        <button class="btn btn-sm" data-edit-key="${esc(domainKey(d))}" aria-label="Edit ${esc(d.domain)}">Edit</button>
        <button class="btn btn-sm btn-icon-sm" aria-label="Delete ${esc(d.domain)}" title="Delete ${esc(d.domain)}" data-key="${esc(domainKey(d))}" data-del-domain="1">${iconHtml('trash')}</button>
      </td></tr>`).join('');
}
$('#domainFilter').addEventListener('input', debounce(renderDomains));
$('#domainTypeFilter').addEventListener('change', renderDomains);
$('#domainKindFilter').addEventListener('change', renderDomains);

// ---------------------------------------------------------------------------
//  Pattern builder
//
//  FTL compiles domain patterns with POSIX regcomp(REG_EXTENDED | REG_ICASE)
//  and evaluates them UNANCHORED against the queried domain in lowercase.
//  That differs from PCRE in ways that fail silently once saved -- \d, \b,
//  lookarounds, non-capturing groups and lazy quantifiers are all rejected or
//  matched literally by FTL. The generators below emit ERE-safe output and the
//  linter flags PCRE-only constructs in hand-written input.
// ---------------------------------------------------------------------------

// Every character with a special meaning in POSIX ERE.
const ereEscape = (v) => String(v).replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');

// Accepts what an operator is likely to paste: a URL, a wildcard form, a
// trailing dot, mixed case. Reduces all of it to a bare host name.
function normHost(v) {
  return String(v).trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')       // scheme
    .replace(/\/.*$/, '')              // path
    .replace(/:\d+$/, '')              // port
    .replace(/^\*+\./, '')             // *.example.com
    .replace(/^\.+|\.+$/g, '');        // stray leading/trailing dots
}
const normLabel = (v) => String(v).trim().toLowerCase().replace(/^\.+|\.+$/g, '');

const PB_KINDS = {
  subdomains: {
    field: 'Domain', ph: 'example.com', norm: normHost,
    build: (d) => `(^|\\.)${ereEscape(d)}$`,
    why: (d) => `Matches ${d} itself and every subdomain beneath it. The leading (^|\\.) group is what prevents the pattern from also matching an unrelated domain that merely ends in the same text, such as not${d}.`,
    samples: (d) => [d, `www.${d}`, `metrics.eu.${d}`, `not${d}`, `${d}.example.net`],
  },
  exact: {
    field: 'Domain', ph: 'example.com', norm: normHost,
    build: (d) => `^${ereEscape(d)}$`,
    why: (d) => `Matches only ${d}. Subdomains are not affected. For a single fixed name, an exact-match entry is cheaper to evaluate than a pattern.`,
    samples: (d) => [d, `www.${d}`, `${d}.example.net`],
  },
  subonly: {
    field: 'Domain', ph: 'example.com', norm: normHost,
    build: (d) => `\\.${ereEscape(d)}$`,
    why: (d) => `Matches every subdomain of ${d} while leaving ${d} itself resolvable. Useful where the apex domain serves required content but its subdomains do not.`,
    samples: (d) => [`www.${d}`, `cdn.${d}`, d],
  },
  contains: {
    field: 'Keyword', ph: 'telemetry', norm: normLabel,
    build: (k) => ereEscape(k),
    why: (k) => `Matches any domain containing "${k}" anywhere in the name, because patterns are evaluated unanchored. This is the broadest form and the most likely to over-block, so review the test results carefully.`,
    samples: (k) => [`${k}.example.com`, `example.com`, `eu-${k}-edge.example.net`, `${k}example.org`],
  },
  prefix: {
    field: 'Host name starts with', ph: 'ads', norm: normLabel,
    build: (h) => `^${ereEscape(h)}`,
    why: (h) => `Matches any domain whose name begins with "${h}", on any registered domain. The ^ anchor restricts the match to the start of the name.`,
    samples: (h) => [`${h}.example.com`, `${h}-eu.example.net`, `my${h}.example.org`, `example.com`],
  },
  numbered: {
    field: 'Domain', ph: 'example.com', norm: normHost, host: true,
    build: (d, h) => `^${ereEscape(h)}[0-9]+\\.${ereEscape(d)}$`,
    why: (d, h) => `Matches ${h} host names on ${d} that end in one or more digits, covering an enumerated set such as ${h}1 through ${h}99. Note the ERE character class [0-9]; the Perl shorthand \\d is not supported.`,
    samples: (d, h) => [`${h}1.${d}`, `${h}42.${d}`, `${h}.${d}`, `${h}x.${d}`],
  },
  tld: {
    field: 'Top-level domain', ph: 'zip', norm: normLabel,
    build: (t) => `\\.${ereEscape(t)}$`,
    why: (t) => `Matches every domain in the .${t} top-level domain. The $ anchor keeps the match at the end of the name, so a domain such as example.${t}.com is not affected.`,
    samples: (t) => [`example.${t}`, `deep.sub.${t}`, `example.${t}.com`, `example.com`],
  },
  all: {
    field: null,
    build: () => '^.*$',
    why: () => 'Matches every domain. Applied as a deny entry it blocks all DNS resolution for the groups the entry is assigned to, which is the standard way to build a scheduled lockdown. Assign it to a dedicated lockdown group — left in the Default group it blocks DNS for every client on the network.',
    samples: () => ['example.com', 'internal.lan', 'a.b.c.example.net'],
  },
  custom: {
    field: 'Pattern', ph: '(^|\\.)example\\.(com|net)$', norm: (v) => String(v).trim(), raw: true,
    build: (v) => v,
    why: () => 'Entered manually. The checks below cover POSIX ERE compatibility and match behaviour, but not intent.',
    samples: () => [],
  },
};

// PCRE constructs that FTL's POSIX ERE engine does not implement.
const ERE_UNSUPPORTED = [
  [/\\[dwsDWS]/, 'Perl character-class shorthands (\\d, \\w, \\s) are not supported. Use an ERE class instead: [0-9], [a-z0-9_], [ \\t].'],
  [/\(\?[=!<]/, 'Lookahead and lookbehind assertions are not supported.'],
  [/\(\?:/, 'Non-capturing groups (?:...) are not supported. A plain group (...) behaves identically here.'],
  [/\(\?P?</, 'Named groups are not supported.'],
  [/[*+?}]\?/, 'Lazy quantifiers (*?, +?, ??) are not supported and the trailing ? will be read as a separate quantifier.'],
  [/\\[bBAZzGQEK]/, 'Word-boundary and string anchors (\\b, \\A, \\Z) are not supported. Use ^ and $.'],
  [/\{,\d/, 'An interval must state its lower bound: write {0,3} rather than {,3}.'],
];

// Reports a hard error, plus any number of advisories.
function lintPattern(pattern) {
  const notes = [];
  if (!pattern) return { ok: false, notes: [['err', 'Enter a value to generate a pattern.']] };

  // Optional FTL modifiers are appended after a semicolon and are not regex.
  const [body, ...mods] = pattern.split(';');
  if (!body) return { ok: false, notes: [['err', 'The pattern is empty before the first semicolon.']] };

  let re = null;
  try { re = new RegExp(body, 'i'); }
  catch (e) { return { ok: false, notes: [['err', `Not a valid regular expression: ${e.message.replace(/^Invalid regular expression: [^:]*: /, '')}`]] }; }

  for (const [rx, text] of ERE_UNSUPPORTED) if (rx.test(body)) notes.push(['warn', text]);

  // An unescaped dot is the single most common Pi-hole pattern defect: it
  // matches any character, so (^|.)example.com$ also matches examplexcom.
  const bare = body.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  if (/\./.test(bare)) notes.push(['warn', 'This pattern contains an unescaped dot, which matches any single character. Write \\. to match a literal dot in a domain name.']);

  if (re.test('example.com') && re.test('internal.lan') && re.test('a-b-c.test'))
    notes.push(['warn', 'This pattern matches effectively every domain. Confirm that the scope is intentional before applying it.']);

  if (/^\^?[a-z0-9-]+\\\.[a-z0-9\\.-]+\$?$/.test(body) && !/[|*+?[({]/.test(body))
    notes.push(['info', 'This pattern has no wildcards and matches a single fixed name. An exact-match entry would achieve the same result with lower evaluation cost.']);

  for (const m of mods) {
    if (!m) continue;
    if (/^invert$/i.test(m)) notes.push(['info', 'Modifier ";invert" inverts the match: the entry applies to every domain the pattern does NOT match.']);
    else if (/^querytype=/i.test(m)) notes.push(['info', `Modifier ";${m}" restricts the entry to the listed query types.`]);
    else if (/^reply=/i.test(m)) notes.push(['info', `Modifier ";${m}" overrides the reply sent for a match.`]);
    else notes.push(['warn', `";${m}" is not a recognised FTL modifier and the entry may be rejected.`]);
  }
  return { ok: true, re, notes };
}

let pbSamplesEdited = false;
// Whether the operator has explicitly collapsed the panel. Mode alone decides
// whether the builder is AVAILABLE; this decides whether it is currently shown.
let pbCollapsed = false;

// Characters that only make sense in a pattern. Deliberately conservative:
// `-` and `_` are legal in a host name and must never appear here.
const RE_META = /[\\^$*+?()[\]{}|]/;

const PB_SEVERITY = { info: 'Note: ', warn: 'Warning: ', err: 'Error: ' };

// Written by syncDomainMode() and by addDomain(); syncDomainMode() also retracts
// it by comparing against this exact string, so the two must not drift.
const META_MSG = 'This value contains regular-expression characters. Select Pattern (regex) as the match type, or remove them.';

function pbSpec() { return PB_KINDS[$('#pbKind').value] || PB_KINDS.custom; }

function pbBuild() {
  const spec = pbSpec();
  if (!spec.field) return { spec, value: '', host: '', pattern: spec.build() };
  const value = spec.norm($('#pbValue').value);
  const host = spec.host ? normLabel($('#pbHost').value) : '';
  if (!value || (spec.host && !host)) return { spec, value, host, pattern: '' };
  return { spec, value, host, pattern: spec.build(value, host) };
}

function pbRender() {
  const spec = pbSpec();

  // contextual fields
  $('#pbValueWrap').hidden = !spec.field;
  $('#pbHostWrap').hidden = !spec.host;
  if (spec.field) {
    $('#pbValueLabel').textContent = spec.field;
    $('#pbValue').placeholder = spec.ph;
  }

  const { value, host, pattern } = pbBuild();
  const lint = lintPattern(pattern);

  const code = $('#pbPattern');
  code.textContent = pattern || '—';
  code.classList.toggle('invalid', !!pattern && !lint.ok);
  $('#pbCopy').disabled = !pattern;
  $('#pbUse').disabled = !pattern || !lint.ok;

  // Name the field that is actually missing: for the numbered-hosts intent the
  // Domain can be filled while Host prefix is empty, and the old copy told the
  // operator to fill in the one field they had already completed.
  const need = !spec.field ? '' : (spec.host && value && !host) ? 'a host prefix' : `a ${spec.field.toLowerCase()}`;
  const notes = pattern
    ? [['info', spec.why(value, host)], ...lint.notes]
    : [['info', need ? `Enter ${need} to generate a pattern.` : '']];
  // Severity is carried in WORDS as well as colour and the CSS ::before glyph,
  // which is not in the accessibility tree.
  $('#pbLint').innerHTML = notes.filter(([, t]) => t)
    .map(([k, t]) => `<p class="pb-note ${k}"><span class="vh">${PB_SEVERITY[k] || ''}</span>${esc(t)}</p>`).join('');

  // Seed the test list from the intent until the operator edits it themselves.
  if (!pbSamplesEdited && pattern) {
    const samples = spec.samples(value, host);
    if (samples.length) $('#pbTest').value = samples.join('\n');
  }
  pbTest();
}

function pbTest() {
  const { pattern } = pbBuild();
  const lint = lintPattern(pattern);
  const lines = $('#pbTest').value.split('\n').map((l) => normHost(l)).filter(Boolean);
  const allow = $('#domainType').value === 'allow';

  if (!lint.ok || !lines.length) {
    $('#pbResults').innerHTML = '';
    $('#pbTestSummary').textContent = '';
    pbAnnounce();
    return;
  }
  let hits = 0;
  $('#pbResults').innerHTML = lines.map((d) => {
    const hit = lint.re.test(d);
    if (hit) hits++;
    const cls = hit ? (allow ? 'hit-allow' : 'hit') : (allow ? 'miss-allow' : 'miss');
    const label = allow ? (hit ? 'Permitted' : 'Not permitted') : (hit ? 'Blocked' : 'Not blocked');
    return `<span class="pb-res ${cls}" role="listitem"><b aria-hidden="true">${hit ? '\u2714' : '\u2715'}</b>`
      + `<span class="vh">${label}: </span><span title="${esc(d)}">${esc(d)}</span></span>`;
  }).join('');
  $('#pbTestSummary').textContent = `${hits} of ${lines.length} ${allow ? 'permitted' : 'blocked'}`;
  pbAnnounce();
}

// The builder's ONLY live region. #pbPattern / #pbLint / #pbResults update on
// every keystroke and must stay silent, or a screen reader is flooded with
// prose mid-word. 700ms is a floor, not a preference.
const pbAnnounce = debounce(() => {
  const p = $('#pbPattern').textContent;
  const warn = $$('#pbLint .pb-note.warn').length, err = $$('#pbLint .pb-note.err').length;
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}. `;
  $('#pbStatus').textContent = (!p || p === '—')
    ? 'No pattern generated.'
    : `Pattern ${p}. ${err ? plural(err, 'error') : ''}${warn ? plural(warn, 'warning') : ''}`
      + `${$('#pbTestSummary').textContent || 'No sample domains tested'}.`;
}, 700);

// Carry an in-progress value into the builder, inferring the intent so a bare
// host name does not land in manual mode and immediately trip the unescaped-dot
// warning against itself.
function pbSeed() {
  const cur = $('#domainInput').value.trim();
  if (!cur) return;
  const isPattern = RE_META.test(cur);
  $('#pbKind').value = isPattern ? 'custom' : 'subdomains';
  $('#pbValue').value = cur;
  pbSamplesEdited = isPattern;   // a generated intent must be free to seed its own samples
}

// THE single source of truth for everything that depends on the match type.
// No other line in this file may write #patternBtn.hidden or
// #patternBuilder.hidden — otherwise the two can drift out of sync with the
// select, which is exactly what a browser form restoration used to cause.
function syncDomainMode() {
  const regex = $('#domainKind').value === 'regex';
  const btn = $('#patternBtn'), panel = $('#patternBuilder');
  $('#domainInput').placeholder = regex ? '(^|\\.)example\\.com$' : 'ads.example.com';
  btn.hidden = !regex;
  panel.hidden = !regex || pbCollapsed;
  btn.textContent = panel.hidden ? 'Build Pattern' : 'Hide Builder';
  btn.setAttribute('aria-expanded', String(!panel.hidden));
  // Guard is load-bearing: pbRender() writes #pbTest, so rendering while hidden
  // would clobber sample text the operator typed.
  if (!panel.hidden) pbRender();

  // Flag a pattern sitting in the field while the mode says exact, at the moment
  // of the mode change rather than at a rejected submit. Never rewrite the value.
  //
  // The retraction is keyed on the message's own text rather than a module flag:
  // #domainMsg has five writers, and a flag that only this function resets would
  // eventually wipe someone else's still-valid message.
  const msg = $('#domainMsg');
  if (!regex && RE_META.test($('#domainInput').value)) {
    msg.textContent = META_MSG;
    msg.className = 'hint error';
    $('#domainInput').setAttribute('aria-invalid', 'true');
  } else if (msg.textContent === META_MSG) {
    msg.textContent = ''; msg.className = 'hint';
    $('#domainInput').removeAttribute('aria-invalid');
  }
}

$('#domainKind').addEventListener('change', () => { pbCollapsed = false; pbSeed(); syncDomainMode(); });
$('#domainType').addEventListener('change', pbTest);
$('#patternBtn').addEventListener('click', () => {
  pbCollapsed = !pbCollapsed;
  if (!pbCollapsed) pbSeed();
  syncDomainMode();
});
$('#pbKind').addEventListener('change', () => {
  const spec = pbSpec();
  if (!spec.raw) pbSamplesEdited = false;   // regenerate samples for a new intent
  pbRender();
});
$('#pbValue').addEventListener('input', pbRender);
$('#pbHost').addEventListener('input', pbRender);
$('#pbTest').addEventListener('input', () => { pbSamplesEdited = true; pbTest(); });
$('#pbCopy').addEventListener('click', async () => {
  const pattern = $('#pbPattern').textContent;
  try { await navigator.clipboard.writeText(pattern); toast('Pattern copied', 'ok'); }
  catch { toast('The browser blocked clipboard access', 'err'); }
});
$('#pbUse').addEventListener('click', () => {
  const { pattern } = pbBuild();
  if (!pattern) return;
  $('#domainInput').value = pattern;
  $('#domainKind').value = 'regex';   // programmatic: fires no change event
  syncDomainMode();
  const msg = $('#pbMsg');
  msg.textContent = 'Pattern loaded into the Domain field. Select Add to apply it.';
  msg.className = 'hint ok';
  $('#domainInput').focus();
});
$('#pbClose').addEventListener('click', () => {
  pbCollapsed = true;
  syncDomainMode();
  // The panel just became display:none with focus inside it, which resets
  // activeElement to <body> and sends the next Tab back to the top of the page.
  // #patternBtn is guaranteed visible here: pbClose is only reachable in regex
  // mode, and syncDomainMode() unhides the opener in that mode.
  $('#patternBtn').focus();
});

// --- add ------------------------------------------------------------------
async function addDomain() {
  const domain = $('#domainInput').value.trim(), type = $('#domainType').value,
        kind = $('#domainKind').value, comment = $('#domainComment').value.trim();
  const group = Number($('#domainGroupSel').value || 0);
  const msg = $('#domainMsg');
  const fail = (text) => {
    msg.textContent = text; msg.className = 'hint error';
    $('#domainInput').setAttribute('aria-invalid', 'true'); $('#domainInput').focus();
  };
  if (!domain) return fail(kind === 'regex' ? 'Enter a pattern, or use the Pattern Builder.' : 'Enter a domain.');

  if (kind === 'regex') {
    // Reject a malformed pattern here: FTL accepts some and then silently never
    // matches, which is far harder to notice than a rejected entry.
    const lint = lintPattern(domain);
    if (!lint.ok) return fail(lint.notes[0][1]);
    if (lint.re.test('example.com') && lint.re.test('internal.lan') && lint.re.test('a-b-c.test')) {
      const gname = allGroups.find((g) => g.id === group)?.name || 'Default';
      // The consequence is the opposite for each type, so the copy must be too:
      // a catch-all deny stops resolution outright, a catch-all allow overrides
      // every deny entry and filter list.
      const ok = await confirmDialog(type === 'deny'
        ? `This pattern matches every domain. Applied as a deny entry in the ${gname} group it will stop all DNS resolution for every client assigned to that group. Assign it to a dedicated lockdown group instead.`
        : `This pattern matches every domain. Applied as an allow entry in the ${gname} group it will permit every domain for every client assigned to that group, overriding all deny entries and filter lists for those clients.`,
        { title: 'Confirm network-wide scope', yes: 'Apply anyway' });
      if (!ok) return;
    }
  } else if (RE_META.test(domain)) {
    return fail(META_MSG);
  }

  try {
    await api(`domains/${type}/${kind}`, { method: 'POST',
      body: { domain, comment: comment || 'Added via Blackhole.Net', enabled: true, groups: [group] } });
    $('#domainInput').value = ''; $('#domainComment').value = '';
    $('#domainInput').removeAttribute('aria-invalid');
    $('#pbMsg').textContent = '';
    pbSamplesEdited = false; pbCollapsed = true;
    syncDomainMode();
    $('#domainInput').focus();
    // loadDomains() clears #domainMsg synchronously before its first await, so
    // the confirmation has to be written AFTER it or it never reaches a paint
    // and the role="status" region announces nothing.
    loadDomains();
    msg.textContent = `Added ${domain} as ${type === 'allow' ? 'an allowed' : 'a denied'} ${kind === 'regex' ? 'pattern' : 'exact match'}.`;
    msg.className = 'hint ok';
  } catch (e) { fail(`Could not add the entry: ${e.message}`); }
}
// A real form, so Enter submits from any field with no keydown listeners.
// #patternBtn carries type="button" so it cannot submit.
$('#addDomainForm').addEventListener('submit', (e) => { e.preventDefault(); addDomain(); });
$('#domainInput').addEventListener('input', () => {
  $('#domainMsg').textContent = ''; $('#domainMsg').className = 'hint';
  $('#domainInput').removeAttribute('aria-invalid');
});

// --- edit -----------------------------------------------------------------
// type, kind and the domain text form the PUT URL and therefore the entry's
// identity, so only comment / groups / enabled are editable here.
function openDomainEdit(d) {
  const inGroup = (id) => (d.groups || []).includes(id);
  $('#editTitle').textContent = `Edit · ${d.domain}`;
  $('#editBody').innerHTML = `
    <div class="field"><label>Entry</label>
      <p class="hint">${esc(TYPE_PILL[d.type]?.[1] ?? d.type)} · ${esc(KIND_PILL[d.kind]?.[1] ?? d.kind)} · <span class="mono">${esc(d.domain)}</span><br>
      Type, match type and the domain text identify this entry and cannot be changed here. Delete the entry and add it again to change them.</p></div>
    <div class="field"><label for="edComment">Comment</label>
      <input id="edComment" type="text" value="${esc(d.comment || '')}"></div>
    <div class="field"><label>Groups</label><div class="check-grid">${
      // Union of the known groups and whatever this entry is already assigned
      // to. If the groups fetch failed, allGroups is empty and rendering only
      // that would silently reassign the entry to Default on save.
      (() => {
        const known = allGroups.length ? allGroups : [{ id: 0, name: 'Default' }];
        const extra = (d.groups || []).filter((id) => !known.some((g) => g.id === id))
          .map((id) => ({ id, name: `Group ${id}` }));
        return [...known, ...extra].map((g) =>
          `<label class="${inGroup(g.id) ? 'on' : ''}"><input type="checkbox" value="${esc(g.id)}" ${inGroup(g.id) ? 'checked' : ''}>${esc(g.name)}</label>`).join('');
      })()
    }</div></div>`;
  $$('#editBody .check-grid label').forEach((l) =>
    l.querySelector('input').addEventListener('change', (ev) => l.classList.toggle('on', ev.target.checked)));
  $('#editModal').classList.add('show');
  $('#editSave').onclick = async () => {
    // scoped to .check-grid: this body also holds a text input
    const groups = [...$$('#editBody .check-grid input:checked')].map((i) => Number(i.value));
    try {
      await api(`domains/${d.type}/${d.kind}/${encodeURIComponent(d.domain)}`, { method: 'PUT',
        body: { type: d.type, kind: d.kind, comment: $('#edComment').value.trim(),
                groups: groups.length ? groups : [0], enabled: d.enabled } });
      toast(`Updated ${d.domain}`, 'ok');
      $('#editModal').classList.remove('show');
      loadDomains();
    } catch (err) { toast(`Could not update ${d.domain}: ${err.message}`, 'err'); }
  };
}

// --- row actions ----------------------------------------------------------
const domainByKey = (k) => allDomains.find((x) => domainKey(x) === k);

$('#domainsTable').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-edit-key]');
  if (ed) { const d = domainByKey(ed.dataset.editKey); if (d) openDomainEdit(d); return; }

  const b = e.target.closest('[data-del-domain]');
  if (!b) return;
  const d = domainByKey(b.dataset.key);
  if (!d) return;
  const what = d.kind === 'regex' ? 'pattern' : 'exact match';
  if (!(await confirmDialog(`Delete the ${d.type} ${what} entry ${d.domain}?`,
    { title: 'Delete domain', yes: 'Delete' }))) return;
  try {
    await api(`domains/${d.type}/${d.kind}/${encodeURIComponent(d.domain)}`, { method: 'DELETE' });
    toast(`Deleted ${d.domain}`, 'ok');
    loadDomains();
  } catch (err) { toast(`Could not delete ${d.domain}: ${err.message}`, 'err'); }
});

$('#domainsTable').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-tog-domain]'); if (!t) return;
  const d = domainByKey(t.dataset.key); if (!d) return;
  try {
    // PUT REPLACES the entry's mutable fields, so a partial body silently wiped
    // the comment and reassigned the entry to the Default group. Send them all.
    await api(`domains/${d.type}/${d.kind}/${encodeURIComponent(d.domain)}`, { method: 'PUT',
      body: { type: d.type, kind: d.kind, comment: d.comment ?? '',
              groups: d.groups?.length ? d.groups : [0], enabled: t.checked } });
    d.enabled = t.checked;
    // the row is not re-rendered, so refresh the control's accessible name here
    t.setAttribute('aria-label', `${t.checked ? 'Disable' : 'Enable'} ${d.domain}`);
    toast(`${d.domain} ${t.checked ? 'enabled' : 'disabled'}`, 'ok');
  } catch (err) { toast(`Could not update ${d.domain}: ${err.message}`, 'err'); loadDomains(); }
});

// Derive the initial mode once at load, so a browser form restoration that
// reinstates "Pattern (regex)" without firing `change` cannot leave the builder
// and its opener both hidden.
syncDomainMode();

// ===========================================================================
//  Automation — a second instance of the Pattern Builder's sequence:
//  pick an intent, get a generated description, see graded checks against live
//  data, then commit in two explicit stages (save disarmed, then arm).
// ===========================================================================
let autoData = { status: null, kinds: [], automations: [] };
let abDraft = null;          // { kind, id?, name, config }

const KIND_ICON = {
  'access.window': 'clock', 'gravity.refresh': 'refresh', 'backup.teleporter': 'save',
  'blocking.watchdog': 'shield', 'integrity.monitor': 'radar', 'device.new': 'device',
  'infra.watch': 'bolt', 'infra.reboot': 'power',
};
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Reboot targets, in the same shape the sidecar accepts as a control-plane id.
// Populated by loadAutomation; if the sidecar is unreachable this stays empty
// and the picker degrades to a free-text id rather than silently offering none.
let autoDevices = [];

// Field schema per kind. Mirrors the server-side validators; the server remains
// the authority — this only shapes the form.
const KIND_FIELDS = {
  'access.window': [
    { k: 'groupName', t: 'group', label: 'Pi-hole group' },
    { k: 'days', t: 'days', label: 'Days', def: [0, 1, 2, 3, 4, 5, 6] },
    { k: 'start', t: 'time', label: 'Blocked from', def: '22:00' },
    { k: 'end', t: 'time', label: 'Until', def: '06:00' },
  ],
  'gravity.refresh': [
    { k: 'days', t: 'days', label: 'Days', def: [0, 1, 2, 3, 4, 5, 6] },
    { k: 'at', t: 'time', label: 'At', def: '03:30' },
    { k: 'minHours', t: 'num', label: 'Skip if one ran within (hours)', def: 20, min: 0, max: 168 },
  ],
  'backup.teleporter': [
    { k: 'days', t: 'days', label: 'Days', def: [0] },
    { k: 'at', t: 'time', label: 'At', def: '04:00' },
    { k: 'keep', t: 'num', label: 'Archives to keep', def: 7, min: 1, max: 60 },
  ],
  'blocking.watchdog': [
    { k: 'afterMinutes', t: 'num', label: 'Re-enable after (minutes)', def: 30, min: 5, max: 720 },
  ],
  'integrity.monitor': [
    { k: 'minQueries', t: 'num', label: 'Only when queries exceed', def: 500, min: 50, max: 100000 },
    { k: 'floorPercent', t: 'num', label: 'Alert below (% blocked)', def: 2, min: 0, max: 90 },
  ],
  'device.new': [],
  'infra.reboot': [
    { k: 'deviceId', t: 'device', label: 'Device to reboot' },
    { k: 'days', t: 'days', label: 'Days', def: [0] },
    { k: 'at', t: 'time', label: 'At', def: '04:30' },
    // min 6 mirrors the server's hard floor; the server re-clamps regardless.
    { k: 'minHours', t: 'num', label: 'Never reboot twice within (hours)', def: 24, min: 6, max: 168 },
  ],
  'infra.watch': [
    { k: 'watchWan', t: 'bool', label: 'Watch the internet connection', def: true },
    { k: 'cpuPct', t: 'num', label: 'Gateway CPU above (%)', def: 90, min: 40, max: 100 },
    { k: 'memPct', t: 'num', label: 'Gateway memory above (%)', def: 90, min: 40, max: 100 },
    { k: 'dwellMinutes', t: 'num', label: 'Sustained for (minutes)', def: 5, min: 1, max: 120 },
  ],
};

const autoApi = async (path, opts) => {
  const res = await fetch(`/manager/automation${path}`, {
    method: opts?.method || 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.message || d.error || `HTTP ${res.status}`);
  return d;
};

async function loadAutomation() {
  // Reboot targets, for the Scheduled Router Reboot picker. Best-effort: a
  // sidecar that is down must not stop the rest of the section rendering.
  Promise.allSettled([getJson('/manager/router/status'), getJson('/manager/router/aps')])
    .then(([st, aps]) => {
      const list = [];
      const g = st.status === 'fulfilled' ? st.value : null;
      if (g && !g.error) list.push({ id: 'gateway', label: g.model ? `Gateway — ${g.model}` : 'Gateway' });
      for (const a of (aps.status === 'fulfilled' && aps.value?.aps) || []) {
        if (a?.id) list.push({ id: String(a.id), label: a.label || a.model || String(a.id) });
      }
      autoDevices = list;
    });
  try {
    autoData = await autoApi('/');
    renderAutoHud();
    renderAutoTemplates();
    renderAutoList();
  } catch (e) {
    $('#autoStateText').textContent = 'Unavailable';
    $('#autoStateSub').textContent = e.message;
    $('#autoLamp').className = 'auto-lamp bad';
  }
  loadAutoJournal();
}

async function loadAutoJournal() {
  const [ev, runs] = await Promise.allSettled([autoApi('/events?limit=40'), autoApi('/runs?limit=60')]);
  if (ev.status === 'fulfilled') renderAutoEvents(ev.value.events || []);
  if (runs.status === 'fulfilled') renderAutoRuns(runs.value.runs || []);
}

function renderAutoHud() {
  const st = autoData.status || {};
  const lamp = $('#autoLamp');
  const killed = st.killFile;
  const on = st.enabled && !st.stalled;
  lamp.className = `auto-lamp ${st.stalled || killed ? 'bad' : on ? 'on' : 'off'}`;
  $('#autoStateText').textContent = killed ? 'Stopped by data/automation.disable'
    : st.stalled ? 'Stalled' : st.enabled ? 'Armed' : 'Disabled';
  $('#autoStateSub').textContent = `${st.armed ?? 0} of ${st.total ?? 0} armed · ${st.tickSeconds ?? 30}s tick · ${esc(st.tz || 'UTC')}`;
  $('#autoKv').innerHTML = [
    ['Local time', st.now ? `${st.now.date} ${st.now.hhmm}` : '—'],
    ['Last tick', st.lastTickAt ? relTime(st.lastTickAt / 1000) : 'never'],
    ['Alerts', String(st.unacked ?? 0)],
    ['Webhook', st.webhook ? 'configured' : 'none'],
  ].map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
  if (st.tzUnsupported) {
    $('#autoMsg').textContent = 'This runtime has no time-zone data, so schedules are evaluated in UTC.';
    $('#autoMsg').className = 'hint error';
  }
}

function renderAutoTemplates() {
  $('#autoTemplates').innerHTML = (autoData.kinds || []).map((k) => `
    <button class="tpl" type="button" data-new-kind="${esc(k.key)}">
      <b>${iconHtml(KIND_ICON[k.key] || 'bolt', 15)}${esc(k.label)}</b>
      <span>${esc(k.blurb)}</span>
      <span class="mono dim">requires ${esc(k.role)}${k.alertOnly ? ' · alert only' : ''}</span>
    </button>`).join('');
}

function renderAutoList() {
  const rows = autoData.automations || [];
  $('#autoCount').textContent = rows.length;
  if (!rows.length) {
    $('#autoList').innerHTML = `<div class="empty-state"><span class="es-ico">${iconHtml('bolt', 20)}</span>`
      + '<b>No automations yet</b><span>Pick one of the options above. Nothing runs until you arm it.</span></div>';
    return;
  }
  $('#autoList').innerHTML = rows.map((a) => {
    const cls = a.lastResult === 'failed' ? 'failed' : a.enabled ? 'armed' : a.alertOnly ? 'alert-only' : '';
    const next = a.nextRun ? `${a.nextRun.in === 0 ? 'today' : a.nextRun.in === 1 ? 'tomorrow' : DOWS[a.nextRun.dow] || ''} at ${esc(a.nextRun.at)}` : '—';
    const res = a.lastResult
      ? `<span class="pill ${a.lastResult === 'ok' ? 'green' : a.lastResult === 'failed' ? 'red' : 'amber'}">${esc(a.lastResult)}</span>`
      : '<span class="pill gray">never run</span>';
    return `<div class="auto-card ${cls}">
      <div>
        <div class="ac-head">
          <b>${esc(a.name)}</b>
          <span class="pill ghost">${esc(a.label)}</span>
          ${a.alertOnly ? '<span class="pill blue">alert only</span>' : ''}
          ${a.invalid ? '<span class="pill red">invalid</span>' : ''}
          ${a.snoozeUntil && a.snoozeUntil > Date.now() ? '<span class="pill amber">snoozed</span>' : ''}
        </div>
        <div class="ac-sentence">${esc(a.sentence || a.invalid || '—')}</div>
        <div class="ac-meta">
          <span><b>Next</b> ${esc(next)}</span>
          <span><b>Last</b> ${a.lastRunAt ? esc(relTime(a.lastRunAt / 1000)) : 'never'}</span>
          ${a.lastMessage ? `<span><b>Result</b> ${esc(a.lastMessage)}</span>` : ''}
          <span><b>Author</b> ${esc(a.createdBy || '—')}</span>
        </div>
      </div>
      <div class="ac-actions">
        ${res}
        <label class="switch" title="${a.enabled ? 'Disarm' : 'Arm'}">
          <input type="checkbox" ${a.enabled ? 'checked' : ''} data-arm="${esc(a.id)}"
            aria-label="Armed: ${esc(a.name)}"><span></span></label>
        <button class="btn btn-sm" data-sim="${esc(a.id)}">Simulate</button>
        <button class="btn btn-sm" data-run="${esc(a.id)}">Run now</button>
        <button class="btn btn-sm" data-edit-auto="${esc(a.id)}">Edit</button>
        <button class="btn btn-sm btn-icon-sm" data-del-auto="${esc(a.id)}"
          aria-label="Delete ${esc(a.name)}" title="Delete ${esc(a.name)}">${iconHtml('trash')}</button>
      </div></div>`;
  }).join('');
}

function renderAutoEvents(events) {
  $('#autoEventCount').textContent = events.filter((e) => !e.acked).length;
  $('#autoEvents').innerHTML = events.length ? events.map((e) => {
    let detail = '';
    try { const d = JSON.parse(e.detail || 'null'); if (d) detail = Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  '); } catch { detail = ''; }
    return `<div class="tl-item"><span class="tl-dot ${esc(e.level)}"></span><div class="tl-body">
      <b>${esc(e.title)}</b><span>${esc(relTime(e.ts / 1000))}${e.acked ? '' : ' · unread'}</span>
      ${detail ? `<span class="tl-detail">${esc(detail)}</span>` : ''}</div></div>`;
  }).join('') : `<div class="empty-state"><span class="es-ico">${iconHtml('radar', 20)}</span><b>Nothing recorded</b><span>Automation activity and alerts appear here.</span></div>`;
}

function renderAutoRuns(runs) {
  $('#autoRuns tbody').innerHTML = runs.length ? runs.map((r) => {
    let d = '';
    try { const j = JSON.parse(r.detail || 'null'); d = j?.state || j?.reason || j?.would || (j ? JSON.stringify(j).slice(0, 90) : ''); } catch { d = ''; }
    return `<tr><td class="mono">${esc(relTime(r.started_at / 1000))}</td>
      <td class="trunc" title="${esc(r.auto_name || '')}">${esc(r.auto_name || '—')}</td>
      <td class="mono">${esc(r.source || '')}${r.actor ? ` <span class="dim">${esc(r.actor)}</span>` : ''}</td>
      <td><span class="pill ${r.outcome === 'ok' ? 'green' : r.outcome === 'failed' ? 'red' : r.outcome === 'simulated' ? 'blue' : 'amber'}">${esc(r.outcome)}</span></td>
      <td class="cmt trunc" title="${esc(r.error || d)}">${esc(r.error || d)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">No runs recorded</td></tr>';
}

// --- builder ---------------------------------------------------------------
function abOpen(kind, existing) {
  const meta = (autoData.kinds || []).find((k) => k.key === kind);
  if (!meta) return;
  const fields = KIND_FIELDS[kind] || [];
  const config = existing ? { ...existing.config } : {};
  for (const f of fields) if (config[f.k] === undefined && f.def !== undefined) config[f.k] = Array.isArray(f.def) ? [...f.def] : f.def;
  abDraft = { kind, id: existing?.id || null, name: existing?.name || meta.label, config };
  $('#abTitle').textContent = existing ? `Edit · ${existing.name}` : meta.label;
  $('#abBlurb').textContent = meta.blurb;
  $('#abRole').textContent = `requires ${meta.role}`;
  $('#abSave').textContent = existing ? 'Save Changes' : 'Save Disarmed';
  $('#abSimulate').hidden = !existing;
  $('#abMsg').textContent = '';
  $('#autoBuilder').hidden = false;
  abRenderFields();
  $('#autoBuilder').scrollIntoView({ block: 'nearest' });
  $('#abName')?.focus();
}
const abClose = () => { abDraft = null; $('#autoBuilder').hidden = true; };

function abRenderFields() {
  const groups = (allGroups.length ? allGroups : [{ id: 0, name: 'Default' }]);
  const f = KIND_FIELDS[abDraft.kind] || [];
  const c = abDraft.config;
  const html = [`<label class="pb-field"><span>Name</span>
      <input type="text" id="abName" value="${esc(abDraft.name)}" maxlength="120" /></label>`];
  for (const fl of f) {
    const v = c[fl.k];
    if (fl.t === 'group') {
      html.push(`<label class="pb-field"><span>${esc(fl.label)}</span><select data-ab="${fl.k}">
        <option value="">Select a group…</option>
        ${groups.map((g) => `<option value="${esc(g.name)}" ${g.name === v ? 'selected' : ''}>${esc(g.name)}${g.id === 0 ? ' (applies to everyone)' : ''}</option>`).join('')}
      </select></label>`);
    } else if (fl.t === 'device') {
      // Free text when the sidecar has not answered, so an existing rule can
      // still be edited while the router is down.
      html.push(autoDevices.length
        ? `<label class="pb-field"><span>${esc(fl.label)}</span><select data-ab="${fl.k}">
        <option value="">Select a device…</option>
        ${autoDevices.map((d) => `<option value="${esc(d.id)}" ${d.id === v ? 'selected' : ''}>${esc(d.label)}${d.id === 'gateway' ? ' — gateway, drops the whole network' : ''}</option>`).join('')}
      </select></label>`
        : `<label class="pb-field"><span>${esc(fl.label)}</span>
        <input type="text" data-ab="${fl.k}" value="${esc(v || '')}" placeholder="gateway" spellcheck="false" />
        <span class="hint">The router sidecar is not answering, so the device list is unavailable. Enter the id directly.</span></label>`);
    } else if (fl.t === 'days') {
      html.push(`<div class="pb-field"><span>${esc(fl.label)}</span><div class="check-grid">
        ${DOWS.map((d, i) => `<label class="${(v || []).includes(i) ? 'on' : ''}"><input type="checkbox" data-ab-day="${i}" ${(v || []).includes(i) ? 'checked' : ''}>${d}</label>`).join('')}
      </div></div>`);
    } else if (fl.t === 'time') {
      html.push(`<label class="pb-field"><span>${esc(fl.label)}</span><input type="time" data-ab="${fl.k}" value="${esc(v || '')}" /></label>`);
    } else if (fl.t === 'num') {
      html.push(`<label class="pb-field"><span>${esc(fl.label)}</span><input type="number" data-ab="${fl.k}" value="${esc(String(v ?? ''))}" min="${fl.min}" max="${fl.max}" /></label>`);
    } else if (fl.t === 'bool') {
      html.push(`<div class="pb-field"><span>${esc(fl.label)}</span>
        <label class="switch"><input type="checkbox" data-ab-bool="${fl.k}" ${v ? 'checked' : ''} aria-label="${esc(fl.label)}"><span></span></label></div>`);
    }
  }
  $('#abFields').innerHTML = html.join('');
  abInspect();
}

const abInspect = debounce(async () => {
  if (!abDraft) return;
  try {
    const d = await autoApi('/inspect', { method: 'POST', body: { kind: abDraft.kind, config: abDraft.config } });
    $('#abSentence').textContent = d.valid ? (d.sentence || '—') : (d.message || 'Incomplete');
    $('#abSentence').classList.toggle('invalid', !d.valid);
    $('#abSave').disabled = !d.valid;
    const notes = d.valid ? (d.notes || []) : [['err', d.message]];
    $('#abNotes').innerHTML = notes.map(([k, t]) =>
      `<p class="pb-note ${k === 'err' ? 'err' : k === 'warn' ? 'warn' : 'info'}">`
      + `<span class="vh">${k === 'err' ? 'Error: ' : k === 'warn' ? 'Warning: ' : 'Note: '}</span>${esc(t)}</p>`).join('');
    const errs = notes.filter(([k]) => k === 'err').length;
    const warns = notes.filter(([k]) => k === 'warn').length;
    $('#abStatus').textContent = d.valid
      ? `${d.sentence}. ${errs ? `${errs} error. ` : ''}${warns ? `${warns} warning. ` : ''}`
      : d.message;
  } catch (e) {
    $('#abSentence').textContent = `Could not run the checks: ${e.message}`;
    $('#abSave').disabled = true;
  }
}, 260);

$('#abFields').addEventListener('input', (e) => {
  if (!abDraft) return;
  const t = e.target;
  if (t.id === 'abName') { abDraft.name = t.value; return; }
  const key = t.dataset.ab;
  if (key) {
    abDraft.config[key] = t.type === 'number' ? Number(t.value) : t.value;
    abInspect(); return;
  }
});
$('#abFields').addEventListener('change', (e) => {
  if (!abDraft) return;
  const t = e.target;
  if (t.dataset.abDay !== undefined) {
    const f = (KIND_FIELDS[abDraft.kind] || []).find((x) => x.t === 'days');
    if (!f) return;
    const set = new Set(abDraft.config[f.k] || []);
    const i = Number(t.dataset.abDay);
    if (t.checked) set.add(i); else set.delete(i);
    abDraft.config[f.k] = [...set].sort((a, b) => a - b);
    t.closest('label')?.classList.toggle('on', t.checked);
    abInspect();
  } else if (t.dataset.abBool) {
    abDraft.config[t.dataset.abBool] = t.checked;
    abInspect();
  }
});
$('#abCancel').addEventListener('click', abClose);

$('#abSave').addEventListener('click', async () => {
  if (!abDraft) return;
  const msg = $('#abMsg');
  try {
    if (abDraft.id) {
      await autoApi(`/${abDraft.id}`, { method: 'PUT', body: { name: abDraft.name, config: abDraft.config } });
      toast('Automation updated', 'ok');
    } else {
      await autoApi('/', { method: 'POST', body: { kind: abDraft.kind, name: abDraft.name, config: abDraft.config } });
      toast('Saved. Arm it with the switch when you are ready.', 'ok');
    }
    abClose();
    loadAutomation();
  } catch (e) { msg.textContent = `Could not save: ${e.message}`; msg.className = 'hint error'; }
});

$('#abSimulate').addEventListener('click', async () => {
  if (!abDraft?.id) return;
  const msg = $('#abMsg');
  try {
    const d = await autoApi(`/${abDraft.id}/run`, { method: 'POST', body: { simulate: true } });
    msg.textContent = `Simulated: it would ${d.would}. Nothing was changed.`;
    msg.className = 'hint ok';
    loadAutoJournal();
  } catch (e) { msg.textContent = `Could not simulate: ${e.message}`; msg.className = 'hint error'; }
});

// --- list interactions ----------------------------------------------------
$('#autoTemplates').addEventListener('click', (e) => {
  const b = e.target.closest('[data-new-kind]');
  if (b) abOpen(b.dataset.newKind, null);
});

$('#autoList').addEventListener('click', async (e) => {
  const find = (id) => (autoData.automations || []).find((a) => a.id === id);
  const ed = e.target.closest('[data-edit-auto]');
  if (ed) { const a = find(ed.dataset.editAuto); if (a) abOpen(a.kind, a); return; }
  const sim = e.target.closest('[data-sim]');
  if (sim) {
    try { const d = await autoApi(`/${sim.dataset.sim}/run`, { method: 'POST', body: { simulate: true } });
      toast(`Would ${d.would}. Nothing changed.`, 'ok'); loadAutoJournal();
    } catch (err) { toast(`Could not simulate: ${err.message}`, 'err'); }
    return;
  }
  const run = e.target.closest('[data-run]');
  if (run) {
    const a = find(run.dataset.run);
    if (!(await confirmDialog(`Run "${a?.name}" now?`, { title: 'Run automation', yes: 'Run' }))) return;
    run.disabled = true;
    try { await autoApi(`/${run.dataset.run}/run`, { method: 'POST', body: {} }); toast('Completed', 'ok'); }
    catch (err) { toast(`Could not run it: ${err.message}`, 'err'); }
    finally { run.disabled = false; loadAutomation(); }
    return;
  }
  const del = e.target.closest('[data-del-auto]');
  if (del) {
    const a = find(del.dataset.delAuto);
    if (!(await confirmDialog(`Delete "${a?.name}"? Its run history is kept.`, { title: 'Delete automation', yes: 'Delete' }))) return;
    try { await autoApi(`/${del.dataset.delAuto}`, { method: 'DELETE' }); toast('Deleted', 'ok'); loadAutomation(); }
    catch (err) { toast(`Could not delete it: ${err.message}`, 'err'); }
  }
});

$('#autoList').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-arm]');
  if (!t) return;
  const a = (autoData.automations || []).find((x) => x.id === t.dataset.arm);
  // Arming is the moment the rule gains the ability to act, so it is confirmed
  // with the blast radius spelled out rather than being a silent toggle.
  if (t.checked) {
    const ok = await confirmDialog(`${a?.sentence || 'This automation will begin running.'}\n\nArm it now?`,
      { title: `Arm "${a?.name}"`, yes: 'Arm' });
    if (!ok) { t.checked = false; return; }
  }
  try {
    await autoApi(`/${t.dataset.arm}/enabled`, { method: 'POST', body: { enabled: t.checked } });
    toast(t.checked ? 'Armed' : 'Disarmed', 'ok');
  } catch (err) { toast(`Could not change it: ${err.message}`, 'err'); }
  loadAutomation();
});

$('#autoAckBtn').addEventListener('click', async () => {
  try {
    const d = await autoApi('/events?limit=200');
    const ids = (d.events || []).filter((e) => !e.acked).map((e) => e.id);
    if (!ids.length) { toast('Nothing to acknowledge'); return; }
    await autoApi('/events/ack', { method: 'POST', body: { ids } });
    toast(`Acknowledged ${ids.length}`, 'ok');
    loadAutomation();
  } catch (e) { toast(`Could not acknowledge: ${e.message}`, 'err'); }
});

$('#autoPanicBtn').addEventListener('click', async () => {
  const ok = await confirmDialog(
    'This disarms every automation, switches the engine off, and asserts that filtering is enabled. Use it if an automation is misbehaving.',
    { title: 'Emergency stop', yes: 'Stop everything' });
  if (!ok) return;
  try {
    const d = await autoApi('/panic', { method: 'POST', body: {} });
    // Report honestly: a partial failure is not a success.
    const failed = (d.steps || []).filter((x) => !x.ok);
    if (failed.length) toast(`Automation stopped, but ${failed.map((f) => f.step).join('; ')} failed`, 'err');
    else toast(`Stopped. ${d.disarmed} automation(s) disarmed.`, 'ok');
    loadAutomation();
  } catch (e) { toast(`Could not stop automation: ${e.message}`, 'err'); }
});

$('#autoSettingsBtn').addEventListener('click', async () => {
  let cur = {};
  try { cur = await autoApi('/settings'); } catch { /* fall back to blanks */ }
  $('#editTitle').textContent = 'Engine Settings';
  $('#editBody').innerHTML = `
    <div class="field"><label for="agTz">Time zone (IANA)</label>
      <input id="agTz" type="text" value="${esc(cur.tz || 'UTC')}" placeholder="Asia/Kolkata" spellcheck="false"></div>
    <div class="field"><label for="agHook">Alert webhook (optional)</label>
      <input id="agHook" type="text" value="" placeholder="${cur.webhookSet ? `configured for ${esc(cur.webhookHost)} — blank keeps it` : 'https://hooks.slack.com/…'}" spellcheck="false">
      <p class="hint">Alerts are POSTed as JSON. Loopback and link-local addresses are refused.</p></div>
    <div class="field"><label>Engine</label>
      <label class="switch"><input type="checkbox" id="agOn" ${cur.enabled ? 'checked' : ''} aria-label="Engine armed"><span></span></label>
      <p class="hint">Turning this off stops all scheduled work. Individual automations keep their own armed state.</p></div>`;
  $('#editModal').classList.add('show');
  $('#editSave').onclick = async () => {
    const body = { tz: $('#agTz').value.trim(), enabled: $('#agOn').checked };
    const hook = $('#agHook').value.trim();
    if (hook) body.webhookUrl = hook;
    try {
      await autoApi('/settings', { method: 'POST', body });
      $('#editModal').classList.remove('show');
      toast('Engine settings saved', 'ok');
      loadAutomation();
    } catch (e) { toast(`Could not save: ${e.message}`, 'err'); }
  };
});

loaders.automation = guard(loadAutomation);

// ===========================================================================
//  Profile — self-service for every role, including reader.
//
//  `role` is never sent from here. The server strips it too, so this is defence
//  in depth rather than the only guard: a self-service endpoint that accepted a
//  role from its own body would let a reader promote themselves to admin.
// ===========================================================================
let myProfile = null;

const initials = (p) => {
  const src = (p?.displayName || p?.nickname || p?.username || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
};

// Cache-bust on update, or the browser keeps serving the previous photo from the
// 30s private cache the route sets.
let avatarRev = Date.now();
function paintAvatar(el, p, label) {
  if (!el) return;
  if (p?.hasAvatar) {
    el.innerHTML = `<img src="/auth/avatar/${encodeURIComponent(p.username)}?r=${avatarRev}" alt="">`;
  } else {
    el.textContent = initials(p);
  }
  if (label) el.setAttribute('aria-label', label);
}

async function loadProfile() {
  try {
    myProfile = (await getJson('/auth/profile')).profile;
  } catch (e) {
    $('#pfMsg').textContent = `Could not load your profile: ${e.message}`;
    $('#pfMsg').className = 'hint error';
    return;
  }
  const p = myProfile;
  $('#pfName').value = p.displayName;
  $('#pfNick').value = p.nickname;
  $('#pfDob').value = p.dob;
  $('#pfTitle').value = p.title;
  $('#pfLoc').value = p.location;
  $('#pfTz').value = p.timezone;
  paintAvatar($('#pfAvatar'), p, p.hasAvatar ? 'Your profile photo' : `Your initials, ${initials(p)}`);
  $('#pfRemove').disabled = !p.hasAvatar;
  $('#pfAccount').innerHTML = [
    ['Username', p.username],
    ['Role', p.role],
    ['Member since', p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'],
    ['Last sign-in', p.lastLogin ? relTime(new Date(p.lastLogin).getTime() / 1000) : 'never'],
    ['Profile updated', p.updatedAt ? relTime(new Date(p.updatedAt).getTime() / 1000) : 'never'],
    ['Photo', p.hasAvatar ? `${Math.round(p.avatarBytes / 1024)} KB` : 'none'],
  ].map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
  // keep the header chip in step
  paintAvatar($('#whoAvatar'), p, `Signed in as ${p.displayName || p.username}, ${p.role}`);
  if (p.displayName) $('#whoName').textContent = p.displayName;
}
loaders.profile = guard(loadProfile);

$('#pfForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#pfMsg');
  const body = {
    displayName: $('#pfName').value, nickname: $('#pfNick').value,
    dob: $('#pfDob').value, title: $('#pfTitle').value,
    location: $('#pfLoc').value, timezone: $('#pfTz').value,
  };
  try {
    const r = await fetch('/auth/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);
    myProfile = d.profile;
    msg.textContent = 'Profile saved.'; msg.className = 'hint ok';
    loadProfile();
  } catch (err) { msg.textContent = `Could not save: ${err.message}`; msg.className = 'hint error'; }
});

$('#pfFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const msg = $('#pfPhotoMsg');
  if (!file) return;
  // A client-side check for a fast, clear error only. The server re-validates by
  // magic bytes and is the actual authority.
  if (file.size > 512 * 1024) {
    msg.textContent = `That image is ${Math.round(file.size / 1024)} KB. The limit is 512 KB.`;
    msg.className = 'hint error'; e.target.value = ''; return;
  }
  msg.textContent = 'Uploading…'; msg.className = 'hint';
  try {
    const r = await fetch('/auth/avatar', { method: 'POST', body: file });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);
    avatarRev = Date.now();
    msg.textContent = `Photo updated (${Math.round(d.bytes / 1024)} KB).`;
    msg.className = 'hint ok';
    loadProfile();
  } catch (err) {
    msg.textContent = `Could not upload: ${err.message}`; msg.className = 'hint error';
  } finally { e.target.value = ''; }
});

$('#pfRemove').addEventListener('click', async () => {
  if (!(await confirmDialog('Remove your profile photo?', { title: 'Remove photo', yes: 'Remove' }))) return;
  try {
    const r = await fetch('/auth/avatar', { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    avatarRev = Date.now();
    $('#pfPhotoMsg').textContent = 'Photo removed.'; $('#pfPhotoMsg').className = 'hint ok';
    loadProfile();
  } catch (err) { toast(`Could not remove the photo: ${err.message}`, 'err'); }
});

// The header identity chip is a shortcut into this page.
$('#whoami')?.addEventListener('click', () => activateSection('profile'));

// ===========================================================================
//  Command palette — a combobox controlling a listbox (ARIA APG pattern)
// ===========================================================================
let cpItems = [], cpIndex = 0, cpPrevFocus = null;

function cpCommands() {
  const out = Object.entries(titles).map(([sec, label]) => ({
    id: `go:${sec}`, name: label, tag: 'Go to', icon: 'search',
    run: () => activateSection(sec),
  }));
  out.push(
    { id: 'act:block-off', name: 'Disable filtering for 5 minutes', tag: 'Action', icon: 'shield',
      run: () => setBlocking(false, 300) },
    { id: 'act:block-on', name: 'Enable filtering', tag: 'Action', icon: 'shield',
      run: () => setBlocking(true, null) },
    { id: 'act:gravity', name: 'Refresh filter lists now', tag: 'Action', icon: 'refresh',
      run: async () => {
        if (!(await confirmDialog('Refresh every filter list now? This takes a few minutes.', { title: 'Refresh filter lists', yes: 'Refresh' }))) return;
        toast('Refreshing filter lists…');
        try { await api('action/gravity', { method: 'POST' }); toast('Filter lists refreshed', 'ok'); }
        catch (e) { toast(`Could not refresh: ${e.message}`, 'err'); }
      } },
    { id: 'act:backup', name: 'Download a configuration backup', tag: 'Action', icon: 'save',
      run: () => { window.location.href = '/manager/teleporter/export'; } },
    { id: 'act:theme', name: 'Switch between light and dark', tag: 'Action', icon: 'bolt',
      run: () => $('#themeBtn')?.click() },
    { id: 'act:panic', name: 'Emergency stop all automation', tag: 'Action', icon: 'bolt',
      run: () => { activateSection('automation'); setTimeout(() => $('#autoPanicBtn')?.click(), 120); } },
    { id: 'act:keys', name: 'Show keyboard shortcuts', tag: 'Help', icon: 'search', run: showShortcuts },
  );
  return out;
}

// Subsequence match, so "nwmp" finds "Network Map". Ranked: prefix beats
// word-start beats scattered.
function cpScore(name, query) {
  // Normalise here rather than trusting the caller: relying on cpRender to
  // pre-lowercase made the function silently case-sensitive for anyone else.
  const q = String(query ?? '').toLowerCase();
  if (!q) return 1;
  const n = String(name).toLowerCase();
  if (n.startsWith(q)) return 1000;
  const wi = n.split(/\s+/).map((w) => w[0]).join('');
  if (wi.startsWith(q)) return 900;
  if (n.includes(q)) return 700 - n.indexOf(q);
  let i = 0;
  for (const ch of q) { i = n.indexOf(ch, i) + 1; if (i === 0) return 0; }
  return 300;
}

function cpRender() {
  const q = $('#cpInput').value.trim().toLowerCase();
  cpItems = cpCommands()
    .map((c) => ({ ...c, s: cpScore(c.name, q) }))
    .filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40);
  if (cpIndex >= cpItems.length) cpIndex = 0;
  $('#cpList').innerHTML = cpItems.length ? cpItems.map((c, i) => `
    <li class="cp-item" role="option" id="cp-${i}" aria-selected="${i === cpIndex}" data-i="${i}">
      ${iconHtml(c.icon, 14)}<span class="cp-name">${esc(c.name)}</span><span class="cp-tag">${esc(c.tag)}</span>
    </li>`).join('') : '<li class="cp-empty" role="option" aria-selected="false">No matches</li>';
  $('#cpInput').setAttribute('aria-activedescendant', cpItems.length ? `cp-${cpIndex}` : '');
  $(`#cp-${cpIndex}`)?.scrollIntoView({ block: 'nearest' });
}

function cpOpen() {
  if (!$('#cpBack').hidden) return;
  cpPrevFocus = document.activeElement;
  $('#cpBack').hidden = false;
  $('#cpInput').value = '';
  cpIndex = 0;
  cpRender();
  $('#cpInput').focus();
}
function cpClose() {
  if ($('#cpBack').hidden) return;
  $('#cpBack').hidden = true;
  // Return focus where it was, or the palette leaves the tab order at <body>.
  if (cpPrevFocus?.isConnected) cpPrevFocus.focus();
  cpPrevFocus = null;
}
$('#cpInput').addEventListener('input', () => { cpIndex = 0; cpRender(); });
$('#cpInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cpIndex = (cpIndex + 1) % Math.max(cpItems.length, 1); cpRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cpIndex = (cpIndex - 1 + cpItems.length) % Math.max(cpItems.length, 1); cpRender(); }
  else if (e.key === 'Home') { e.preventDefault(); cpIndex = 0; cpRender(); }
  else if (e.key === 'End') { e.preventDefault(); cpIndex = Math.max(cpItems.length - 1, 0); cpRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); const c = cpItems[cpIndex]; if (c) { cpClose(); c.run(); } }
  else if (e.key === 'Escape') { e.preventDefault(); cpClose(); }
});
$('#cpList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-i]');
  if (!li) return;
  const c = cpItems[Number(li.dataset.i)];
  if (c) { cpClose(); c.run(); }
});
$('#cpBack').addEventListener('mousedown', (e) => { if (e.target === $('#cpBack')) cpClose(); });

// --- global keyboard layer ------------------------------------------------
const SHORTCUTS = [
  ['Ctrl / ⌘ + K', 'Open the command palette'],
  ['?', 'Show this list'],
  ['G then O', 'Overview'],
  ['G then A', 'Automation'],
  ['G then D', 'Domains'],
  ['G then Q', 'Query Log'],
  ['G then M', 'Network Map'],
  ['G then I', 'Insights'],
  ['Escape', 'Close a dialog or the palette'],
];
function showShortcuts() {
  $('#scGrid').innerHTML = SHORTCUTS.map(([k, d]) => `<div class="sc-row"><span>${esc(d)}</span><kbd>${esc(k)}</kbd></div>`).join('');
  $('#scModal').classList.add('show');
}
$('#scClose').addEventListener('click', () => $('#scModal').classList.remove('show'));

const GO_KEYS = { o: 'overview', a: 'automation', d: 'domains', q: 'queries', m: 'mesh', i: 'insights', c: 'clients', g: 'gateway', s: 'settings' };
let goArmed = 0;
const typingIn = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

document.addEventListener('keydown', (e) => {
  if (e.key === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cpOpen(); return; }
  if (e.key === 'Escape') {
    if (!$('#cpBack').hidden) { cpClose(); return; }
    // Escape must close whichever dialog is open — none of them had it before.
    for (const id of ['#scModal', '#editModal', '#confirmModal']) {
      const m = $(id);
      if (m?.classList.contains('show')) { m.classList.remove('show'); return; }
    }
    return;
  }
  if (typingIn(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
  if (e.key === 'g' || e.key === 'G') { goArmed = Date.now(); return; }
  if (goArmed && Date.now() - goArmed < 1500) {
    const sec = GO_KEYS[e.key.toLowerCase()];
    goArmed = 0;
    if (sec && titles[sec]) { e.preventDefault(); activateSection(sec); }
  }
});

// ===========================================================================
//  Filter lists (adlists)
// ===========================================================================
async function loadLists() {
  try {
    const lists = (await api('lists')).lists || []; $('#listCount').textContent = lists.length;
    $('#listsTable tbody').innerHTML = lists.length ? lists.map((l) => `
      <tr><td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis">${esc(l.address)}</td>
        <td><span class="pill ${l.type === 'allow' ? 'green' : 'blue'}">${esc(l.type)}</span></td>
        <td class="mono num">${fmt(l.number ?? 0)}</td><td class="dim">${esc(l.comment || '')}</td>
        <td><label class="switch"><input type="checkbox" ${l.enabled ? 'checked' : ''} data-tog-list="${esc(l.address)}" data-type="${l.type}"><span></span></label></td>
        <td><button class="btn btn-sm btn-icon-sm" data-del-list="${esc(l.address)}" data-type="${l.type}" aria-label="Delete ${esc(l.address)}" title="Delete ${esc(l.address)}">${iconHtml('trash')}</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">No lists</td></tr>';
  } catch (e) { toast(`Could not load filter lists: ${e.message}`, 'err'); }
}
$('#addListBtn').addEventListener('click', async () => {
  const address = $('#listInput').value.trim(), type = $('#listType').value, comment = $('#listComment').value.trim();
  const msg = $('#listMsg');
  if (!address) { msg.textContent = 'Enter a URL.'; msg.className = 'hint error'; return; }
  try {
    await api('lists', { method: 'POST', body: { address, type, comment: comment || 'Added via Manager', enabled: true, groups: [0] } });
    msg.textContent = 'Added — run Update Gravity to apply.'; msg.className = 'hint ok'; $('#listInput').value = ''; $('#listComment').value = ''; loadLists();
  } catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});
$('#listsTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-list]'); if (!b) return;
  if (!(await confirmDialog(`Delete list?\n${b.dataset.delList}`, { title: 'Delete adlist', yes: 'Delete' }))) return;
  try { await api(`lists/${encodeURIComponent(b.dataset.delList)}?type=${b.dataset.type}`, { method: 'DELETE' }); toast('Deleted — run gravity', 'ok'); loadLists(); }
  catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
});
$('#listsTable').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-tog-list]'); if (!t) return;
  try { await api(`lists/${encodeURIComponent(t.dataset.togList)}?type=${t.dataset.type}`, { method: 'PUT', body: { enabled: t.checked, groups: [0] } }); toast(t.checked ? 'Enabled' : 'Disabled', 'ok'); }
  catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); loadLists(); }
});
async function updateGravity(btn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '⟳ Updating…'; toast('Updating gravity — up to a minute…');
  try { await api('action/gravity', { method: 'POST' }); toast('Gravity updated', 'ok'); if ($('#s-lists').classList.contains('active')) loadLists(); }
  catch (e) { toast(`Gravity failed: ${e.message}`, 'err'); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
$('#gravityBtn').addEventListener('click', (e) => updateGravity(e.target));

// ===========================================================================
//  Groups
// ===========================================================================
let allGroups = [];
async function loadGroups() {
  try {
    allGroups = (await api('groups')).groups || [];
    $('#groupsTable tbody').innerHTML = allGroups.map((g) => `
      <tr><td>${esc(g.name)}</td><td class="dim">${esc(g.comment || '')}</td>
        <td><label class="switch"><input type="checkbox" ${g.enabled ? 'checked' : ''} data-tog-group="${esc(g.name)}"><span></span></label></td>
        <td>${g.id === 0 ? '' : `<button class="btn btn-sm btn-icon-sm" data-del-group="${esc(g.name)}" aria-label="Delete group ${esc(g.name)}" title="Delete group ${esc(g.name)}">${iconHtml('trash')}</button>`}</td></tr>`).join('');
  } catch (e) { toast(`Could not load groups: ${e.message}`, 'err'); }
}
$('#addGroupBtn').addEventListener('click', async () => {
  const name = $('#groupName').value.trim(), comment = $('#groupComment').value.trim(), msg = $('#groupMsg');
  if (!name) { msg.textContent = 'Enter a name.'; msg.className = 'hint error'; return; }
  try { await api('groups', { method: 'POST', body: { name, comment, enabled: true } }); msg.textContent = `Added ${name}`; msg.className = 'hint ok'; $('#groupName').value = ''; $('#groupComment').value = ''; loadGroups(); }
  catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});
$('#groupsTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-group]'); if (!b) return;
  if (!(await confirmDialog(`Delete group ${b.dataset.delGroup}?`, { title: 'Delete group', yes: 'Delete' }))) return;
  try { await api(`groups/${encodeURIComponent(b.dataset.delGroup)}`, { method: 'DELETE' }); toast('Deleted', 'ok'); loadGroups(); }
  catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
});
$('#groupsTable').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-tog-group]'); if (!t) return;
  const g = allGroups.find((x) => x.name === t.dataset.togGroup);
  try { await api(`groups/${encodeURIComponent(t.dataset.togGroup)}`, { method: 'PUT', body: { name: g.name, comment: g.comment, enabled: t.checked } }); toast(t.checked ? 'Enabled' : 'Disabled', 'ok'); }
  catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); loadGroups(); }
});

// ===========================================================================
//  Clients
// ===========================================================================
let allClients = [];
async function loadClients() {
  const tbody = $('#clientsTable tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
  const [groupsR, clientsR] = await Promise.allSettled([api('groups'), api('clients')]);
  await loadIdentity();
  if (clientsR.status !== 'fulfilled') {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">Could not load clients — ${esc(clientsR.reason?.message || 'error')}</td></tr>`;
    toast('Could not load configured clients', 'err');
    return;
  }
  if (groupsR.status === 'fulfilled') allGroups = groupsR.value.groups || [];
  const gmap = {}; allGroups.forEach((g) => (gmap[g.id] = g.name));

  allClients = clientsR.value.clients || [];
  if (!allClients.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">No clients configured</td></tr>'; return; }
  tbody.innerHTML = allClients.map((c) => {
    const resolved = nameForClientId(c.client);
    const friendly = c.name || (resolved !== c.client ? resolved : '');
    const label = friendly ? `${esc(friendly)} <span class="dim mono">${esc(c.client)}</span>` : `<span class="mono">${esc(c.client)}</span>`;
    return `<tr><td>${label}</td><td class="dim">${esc(c.comment || '')}</td>
      <td>${(c.groups || []).map((id) => `<span class="pill violet">${esc(gmap[id] ?? id)}</span>`).join(' ')}</td>
      <td><button class="btn btn-sm" data-edit-client="${esc(c.client)}">Groups</button> <button class="btn btn-sm btn-icon-sm" data-del-client="${esc(c.client)}" aria-label="Delete client ${esc(c.client)}" title="Delete client ${esc(c.client)}">${iconHtml('trash')}</button></td></tr>`;
  }).join('');
}
$('#addClientBtn').addEventListener('click', async () => {
  const client = $('#clientId').value.trim(), comment = $('#clientComment').value.trim(), msg = $('#clientMsg');
  if (!client) { msg.textContent = 'Enter a client.'; msg.className = 'hint error'; return; }
  try { await api('clients', { method: 'POST', body: { client, comment, groups: [0] } }); msg.textContent = `Added ${client}`; msg.className = 'hint ok'; $('#clientId').value = ''; $('#clientComment').value = ''; loadClients(); }
  catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});
$('#clientsTable').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-client]'), edit = e.target.closest('[data-edit-client]');
  if (del) {
    if (!(await confirmDialog(`Delete client ${del.dataset.delClient}?`, { title: 'Delete client', yes: 'Delete' }))) return;
    try { await api(`clients/${encodeURIComponent(del.dataset.delClient)}`, { method: 'DELETE' }); toast('Deleted', 'ok'); loadClients(); }
    catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
  } else if (edit) {
    const c = allClients.find((x) => x.client === edit.dataset.editClient); openClientGroups(c);
  }
});
function openClientGroups(c) {
  $('#editTitle').textContent = `Groups · ${c.name || c.client}`;
  $('#editBody').innerHTML = `<div class="check-grid">${allGroups.map((g) => `
    <label class="${(c.groups || []).includes(g.id) ? 'on' : ''}"><input type="checkbox" value="${g.id}" ${(c.groups || []).includes(g.id) ? 'checked' : ''}>${esc(g.name)}</label>`).join('')}</div>`;
  $$('#editBody .check-grid label').forEach((l) => l.querySelector('input').addEventListener('change', (ev) => l.classList.toggle('on', ev.target.checked)));
  $('#editModal').classList.add('show');
  $('#editSave').onclick = async () => {
    const groups = [...$$('#editBody input:checked')].map((i) => Number(i.value));
    try { await api(`clients/${encodeURIComponent(c.client)}`, { method: 'PUT', body: { comment: c.comment || '', groups: groups.length ? groups : [0] } }); toast('Updated', 'ok'); $('#editModal').classList.remove('show'); loadClients(); }
    catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
  };
}
$('#editCancel').addEventListener('click', () => $('#editModal').classList.remove('show'));

// ===========================================================================
//  Local DNS (A/AAAA hosts + CNAME)
// ===========================================================================
async function loadLocalDns() {
  const [hostsR, cnameR] = await Promise.allSettled([api('config/dns/hosts'), api('config/dns/cnameRecords')]);
  if (hostsR.status === 'fulfilled') {
    const hosts = hostsR.value.config?.dns?.hosts || [];
    $('#hostsTable tbody').innerHTML = hosts.length ? hosts.map((h) => {
      const [ip, ...rest] = h.split(/\s+/); const name = rest.join(' ');
      return `<tr><td class="mono">${esc(ip)}</td><td class="mono">${esc(name)}</td><td><button class="btn btn-sm btn-icon-sm" data-del-host="${esc(h)}" aria-label="Delete host record ${esc(name)}" title="Delete host record ${esc(name)}">${iconHtml('trash')}</button></td></tr>`;
    }).join('') : '<tr><td colspan="3" class="empty">No records</td></tr>';
  } else toast(`Could not load local DNS records: ${hostsR.reason?.message}`, 'err');
  if (cnameR.status === 'fulfilled') {
    const cn = cnameR.value.config?.dns?.cnameRecords || [];
    $('#cnameTable tbody').innerHTML = cn.length ? cn.map((c) => {
      const [dom, target] = c.split(','); return `<tr><td class="mono">${esc(dom)}</td><td class="mono">${esc(target)}</td><td><button class="btn btn-sm btn-icon-sm" data-del-cname="${esc(c)}" aria-label="Delete CNAME ${esc(dom)}" title="Delete CNAME ${esc(dom)}">${iconHtml('trash')}</button></td></tr>`;
    }).join('') : '<tr><td colspan="3" class="empty">No records</td></tr>';
  } else toast(`Could not load CNAME records: ${cnameR.reason?.message}`, 'err');
}
$('#addHostBtn').addEventListener('click', async () => {
  const ip = $('#hostIp').value.trim(), name = $('#hostName').value.trim(), msg = $('#hostMsg');
  if (!ip || !name) { msg.textContent = 'IP and hostname required.'; msg.className = 'hint error'; return; }
  try { await cfgPut('dns/hosts', `${ip} ${name}`); msg.textContent = 'Added'; msg.className = 'hint ok'; $('#hostIp').value = ''; $('#hostName').value = ''; loadLocalDns(); }
  catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});
$('#addCnameBtn').addEventListener('click', async () => {
  const dom = $('#cnameDomain').value.trim(), target = $('#cnameTarget').value.trim(), msg = $('#cnameMsg');
  if (!dom || !target) { msg.textContent = 'Alias and target required.'; msg.className = 'hint error'; return; }
  try { await cfgPut('dns/cnameRecords', `${dom},${target}`); msg.textContent = 'Added'; msg.className = 'hint ok'; $('#cnameDomain').value = ''; $('#cnameTarget').value = ''; loadLocalDns(); }
  catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});
$('#hostsTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-host]'); if (!b) return;
  try { await cfgDel('dns/hosts', b.dataset.delHost); toast('Deleted', 'ok'); loadLocalDns(); } catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
});
$('#cnameTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-cname]'); if (!b) return;
  try { await cfgDel('dns/cnameRecords', b.dataset.delCname); toast('Deleted', 'ok'); loadLocalDns(); } catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
});

// ===========================================================================
//  DHCP
// ===========================================================================
async function loadDhcp() {
  const [confR, leasesR] = await Promise.allSettled([api('config/dhcp'), api('dhcp/leases')]);
  if (confR.status === 'fulfilled') {
    const dhcp = confR.value.config?.dhcp || {};
    $('#dhcpStatus').innerHTML = dhcp.active ? '<span class="pill green">active</span>' : '<span class="pill gray">inactive</span>';
    $('#dhcpInfo').innerHTML = kv([
      ['Range', `${esc(dhcp.start || '—')} → ${esc(dhcp.end || '—')}`], ['Router', esc(dhcp.router || '—')],
      ['Netmask', esc(dhcp.netmask || '—')], ['Lease time', esc(dhcp.leaseTime || 'default')], ['IPv6', dhcp.ipv6 ? 'on' : 'off'],
    ]);
    const statics = dhcp.hosts || []; $('#staticCount').textContent = statics.length;
    $('#staticTable tbody').innerHTML = statics.length ? statics.map((s) => {
      const [mac, ip, name] = s.split(','); return `<tr><td class="mono">${esc(mac)}</td><td class="mono">${esc(ip)}</td><td>${esc(name || '')}</td><td><button class="btn btn-sm btn-icon-sm" data-del-static="${esc(s)}" aria-label="Delete static lease ${esc(mac)}" title="Delete static lease ${esc(mac)}">${iconHtml('trash')}</button></td></tr>`;
    }).join('') : '<tr><td colspan="4" class="empty">No static leases</td></tr>';
  } else toast(`Could not load DHCP configuration: ${confR.reason?.message}`, 'err');
  if (leasesR.status === 'fulfilled') {
    const leases = leasesR.value.leases || []; $('#leaseCount').textContent = leases.length;
    $('#leasesTable tbody').innerHTML = leases.length ? leases.map((l) => `<tr><td class="mono">${esc(l.ip)}</td><td>${esc(l.name || '')}</td><td class="mono dim">${esc(l.hwaddr)}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">No active leases</td></tr>';
  } else $('#leasesTable tbody').innerHTML = '<tr><td colspan="3" class="empty">Leases unavailable</td></tr>';
}
$('#addStaticBtn').addEventListener('click', async () => {
  const mac = $('#staticMac').value.trim(), ip = $('#staticIp').value.trim(), name = $('#staticName').value.trim(), msg = $('#staticMsg');
  if (!mac || !ip) { msg.textContent = 'MAC and IP required.'; msg.className = 'hint error'; return; }
  const val = [mac, ip, name].filter(Boolean).join(',');
  try { await cfgPut('dhcp/hosts', val); msg.textContent = 'Added'; msg.className = 'hint ok'; $('#staticMac').value = ''; $('#staticIp').value = ''; $('#staticName').value = ''; loadDhcp(); }
  catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});
$('#staticTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-static]'); if (!b) return;
  try { await cfgDel('dhcp/hosts', b.dataset.delStatic); toast('Deleted', 'ok'); loadDhcp(); } catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
});

// ===========================================================================
//  Gateway — router + internet health, correlated with Pi-hole
// ===========================================================================
async function loadGateway() {
  const [healthR, summaryR, ftlR] = await Promise.allSettled([
    getJson('/manager/gateway/health'), api('stats/summary'), api('info/ftl'),
  ]);
  const h = healthR.status === 'fulfilled' ? healthR.value : null;
  const active = summaryR.status === 'fulfilled' ? (summaryR.value.clients?.active ?? 0) : 0;
  const qfreq = ftlR.status === 'fulfilled' ? (ftlR.value.ftl?.query_frequency ?? 0) : 0;
  renderGateway(h, active, qfreq);
}

function renderGateway(h, active, qfreq) {
  const gw = h?.gateway || {}, inet = h?.internet || {};
  const inetUp = !!inet.up, gwUp = !!gw.up;

  $('#gwHeadline').innerHTML = [
    { cls: inetUp ? 'good' : 'bad', label: 'Internet', value: inetUp ? 'Online' : 'Offline', sub: inetUp ? `${inet.latency} ms · ${inet.loss}% loss` : 'unreachable' },
    { cls: gwUp ? 'hot' : 'bad', label: 'Gateway', value: gwUp ? `${gw.latency} ms` : 'Down', sub: `${esc(gw.model || 'router')} · ${esc(gw.host)}` },
    { cls: (inet.jitter ?? 99) < 15 ? 'good' : 'warn', label: 'WAN Jitter', value: `${inet.jitter ?? '—'} ms`, sub: 'link stability' },
    { cls: 'hot', label: 'Active Clients', value: fmt(active), sub: `${qfreq.toFixed(2)} queries/s` },
  ].map((c) => `<div class="insight-card ${c.cls}"><div class="ic-label">${c.label}</div><div class="ic-value">${c.value}</div><div class="ic-sub">${c.sub}</div></div>`).join('');

  const hops = [
    { name: 'Your Devices', ico: '📱', up: true, meta: `${active} online` },
    { name: 'Pi-hole', ico: '🛡️', up: true, meta: 'DNS filter' },
    { name: 'Router', ico: '📡', up: gwUp, meta: gwUp ? `${gw.latency} ms` : 'down' },
    { name: 'Internet', ico: '🌐', up: inetUp, meta: inetUp ? `${inet.latency} ms` : 'down' },
  ];
  $('#pathFlow').innerHTML = hops.map((hp, i) => {
    const hop = `<div class="hop ${hp.up ? 'up' : 'down'}"><div class="hop-ico">${hp.ico}</div><div class="hop-name">${hp.name}</div><div class="hop-meta">${esc(hp.meta)}</div></div>`;
    const link = i < hops.length - 1 ? `<div class="link ${hops[i + 1].up ? 'up' : 'down'}"></div>` : '';
    return hop + link;
  }).join('');
  $('#gwUpdated').textContent = new Date().toLocaleTimeString([], { hour12: false });

  $('#routerInfo').innerHTML = kv([
    ['Model', esc(gw.model || '—')], ['IP', esc(gw.host)],
    ['Status', gwUp ? '<span class="pill green">reachable</span>' : '<span class="pill red">down</span>'],
    ['Latency', gwUp ? `${gw.latency} ms (min ${gw.min} / max ${gw.max})` : '—'],
    ['Jitter', gwUp ? `${gw.jitter} ms` : '—'], ['Packet loss', `${gw.loss ?? '—'}%`],
  ]);
  $('#routerAdminLink').href = gw.webUrl || '#';

  const li = (level, title, desc) => `<div class="sec-item"><div class="sec-icon ${level}">${{ ok: '✓', warn: '!', bad: '✕' }[level]}</div><div class="sec-text"><b>${title}</b><span>${desc}</span></div></div>`;
  const gwLevel = !gwUp ? 'bad' : gw.latency < 20 ? 'ok' : gw.latency < 60 ? 'warn' : 'bad';
  $('#gwInsight').innerHTML = [
    li(inetUp ? 'ok' : 'bad', inetUp ? 'Internet reachable' : 'Internet unreachable', inetUp ? `Round-trip ${inet.latency} ms to 1.1.1.1, ${inet.loss}% loss.` : 'No route to the internet through the gateway.'),
    li(gwLevel, `Gateway latency ${gwUp ? gw.latency + ' ms' : 'unavailable'}`, gwLevel === 'ok' ? 'Gateway round-trip time is normal for a local network.' : gwLevel === 'warn' ? 'Round-trip time is elevated, which usually indicates load or wireless congestion.' : 'The gateway is slow to respond or unreachable and requires investigation.'),
    li((inet.jitter ?? 99) < 15 ? 'ok' : 'warn', `WAN jitter ${inet.jitter ?? '—'} ms`, (inet.jitter ?? 99) < 15 ? 'Latency is stable, suitable for voice and video traffic.' : 'Latency is variable, which may affect real-time applications.'),
    li('ok', `${active} active clients at ${qfreq.toFixed(2)} queries/s`, `All DNS traffic is filtered by Pi-hole and then routed through the ${esc(gw.model || 'gateway')} to the internet.`),
  ].join('');

  loadRouterTelemetry(active);
}

async function loadRouterTelemetry(active) {
  const badge = $('#routerLiveBadge'), body = $('#routerLiveBody'), fallback = $('#deepRouterInfo');
  try {
    const d = await getJson('/manager/router/status');
    if (!d.ok) throw new Error(d.message || d.error || 'unavailable');
    badge.innerHTML = '<span class="pill green">connected</span>';
    body.style.display = ''; fallback.innerHTML = '';

    const cpu = Math.round((d.cpu ?? 0) * 100), mem = Math.round((d.mem ?? 0) * 100);
    $('#routerGauges').innerHTML = '<div class="gauge" id="rg-cpu"></div><div class="gauge" id="rg-mem"></div>';
    gauge($('#rg-cpu'), cpu, 'CPU', 'var(--cyan)', `${cpu}%`);
    gauge($('#rg-mem'), mem, 'RAM', 'var(--violet)', `${mem}%`);

    $('#routerHw').innerHTML = kv([
      ['Model', esc(d.model || '—')], ['Firmware', esc((d.firmware || '—').split(' ').slice(0, 3).join(' '))],
      ['Hardware', esc(d.hardware || '—')], ['WAN IP', `<span class="mono">${esc(d.wan_ip || '—')}</span>`],
      ['WAN gateway', `<span class="mono">${esc(d.wan_gateway || '—')}</span>`], ['LAN MAC', `<span class="mono">${esc(d.lan_mac || '—')}</span>`],
    ]);
    $('#routerWifi').innerHTML = kv([
      ['Wi-Fi 2.4 GHz', d.wifi_2g ? '<span class="pill green">on</span>' : '<span class="pill gray">off</span>'],
      ['Wi-Fi 5 GHz', d.wifi_5g ? '<span class="pill green">on</span>' : '<span class="pill gray">off</span>'],
      ['Wi-Fi clients', fmt(d.wifi_clients_total)], ['Wired clients', fmt(d.wired_total)],
      ['Guest clients', fmt(d.guest_clients_total)], ['Total (router)', fmt(d.clients_total)],
    ]);

    (d.devices || []).forEach((dev) => {
      if (dev.ip && dev.hostname && dev.hostname !== 'Unknown' && !identity.byIp[dev.ip]) identity.byIp[dev.ip] = dev.hostname;
    });

    const routerCount = d.clients_total ?? (d.devices || []).length;
    const behind = Math.max(0, active - routerCount);
    const li = (lvl, t, s) => `<div class="sec-item"><div class="sec-icon ${lvl}">${{ ok: '✓', warn: '!', bad: '✕' }[lvl]}</div><div class="sec-text"><b>${t}</b><span>${s}</span></div></div>`;
    $('#routerCrossInsight').innerHTML = [
      li('ok', `Router sees ${routerCount} device(s), Pi-hole sees ${active} active`, behind ? `Approximately ${behind} device(s) are reached through a switch or access point, so the gateway sees only the uplink MAC address.` : 'The gateway and Pi-hole inventories are consistent.'),
      li(cpu < 70 ? 'ok' : 'warn', `Gateway load: CPU ${cpu}%, memory ${mem}%`, cpu < 70 ? 'Gateway resource use is within normal range.' : 'Gateway resource use is high; throughput may degrade.'),
      li('ok', 'Device names resolved', 'Hostnames reported by the gateway are used to label devices in Clients, Query Log and Insights.'),
    ].join('');

    drawRouterHistory();

    const devs = d.devices || []; $('#routerDevCount').textContent = devs.length;
    $('#routerDevTable tbody').innerHTML = devs.length ? devs.map((dev) => `
      <tr><td>${esc(dev.hostname && dev.hostname !== 'Unknown' ? dev.hostname : '—')}</td>
        <td class="mono">${esc(dev.ip || '')}</td><td class="mono dim">${esc(dev.mac || '')}</td>
        <td><span class="pill ${dev.type === 'wired' ? 'blue' : 'violet'}">${esc(dev.type || '')}</span></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No devices</td></tr>';
  } catch (e) {
    badge.innerHTML = '<span class="pill amber">Not configured</span>';
    body.style.display = 'none';
    fallback.innerHTML = kv([
      ['Device type', 'TP-Link gateway with encrypted login'],
      ['Status', `<span class="pill amber">${esc(e.message)}</span>`],
      ['Next step', 'Enter the gateway address and credentials in Admin, then select Test and save the configuration.'],
    ]);
  }
}

async function drawRouterHistory() {
  let hist = { samples: [], interval: 20 };
  try { hist = await getJson('/manager/router/history'); } catch { return; }
  const cv = $('#routerHistChart');
  if (!cv) return;
  const s = hist.samples || [];
  const { ctx, w, h } = prepCanvas(cv);
  const dim = cssVar('--muted', '#8090b5');

  $('#routerHistMeta').textContent = s.length
    ? `${s.length} samples · ${hist.interval}s interval` : 'collecting samples';

  const padL = 34, padR = 8, padT = 10, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  ctx.strokeStyle = cssVar('--grid', 'rgba(120,160,255,0.10)');
  ctx.fillStyle = dim; ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'right';
  [0, 25, 50, 75, 100].forEach((v) => {
    const y = Math.round(padT + plotH * (1 - v / 100)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    if (v % 50 === 0) ctx.fillText(`${v}%`, padL - 6, y + 3);
  });
  if (s.length < 2) {
    ctx.fillStyle = dim; ctx.textAlign = 'center';
    ctx.fillText('Collecting samples — the chart fills in over time', w / 2, h / 2);
    return;
  }
  const X = (i) => padL + (plotW * i) / (s.length - 1);
  const Y = (v) => padT + plotH * (1 - Math.max(0, Math.min(100, v)) / 100);
  const line = (key, hex) => {
    const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    g.addColorStop(0, hex + '44'); g.addColorStop(1, hex + '05');
    ctx.beginPath(); ctx.moveTo(X(0), padT + plotH);
    s.forEach((p, i) => ctx.lineTo(X(i), Y(p[key] || 0)));
    ctx.lineTo(X(s.length - 1), padT + plotH); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p[key] || 0)) : ctx.moveTo(X(i), Y(p[key] || 0))));
    ctx.strokeStyle = hex; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  };
  line('cpu', cssVar('--cyan', '#22d3ee'));
  line('mem', cssVar('--violet', '#a78bfa'));
  // newest-sample readout
  const last = s[s.length - 1];
  ctx.fillStyle = dim; ctx.textAlign = 'left'; ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillText(`CPU ${last.cpu}%  RAM ${last.mem}%`, padL + 4, padT + 11);
}

$('#wanLookupBtn').addEventListener('click', async () => {
  const el = $('#wanInfo'); el.innerHTML = '<div class="k dim">Looking up…</div><div class="v"></div>';
  try {
    const d = await getJson('/manager/gateway/wan');
    if (d.error) throw new Error(d.message || 'lookup failed');
    el.innerHTML = kv([
      ['Public IP', `<span class="mono">${esc(d.ip)}</span>`], ['ISP', esc(d.org || '—')],
      ['Location', `${d.flag || ''} ${esc([d.city, d.region, d.country].filter(Boolean).join(', '))}`],
    ]);
  } catch (e) { el.innerHTML = kv([['Lookup failed', esc(e.message)]]); }
});

// ===========================================================================
//  Routers & APs — unified infrastructure management
// ===========================================================================
let infraLeases = [];

async function routerAction(devId, action, body) {
  const r = await fetch(`/manager/router/${encodeURIComponent(devId)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`);
  return d;
}

async function loadInfra() {
  const cards = $('#infraCards');
  if (!cards.children.length) cards.innerHTML = '<div class="glass"><div class="k skeleton">Loading infrastructure…</div></div>';
  const [gwR, apsR] = await Promise.allSettled([
    getJson('/manager/router/status'), getJson('/manager/router/aps'),
  ]);
  const gw = gwR.status === 'fulfilled' ? gwR.value : { ok: false, message: 'unreachable' };
  const aps = (apsR.status === 'fulfilled' ? apsR.value.aps : []) || [];

  const devices = [{
    id: 'gateway', kind: 'gateway', label: gw.model || 'Gateway',
    ip: gw.lan_ip || gw.ipv4?.lan_ip || '—', ...gw,
  }, ...aps.map((a) => ({ ...a, kind: 'ap', id: a.id }))];

  // ---- headline
  const online = devices.filter((x) => x.ok).length;
  const radios = devices.reduce((n, x) => n + (x.wifi_2g ? 1 : 0) + (x.wifi_5g ? 1 : 0), 0);
  // Use each AP's own radio-client count so this section doesn't depend on the
  // Network Map having been opened first.
  const wifiClients = aps.reduce((n, a) => n + (a.wireless_clients || 0), 0);
  $('#infraStats').innerHTML = [
    { cls: online === devices.length ? 'good' : 'bad', label: 'Devices Online', value: `${online}/${devices.length}`, sub: devices.map((x) => x.label || x.id).join(' · ') },
    { cls: 'hot', label: 'Active Radios', value: fmt(radios), sub: 'across all access points' },
    { cls: 'good', label: 'Wi-Fi Clients', value: fmt(wifiClients), sub: 'associated to a radio' },
    { cls: gw.ok ? 'good' : 'bad', label: 'WAN', value: gw.ipv4?.wan_ip || gw.wan_ip || '—', sub: gw.ipv4?.wan_conntype || 'uplink' },
  ].map((c) => `<div class="insight-card ${c.cls}"><div class="ic-label">${c.label}</div><div class="ic-value">${esc(c.value)}</div><div class="ic-sub">${esc(c.sub)}</div></div>`).join('');

  // ---- device cards
  cards.innerHTML = devices.map((x) => {
    const isAp = x.kind === 'ap';
    const cpu = x.cpu != null ? Math.round(x.cpu * 100) : null;
    const mem = x.mem != null ? Math.round(x.mem * 100) : null;
    const clients = x.wireless_clients ?? meshNodes.filter((n) => n.viaAp === x.id).length;
    const radioRow = (band, label, on, supported) => supported === false ? '' : `
      <div class="radio-row">
        <div><div class="rr-name">${label}</div><div class="rr-sub">${on ? 'broadcasting' : 'disabled'}${band.startsWith('guest') ? ' · guest network' : ''}</div></div>
        <label class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${x.ok ? '' : 'disabled'}
          data-radio="${band}" data-dev="${esc(x.id)}" data-label="${esc(x.label || x.id)}"><span></span></label>
      </div>`;
    return `<div class="infra-card ${isAp ? 'is-ap' : ''} ${x.ok ? '' : 'is-down'}">
      <div class="infra-head">
        <div class="infra-title">${iconHtml(isAp ? 'ap' : 'router', 26)}
          <div><b>${esc(x.label || x.model || x.id)}</b><span>${esc(x.ip || x.ipv4?.lan_ip || '')}</span></div></div>
        ${x.ok ? '<span class="pill green">online</span>' : `<span class="pill red">${esc(x.message || 'offline')}</span>`}
      </div>
      ${(cpu != null || mem != null) ? `<div class="infra-gauges">
        ${cpu != null ? `<div class="gauge" data-g="cpu-${esc(x.id)}"></div>` : ''}
        ${mem != null ? `<div class="gauge" data-g="mem-${esc(x.id)}"></div>` : ''}</div>` : ''}
      <div class="mini-kv">
        ${kv([
          ['Model', esc(x.model || '—')],
          ['Firmware', esc(String(x.firmware || '—').split(' ').slice(0, 3).join(' '))],
          ['LAN MAC', `<span class="mono">${esc(x.lan_mac || x.ipv4?.lan_mac || '—')}</span>`],
          ['Clients', isAp ? `${clients} on radio · ${x.clients_total ?? '—'} seen` : `${x.clients_total ?? '—'} seen`],
        ])}
      </div>
      <div class="infra-radios">
        ${radioRow('host_2g', 'Wi-Fi 2.4 GHz', !!x.wifi_2g, x.wifi_2g != null)}
        ${radioRow('host_5g', 'Wi-Fi 5 GHz', !!x.wifi_5g, x.wifi_5g != null)}
      </div>
      <div class="infra-actions">
        <a class="btn btn-sm" href="http://${esc(x.ip || '')}" target="_blank" rel="noopener">↗ Admin UI</a>
        <button class="btn btn-sm btn-danger" data-reboot="${esc(x.id)}" data-label="${esc(x.label || x.id)}" ${x.ok ? '' : 'disabled'}>⟲ Reboot</button>
      </div>
      ${x.stale ? '<div class="infra-note">Values may be out of date: the most recent poll of this device did not succeed.</div>' : ''}
    </div>`;
  }).join('');

  // gauges need real elements, so render them after the cards exist
  devices.forEach((x) => {
    const c = cards.querySelector(`[data-g="cpu-${CSS.escape(x.id)}"]`);
    const m = cards.querySelector(`[data-g="mem-${CSS.escape(x.id)}"]`);
    if (c) gauge(c, Math.round(x.cpu * 100), 'CPU', 'var(--cyan)', `${Math.round(x.cpu * 100)}%`);
    if (m) gauge(m, Math.round(x.mem * 100), 'RAM', 'var(--violet)', `${Math.round(x.mem * 100)}%`);
  });

  // ---- gateway WAN + leases
  const i4 = gw.ipv4 || {};
  $('#infraWan').innerHTML = kv([
    ['WAN IP', `<span class="mono">${esc(i4.wan_ip || gw.wan_ip || '—')}</span>`],
    ['WAN gateway', `<span class="mono">${esc(i4.wan_gateway || '—')}</span>`],
    ['Netmask', `<span class="mono">${esc(i4.wan_netmask || '—')}</span>`],
    ['Connection', esc(i4.wan_conntype || '—')],
    ['ISP DNS 1', `<span class="mono">${esc(i4.wan_pridns || '—')}</span>`],
    ['ISP DNS 2', `<span class="mono">${esc(i4.wan_snddns || '—')}</span>`],
    ['LAN IP', `<span class="mono">${esc(i4.lan_ip || '—')}</span>`],
    ['Router DHCP', i4.lan_dhcp_enable ? '<span class="pill amber">enabled</span>' : '<span class="pill green">off (Pi-hole serves DHCP)</span>'],
  ]);
  infraLeases = gw.leases || [];
  renderInfraLeases();
}

function renderInfraLeases() {
  const f = ($('#infraLeaseFilter').value || '').toLowerCase();
  const rows = infraLeases.filter((l) =>
    !f || (l.ip || '').includes(f) || (l.hostname || '').toLowerCase().includes(f) || (l.mac || '').toLowerCase().includes(f))
    .map((l) => {
      const nice = l.hostname && l.hostname !== 'Unknown' ? l.hostname : (nameForIp(l.ip) !== l.ip ? nameForIp(l.ip) : '—');
      return `<tr><td class="mono">${esc(l.ip)}</td><td>${esc(nice)}</td>
        <td class="mono dim">${esc(l.mac)}</td><td class="dim">${esc(l.lease || '')}</td></tr>`;
    }).join('');
  $('#infraLeaseCount').textContent = infraLeases.length;
  $('#infraLeaseTable tbody').innerHTML = rows || '<tr><td colspan="4" class="empty">No leases reported</td></tr>';
}
$('#infraLeaseFilter').addEventListener('input', debounce(renderInfraLeases));

// ---- radio toggle (disruptive: warn before cutting a radio)
$('#infraCards').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-radio]');
  if (!t) return;
  const { radio, dev, label } = t.dataset;
  const enable = t.checked;
  const bandName = radio.includes('5g') ? '5 GHz' : '2.4 GHz';
  const ok = await confirmDialog(
    enable
      ? `Turn the ${bandName} radio back on for ${label}?`
      : `Disable the ${bandName} radio on ${label}?\n\nEvery device currently connected to it will be dropped — including this browser if you are on that band.`,
    { title: enable ? 'Enable radio' : 'Disable radio', yes: enable ? 'Enable' : 'Disable' });
  if (!ok) { t.checked = !enable; return; }
  t.disabled = true;
  try {
    await routerAction(dev, 'wifi', { band: radio, enable });
    toast(`${label}: ${bandName} ${enable ? 'enabled' : 'disabled'}`, 'ok');
    setTimeout(() => loaders.infra(), 3000);
  } catch (err) {
    t.checked = !enable;
    toast(`Could not apply the change: ${err.message}`, 'err');
  } finally { t.disabled = false; }
});

// ---- reboot (very disruptive)
$('#infraCards').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-reboot]');
  if (!b) return;
  const { reboot: dev, label } = b.dataset;
  const isGw = dev === 'gateway';
  const ok = await confirmDialog(
    `Reboot ${label}?\n\n${isGw
      ? 'This drops the internet connection for your whole network for 1–2 minutes. Every device will lose connectivity.'
      : 'Every device connected to this access point will be disconnected for 1–2 minutes.'}`,
    { title: 'Reboot device', yes: 'Reboot now' });
  if (!ok) return;
  b.disabled = true; b.textContent = '⟲ Rebooting…';
  try {
    await routerAction(dev, 'reboot');
    toast(`${label} is rebooting — it will reappear in a minute or two`, 'ok');
  } catch (err) {
    toast(`Reboot failed: ${err.message}`, 'err');
  } finally {
    setTimeout(() => { loaders.infra(); }, 5000);
  }
});

// ===========================================================================
//  Network
// ===========================================================================
let allDevices = [];
async function loadNetwork() {
  const [gwR, devR] = await Promise.allSettled([api('network/gateway'), api('network/devices')]);
  if (gwR.status === 'fulfilled') {
    const gw = gwR.value.gateway || [];
    $('#gatewayInfo').innerHTML = kv(gw.map((g) => [`${esc(g.interface)} (${esc(g.family)})`, `${esc(g.address)} · local ${esc((g.local || []).join(', '))}`]));
  }
  if (devR.status === 'fulfilled') {
    allDevices = devR.value.devices || []; $('#deviceCount').textContent = allDevices.length; renderDevices();
  } else toast(`Could not load discovered devices: ${devR.reason?.message}`, 'err');
}
function renderDevices() {
  const f = $('#deviceFilter').value.toLowerCase();
  const rows = allDevices.filter((d) => {
    if (!f) return true;
    return (d.hwaddr || '').toLowerCase().includes(f) || (d.macVendor || '').toLowerCase().includes(f) || (d.ips || []).some((i) => (i.ip || '').includes(f));
  }).sort((a, b) => (b.lastQuery || 0) - (a.lastQuery || 0)).map((d) => `
    <tr><td class="mono">${(d.ips || []).map((i) => esc(i.ip)).join('<br>') || '—'}</td>
      <td class="mono dim">${esc(d.hwaddr)}</td><td>${esc(d.macVendor || '')}</td>
      <td class="mono num">${fmt(d.numQueries)}</td><td class="dim">${d.lastQuery ? relTime(d.lastQuery) : '—'}</td></tr>`).join('');
  $('#devicesTable tbody').innerHTML = rows || '<tr><td colspan="5" class="empty">No devices</td></tr>';
}
$('#deviceFilter').addEventListener('input', debounce(renderDevices));

// ===========================================================================
//  Diagnostics
// ===========================================================================
async function loadDiagnostics() {
  const [sysR, ftlR, msgR] = await Promise.allSettled([api('info/system'), api('info/ftl'), api('info/messages')]);
  if (sysR.status === 'fulfilled') {
    const sys = sysR.value.system || {};
    $('#diagSystem').innerHTML = kv([
      ['Uptime', fmtUptime(sys.uptime)], ['Processes', sys.procs], ['CPU cores', sys.cpu?.nprocs],
      ['CPU load', `${(sys.cpu?.['%cpu'] ?? 0).toFixed(1)}%`],
      ['RAM used', `${(sys.memory?.ram?.['%used'] ?? 0).toFixed(1)}%`],
      ['RAM total', `${((sys.memory?.ram?.total || 0) / 1024).toFixed(0)} MB`],
      ['Swap used', `${(sys.memory?.swap?.['%used'] ?? 0).toFixed(1)}%`],
    ]);
  }
  if (ftlR.status === 'fulfilled') {
    const f = ftlR.value.ftl || {}, db = f.database || {};
    $('#diagFtl').innerHTML = kv([
      ['Gravity domains', fmt(db.gravity)], ['Lists', fmt(db.lists)], ['Groups', fmt(db.groups)], ['Clients', fmt(db.clients)],
      ['Regex allow', fmt(db.regex?.allowed?.total)], ['Regex deny', fmt(db.regex?.denied?.total)],
      ['Query rate', `${(f.query_frequency ?? 0).toFixed(2)} queries/s`], ['Privacy level', f.privacy_level],
    ]);
    const dm = f.dnsmasq || {};
    $('#diagDnsmasq').innerHTML = kv([
      ['Cache inserted', fmt(dm.dns_cache_inserted)], ['Local answered', fmt(dm.dns_local_answered)], ['Forwarded', fmt(dm.dns_queries_forwarded)],
      ['Stale answered', fmt(dm.dns_stale_answered)], ['Unanswered', fmt(dm.dns_unanswered)], ['Auth answered', fmt(dm.dns_auth_answered)],
      ['DHCP ACK', fmt(dm.dhcp_ack)], ['DHCP offers', fmt(dm.dhcp_offer)], ['Leases (v4)', fmt(dm.leases_allocated_4)],
    ]);
  }
  if (msgR.status === 'fulfilled') {
    const msgs = msgR.value.messages || []; $('#msgCount').textContent = msgs.length;
    $('#diagMessages').innerHTML = msgs.length
      ? `<div class="table-wrap"><table class="dt"><thead><tr><th>Type</th><th>Message</th><th>When</th></tr></thead><tbody>${msgs.map((m) => `<tr><td><span class="pill amber">${esc(m.type)}</span></td><td>${esc(m.message)}</td><td class="dim">${m.timestamp ? relTime(m.timestamp) : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">✓ No diagnostic warnings — all clear</div>';
  }
}

// ===========================================================================
//  Insights — who's doing what + security posture
// ===========================================================================
let whoRows = [];

async function loadInsights() {
  $('#insightHeadline').innerHTML = '<div class="insight-card"><div class="ic-label">Analyzing…</div></div>';
  await loadIdentity();
  let qs = [];
  try { qs = (await api('queries?length=1000')).queries || []; }
  catch (e) { toast(`Could not build the activity report: ${e.message}`, 'err'); return; }

  const per = {}, blockedDomains = {};
  let blocked = 0;
  qs.forEach((q) => {
    const ip = q.client?.ip || '?';
    const p = per[ip] || (per[ip] = { ip, total: 0, blocked: 0, domains: {}, uniq: new Set() });
    p.total++; p.uniq.add(q.domain); p.domains[q.domain] = (p.domains[q.domain] || 0) + 1;
    if (isBlockedStatus(q.status)) { p.blocked++; blocked++; blockedDomains[q.domain] = (blockedDomains[q.domain] || 0) + 1; }
  });
  const clients = Object.values(per).map((p) => {
    const top = Object.entries(p.domains).sort((a, b) => b[1] - a[1])[0];
    return { ...p, name: nameForIp(p.ip), uniqCount: p.uniq.size, topDomain: top ? top[0] : '—', pct: p.total ? (p.blocked / p.total * 100) : 0 };
  }).sort((a, b) => b.total - a.total);
  whoRows = clients;

  const busiest = clients[0];
  const mostBlocked = [...clients].sort((a, b) => b.blocked - a.blocked)[0];
  const heaviestUniq = [...clients].sort((a, b) => b.uniqCount - a.uniqCount)[0];
  const sample = qs.length, blockPct = sample ? (blocked / sample * 100) : 0;

  $('#insightHeadline').innerHTML = [
    { cls: 'hot', label: 'Busiest Client', value: busiest?.name || '—', sub: `${fmt(busiest?.total)} queries` },
    { cls: 'bad', label: 'Most Blocked Client', value: mostBlocked?.name || '—', sub: `${fmt(mostBlocked?.blocked)} blocked · ${(mostBlocked?.pct || 0).toFixed(0)}%` },
    { cls: 'warn', label: 'Widest Reach', value: heaviestUniq?.name || '—', sub: `${fmt(heaviestUniq?.uniqCount)} unique domains` },
    { cls: '', label: 'Sample Block Rate', value: `${blockPct.toFixed(1)}%`, sub: `${fmt(blocked)} of ${fmt(sample)} recent` },
  ].map((c) => `<div class="insight-card ${c.cls}"><div class="ic-label">${c.label}</div><div class="ic-value">${esc(c.value)}</div><div class="ic-sub">${esc(c.sub)}</div></div>`).join('');

  $('#whoSample').textContent = `· last ${fmt(sample)} queries`;
  renderWho();

  const rb = Object.entries(blockedDomains).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, c]) => ({ name: d, count: c }));
  barList($('#recentBlocked'), rb, { red: true });

  buildSecurity(clients, blockedDomains);
  buildControls();
}

function renderWho() {
  const f = $('#whoFilter').value.toLowerCase();
  const rows = whoRows.filter((c) => !f || c.name.toLowerCase().includes(f) || c.ip.includes(f)).map((c) => {
    const nm = c.name !== c.ip ? `${esc(c.name)} <span class="dim mono">${esc(c.ip)}</span>` : `<span class="mono">${esc(c.ip)}</span>`;
    return `<tr><td>${nm}</td><td class="mono num">${fmt(c.total)}</td><td class="mono num">${fmt(c.blocked)}</td>
      <td class="num"><div class="mono">${c.pct.toFixed(0)}%</div><div class="mini-bar"><i class="${c.pct > 40 ? 'red' : ''}" style="width:${Math.min(100, c.pct)}%"></i></div></td>
      <td class="mono num">${fmt(c.uniqCount)}</td><td><div class="dom-cell">${favicon(c.topDomain)}<span class="mono">${esc(c.topDomain)}</span></div></td></tr>`;
  }).join('');
  $('#whoTable tbody').innerHTML = rows || '<tr><td colspan="6" class="empty">No data</td></tr>';
}
$('#whoFilter').addEventListener('input', debounce(renderWho));

async function buildSecurity(clients, blockedDomains) {
  const items = [];
  const add = (level, title, desc) => items.push({ level, title, desc });

  add(blockingState === 'enabled' ? 'ok' : 'bad',
    blockingState === 'enabled' ? 'DNS blocking enabled' : 'DNS blocking disabled',
    blockingState === 'enabled'
      ? 'Pi-hole is filtering DNS queries for all configured clients.'
      : 'DNS filtering is not active. All clients can resolve advertising and tracking domains until blocking is re-enabled.');

  const [dnsR, msgsR, gwR] = await Promise.allSettled([api('config/dns'), api('info/messages'), getJson('/manager/gateway/health')]);
  if (dnsR.status === 'fulfilled') {
    const dns = dnsR.value.config?.dns || {};
    add(dns.dnssec ? 'ok' : 'warn', dns.dnssec ? 'DNSSEC validation on' : 'DNSSEC validation off',
      dns.dnssec ? 'Upstream responses are cryptographically validated.' : 'Enable DNSSEC in Settings to detect forged DNS responses.');
    if (!dns.queryLogging) add('warn', 'Query logging disabled', 'Client activity reporting and the query log remain incomplete while logging is off.');
  }

  const noisy = clients.filter((c) => c.total >= 20 && c.pct >= 40);
  add(noisy.length ? 'warn' : 'ok', noisy.length ? `${noisy.length} client(s) with high block rate` : 'No abnormally noisy clients',
    noisy.length ? `Review ${noisy.slice(0, 3).map((c) => `${c.name} (${c.pct.toFixed(0)}%)`).join(', ')}. A sustained high block rate often indicates adware or an application polling a tracking endpoint.` : 'No client shows an unusual block rate.');

  const suspicious = Object.keys(blockedDomains).filter((d) => /(^|\.)[a-z0-9]{25,}\./i.test(d) || (d.match(/-/g) || []).length >= 5);
  if (suspicious.length) add('warn', `${suspicious.length} suspicious domain pattern(s)`, `Algorithmically generated hostnames were queried and blocked, for example ${regDomain(suspicious[0])}. This pattern is consistent with malware beaconing.`);

  if (gwR.status === 'fulfilled') {
    const g = gwR.value;
    if (!g.internet?.up) add('bad', 'Internet unreachable', 'The WAN link appears down — check the gateway.');
    else if ((g.internet.loss ?? 0) > 0) add('warn', `WAN packet loss ${g.internet.loss}%`, 'Some probes to 1.1.1.1 failed — the uplink may be unstable.');
    else add('ok', 'WAN link healthy', `Internet ${g.internet.latency} ms, 0% loss, gateway ${g.gateway?.latency ?? '—'} ms.`);
  }

  if (msgsR.status === 'fulfilled') {
    const msgs = msgsR.value.messages || [];
    add(msgs.length ? 'warn' : 'ok', msgs.length ? `${msgs.length} Pi-hole diagnostic message(s)` : 'No Pi-hole diagnostics',
      msgs.length ? (msgs[0].message || 'See Diagnostics tab.') : 'Pi-hole reports no configuration or health warnings.');
  }

  const good = items.filter((i) => i.level === 'ok').length;
  $('#secScore').textContent = `${good}/${items.length} healthy`;
  const ico = { ok: '✓', warn: '!', bad: '✕' };
  // Escape centrally: titles/descriptions embed device-controlled names
  // (DHCP/router hostnames), so this is the single trusted escape point.
  $('#secList').innerHTML = items.map((i) => `
    <div class="sec-item"><div class="sec-icon ${i.level}">${ico[i.level]}</div>
    <div class="sec-text"><b>${esc(i.title)}</b><span>${esc(i.desc)}</span></div></div>`).join('');
}

function buildControls() {
  const controls = [
    ['⛨', 'DNS Blocking', 'Enable, disable and timed pauses', 'overview'],
    ['🕸', 'Network Map', 'Live network topology', 'mesh'],
    ['◍', 'Domains', 'Allow and deny entries, exact or pattern', 'domains'],
    ['▤', 'Filter Lists', 'Manage lists and run gravity updates', 'lists'],
    ['◎', 'Groups', 'Create groups and assign clients', 'groups'],
    ['▦', 'Clients', 'Per-client group assignment', 'clients'],
    ['⬡', 'Local DNS', 'A and CNAME records', 'localdns'],
    ['⇄', 'DHCP', 'Leases and reservations', 'dhcp'],
    ['📡', 'Gateway', 'Router and WAN health', 'gateway'],
    ['⚙', 'Upstream DNS', 'Resolvers and DNSSEC', 'settings'],
    ['⟳', 'Maintenance', 'Restart DNS, flush caches, update gravity', 'settings'],
    ['⬇', 'Backup', 'Export and restore configuration', 'backup'],
  ];
  $('#controlsGrid').innerHTML = controls.map(([ico, name, desc, sec]) =>
    `<div class="ctrl" data-goto="${sec}"><div class="ct-ico">${ico}</div><div><b>${name}</b><span>${desc}</span></div></div>`).join('');
}
$('#controlsGrid').addEventListener('click', (e) => {
  const c = e.target.closest('[data-goto]'); if (!c) return;
  activateSection(c.dataset.goto);
});

// ===========================================================================
//  Settings
// ===========================================================================
async function loadSettings() {
  try {
    const dns = (await api('config/dns')).config?.dns || {};
    const ups = dns.upstreams || [];
    $('#upstreamList').innerHTML = ups.length ? ups.map((u) => `<div class="chip">${esc(u)}<button class="chip-x" data-del-upstream="${esc(u)}" aria-label="Remove upstream ${esc(u)}" title="Remove upstream ${esc(u)}">${iconHtml('trash', 12)}</button></div>`).join('') : '<span class="dim">No upstreams</span>';
    const toggles = [
      ['dnssec', 'DNSSEC', 'Validate DNS responses'],
      ['queryLogging', 'Query Logging', 'Record queries in the database'],
      ['bogusPriv', 'Bogus-priv', 'Never forward reverse lookups for private ranges'],
      ['domainNeeded', 'Domain-needed', 'Never forward names without a dot'],
    ];
    $('#dnsToggles').innerHTML = toggles.map(([k, name, desc]) => `
      <div class="toggle-row"><div><div class="tr-name">${name}</div><div class="tr-desc">${desc}</div></div>
      <label class="switch"><input type="checkbox" ${dns[k] ? 'checked' : ''} data-cfg-dns="${k}"><span></span></label></div>`).join('');
  } catch (e) { toast(`Could not load DNS settings: ${e.message}`, 'err'); }
  loadSystemInfo();
}
async function loadSystemInfo() {
  try {
    const [vR, hR] = await Promise.allSettled([api('info/version'), getJson('/manager/health')]);
    const v = vR.status === 'fulfilled' ? vR.value.version || {} : {};
    const health = hR.status === 'fulfilled' ? hR.value : {};
    $('#settingsInfo').innerHTML = kv([
      ['Connection', health.connected ? '<span class="pill green">online</span>' : '<span class="pill red">offline</span>'],
      ['Pi-hole', esc(health.pihole)], ['Core', esc(v.core?.local?.version)], ['Web', esc(v.web?.local?.version)],
      ['FTL', esc(v.ftl?.local?.version)], ['Docker', esc(v.docker?.local)],
    ]);
  } catch {}
}
$('#addUpstreamBtn').addEventListener('click', async () => {
  const u = $('#upstreamInput').value.trim(), msg = $('#upstreamMsg');
  if (!u) { msg.textContent = 'Enter a server.'; msg.className = 'hint error'; return; }
  try { await cfgPut('dns/upstreams', u); msg.textContent = 'Added'; msg.className = 'hint ok'; $('#upstreamInput').value = ''; loadSettings(); }
  catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});
$('#upstreamList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-upstream]'); if (!b) return;
  if (!(await confirmDialog(`Remove upstream ${b.dataset.delUpstream}?`, { title: 'Remove upstream', yes: 'Remove' }))) return;
  try { await cfgDel('dns/upstreams', b.dataset.delUpstream); toast('Removed', 'ok'); loadSettings(); } catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); }
});
$('#dnsToggles').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-cfg-dns]'); if (!t) return;
  try { await patchConfig({ dns: { [t.dataset.cfgDns]: t.checked } }); toast('Saved', 'ok'); }
  catch (err) { toast(`Could not apply the change: ${err.message}`, 'err'); t.checked = !t.checked; }
});
function actionBtn(id, path, label) {
  $(id).addEventListener('click', async () => {
    const msg = $('#actionMsg');
    try { await api(path, { method: 'POST' }); msg.textContent = `${label} ✓`; msg.className = 'hint ok'; toast(`${label} done`, 'ok'); }
    catch (e) { msg.textContent = `${label} failed: ${e.message}`; msg.className = 'hint error'; }
  });
}
actionBtn('#restartDnsBtn', 'action/restartDNS', 'Restart DNS');
actionBtn('#flushLogsBtn', 'action/flush/logs', 'Flush query log');
actionBtn('#flushArpBtn', 'action/flush/arp', 'Flush network table');
$('#gravityBtn2').addEventListener('click', (e) => updateGravity(e.target));

// ===========================================================================
//  Backup & Restore (Teleporter)
// ===========================================================================
$('#exportBtn').addEventListener('click', async () => {
  const btn = $('#exportBtn'), msg = $('#exportMsg');
  btn.disabled = true; msg.textContent = 'Preparing archive…'; msg.className = 'hint';
  try {
    const res = await fetch('/manager/teleporter/export');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    let fn = 'pihole-backup.zip';
    const cd = res.headers.get('content-disposition'), m = cd && cd.match(/filename="?([^"]+)"?/);
    if (m) fn = m[1];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fn; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    msg.textContent = `Downloaded ${fn} (${(blob.size / 1024).toFixed(0)} KB)`; msg.className = 'hint ok';
    toast('Backup downloaded', 'ok');
  } catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
  finally { btn.disabled = false; }
});

$('#restoreBtn').addEventListener('click', async () => {
  const file = $('#restoreFile').files[0], msg = $('#restoreMsg'), out = $('#restoreResult');
  out.innerHTML = '';
  if (!file) { msg.textContent = 'Choose a .zip backup first.'; msg.className = 'hint error'; return; }
  if (!(await confirmDialog('Restore this backup?\nIt will overwrite matching Pi-hole settings.', { title: 'Restore configuration', yes: 'Restore' }))) return;
  msg.textContent = 'Restoring…'; msg.className = 'hint';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/manager/teleporter/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    msg.textContent = 'Restore complete ✓'; msg.className = 'hint ok';
    const imported = data.files || data.imported || (Array.isArray(data) ? data : null);
    if (imported) out.innerHTML = `<div class="k">Imported</div><div class="v">${esc(Array.isArray(imported) ? imported.length + ' item(s)' : JSON.stringify(imported).slice(0, 200))}</div>`;
    toast('Configuration restored', 'ok');
    loadBlocking();
  } catch (e) { msg.textContent = `Failed: ${e.message}`; msg.className = 'hint error'; }
});

// ===========================================================================
//  Identity, roles and the admin panel
// ===========================================================================
let me = null;
const ROLE_RANK = { reader: 1, contributor: 2, admin: 3 };
const can = (role) => !!me && ROLE_RANK[me.role] >= ROLE_RANK[role];

async function loadMe() {
  const r = await fetch('/auth/me');
  if (r.status === 401) { location.href = '/login.html'; return null; }
  const d = await r.json();
  me = d.user;
  document.body.dataset.role = me.role;
  $('#whoName').textContent = me.username;
  const av = $('#whoAvatar');
  if (av) {
    av.textContent = me.username.slice(0, 1).toUpperCase();
    // role="img" + aria-label keeps identity in the accessibility tree at the
    // widths where .hud-id-text is display:none.
    av.setAttribute('aria-label', `Signed in as ${me.username}, ${me.role}`);
  }
  $('#whoami').title = `Signed in as ${me.username} · ${me.role}`;
  const rolePill = $('#whoRole');
  rolePill.textContent = me.role;
  rolePill.className = `pill ${{ admin: 'violet', contributor: 'blue', reader: 'gray' }[me.role]}`;
  if (me.mustChangePassword) {
    toast('You are using the generated password — change it in the Admin panel', 'err');
  }
  return me;
}

$('#logoutBtn').addEventListener('click', async () => {
  if (!(await confirmDialog('Sign out of Blackhole.Net?', { title: 'Sign out', yes: 'Sign out' }))) return;
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

// --- users -----------------------------------------------------------------
let DRIVERS = [];
let VENDOR_LIST = [];

async function loadAdmin() {
  await loadDrivers();                                   // selects need this first
  await Promise.allSettled([loadAdminUsers(), loadAdminConfig()]);
}

async function loadDrivers() {
  if (DRIVERS.length) return DRIVERS;
  try {
    const d = await getJson('/manager/router/drivers');
    DRIVERS = d.drivers || [];
    VENDOR_LIST = d.vendors || [{ id: 'tplink', label: 'TP-Link', drivers: true }];
  } catch { DRIVERS = []; VENDOR_LIST = [{ id: 'tplink', label: 'TP-Link', drivers: true }]; }
  $('#driverCount').textContent = DRIVERS.length;
  $('#vendorSummary').textContent = VENDOR_LIST.map((v) => v.id).join(' · ');
  renderDriverList();
  return DRIVERS;
}

const vendorOptions = (selected) => VENDOR_LIST.map((v) =>
  `<option value="${esc(v.id)}" ${(selected || 'tplink') === v.id ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
const vendorUsesDrivers = (v) => (VENDOR_LIST.find((x) => x.id === (v || 'tplink')) || {}).drivers === true;

const driverOptions = (selected) =>
  `<option value="">Auto-detect (try all models)</option>` +
  DRIVERS.map((d) => `<option value="${esc(d.id)}" ${selected === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('');

function renderDriverList() {
  const f = ($('#driverFilter')?.value || '').toLowerCase();
  const items = DRIVERS.filter((d) => !f || d.label.toLowerCase().includes(f) || d.id.toLowerCase().includes(f));
  $('#driverList').innerHTML = items.length
    ? items.map((d) => `<div class="driver-item"><b>${esc(d.id.replace(/^TP?[Ll]ink/, ''))}</b><span>${esc(d.label)}</span></div>`).join('')
    : '<div class="empty">No model matches that search</div>';
}

async function loadAdminUsers() {
  try {
    const d = await getJson('/manager/admin/users');
    const rolePill = { admin: 'violet', contributor: 'blue', reader: 'gray' };
    $('#userCount').textContent = (d.users || []).length;
    $('#usersTable tbody').innerHTML = (d.users || []).map((u) => `
      <tr><td><b>${esc(u.username)}</b>${u.username === me?.username ? ' <span class="dim">(you)</span>' : ''}
        ${u.mustChangePassword ? ' <span class="pill amber">temp password</span>' : ''}</td>
        <td><select class="role-sel" data-user="${esc(u.username)}" ${u.username === me?.username ? 'disabled' : ''}>
          ${['reader', 'contributor', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select> <span class="pill ${rolePill[u.role]}">${esc(u.role)}</span></td>
        <td class="dim">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
        <td class="dim">${u.lastLogin ? relTime(Math.floor(new Date(u.lastLogin).getTime() / 1000)) : 'never'}</td>
        <td><button class="btn btn-sm" data-pw-user="${esc(u.username)}">Reset password</button>
            <button class="btn btn-sm btn-icon-sm" data-del-user="${esc(u.username)}" ${u.username === me?.username ? 'disabled' : ''} aria-label="Delete user ${esc(u.username)}" title="Delete user ${esc(u.username)}">${iconHtml('trash')}</button></td></tr>`).join('');
  } catch (e) { toast(`Could not load user accounts: ${e.message}`, 'err'); }
}

$('#addUserBtn').addEventListener('click', async () => {
  const username = $('#newUser').value.trim(), password = $('#newPass').value, role = $('#newRole').value;
  const msg = $('#userMsg');
  try {
    const r = await fetch('/manager/admin/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.message || 'Failed');
    msg.textContent = `Created ${username} as ${role}`; msg.className = 'hint ok';
    $('#newUser').value = ''; $('#newPass').value = '';
    loadAdminUsers();
  } catch (e) { msg.textContent = e.message; msg.className = 'hint error'; }
});

$('#usersTable').addEventListener('change', async (e) => {
  const sel = e.target.closest('.role-sel'); if (!sel) return;
  try {
    const r = await fetch(`/manager/admin/users/${encodeURIComponent(sel.dataset.user)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: sel.value }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.message || 'Failed');
    toast(`${sel.dataset.user} is now ${sel.value}`, 'ok');
    loadAdminUsers();
  } catch (err) { toast(err.message, 'err'); loadAdminUsers(); }
});

$('#usersTable').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-user]'), pw = e.target.closest('[data-pw-user]');
  if (del) {
    const u = del.dataset.delUser;
    if (!(await confirmDialog(`Delete the account "${u}"?\nAny active session for them is ended immediately.`,
      { title: 'Delete user', yes: 'Delete' }))) return;
    try {
      const r = await fetch(`/manager/admin/users/${encodeURIComponent(u)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.message || 'Failed');
      toast(`Deleted ${u}`, 'ok'); loadAdminUsers();
    } catch (err) { toast(err.message, 'err'); }
  } else if (pw) {
    const u = pw.dataset.pwUser;
    openPasswordReset(u);
  }
});

function openPasswordReset(username) {
  $('#editTitle').textContent = `Reset password · ${username}`;
  $('#editBody').innerHTML = `<div class="field"><label>New password (min 8 characters)</label>
    <input type="password" id="resetPw" autocomplete="new-password" /></div>
    <p class="hint">Their existing sessions will be signed out.</p>`;
  $('#editModal').classList.add('show');
  setTimeout(() => $('#resetPw')?.focus(), 60);
  $('#editSave').onclick = async () => {
    try {
      const r = await fetch(`/manager/admin/users/${encodeURIComponent(username)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#resetPw').value }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.message || 'Failed');
      $('#editModal').classList.remove('show');
      toast(`Password reset for ${username}`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#ownPwMsg');
  const cur = $('#ownCur').value, next = $('#ownNew').value, again = $('#ownNew2').value;
  const fail = (t, focus) => {
    msg.textContent = t; msg.className = 'hint error';
    $(focus)?.focus(); $(focus)?.setAttribute('aria-invalid', 'true');
  };
  for (const id of ['#ownCur', '#ownNew', '#ownNew2']) $(id).removeAttribute('aria-invalid');
  if (!cur) return fail('Enter your current password.', '#ownCur');
  // The old form had no confirm field at all, so a typo silently set a password
  // the operator did not know — and the server cannot detect that.
  if (next.length < 8) return fail('The new password must be at least 8 characters.', '#ownNew');
  if (next !== again) return fail('The two new passwords do not match.', '#ownNew2');
  if (next === cur) return fail('The new password must differ from the current one.', '#ownNew');

  const btn = $('#ownPwBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: cur, newPassword: next }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.message || `HTTP ${r.status}`);
    msg.textContent = 'Password changed. Any other signed-in sessions have been signed out.';
    msg.className = 'hint ok';
    $('#ownCur').value = ''; $('#ownNew').value = ''; $('#ownNew2').value = '';
    loadMe();
  } catch (err) {
    msg.textContent = `Could not change your password: ${err.message}`;
    msg.className = 'hint error';
  } finally { btn.disabled = false; }
});

// --- device configuration --------------------------------------------------
let apDraft = [];
let phDraft = [];

function renderPhConfig() {
  $('#phCfgCount').textContent = phDraft.length;
  $('#phConfigList').innerHTML = phDraft.map((ph, i) => `
    <div class="ap-cfg-row">
      <span class="row-tag">${i === 0 ? 'primary' : 'instance ' + (i + 1)}</span>
      <input type="text" data-ph="${i}" data-k="label" value="${esc(ph.label || '')}" placeholder="Name" aria-label="Instance name" />
      <input type="text" data-ph="${i}" data-k="url" value="${esc(ph.url || '')}" placeholder="http://192.168.1.10" aria-label="Instance address" />
      <input type="password" data-ph="${i}" data-k="password" value="" placeholder="${ph.hasPassword ? 'Password set — leave blank to keep' : 'Password'}" aria-label="Instance password" autocomplete="off" />
      <button class="btn btn-sm" data-test-ph="${i}">Test</button>
      ${phDraft.length > 1 ? `<button class="btn btn-sm btn-danger" data-del-ph="${i}" aria-label="Remove instance">Remove</button>` : ''}
    </div>`).join('') || '<div class="empty">No instance configured</div>';
}

const phFieldEdit = (e) => {
  const t = e.target.closest('[data-ph]');
  if (!t) return;
  phDraft[Number(t.dataset.ph)][t.dataset.k] = t.value;
};
$('#phConfigList').addEventListener('input', phFieldEdit);
$('#addPhBtn').addEventListener('click', () => {
  if (phDraft.length >= 8) { toast('A maximum of 8 instances is supported', 'err'); return; }
  phDraft.push({ label: `Instance ${phDraft.length + 1}`, url: '', password: '', hasPassword: false });
  renderPhConfig();
});
$('#phConfigList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-ph]');
  const test = e.target.closest('[data-test-ph]');
  if (del) {
    phDraft.splice(Number(del.dataset.delPh), 1);
    renderPhConfig();
    const m = $('#piholeCfgMsg');
    m.textContent = 'Removed from the list. Select Save configuration to apply.';
    m.className = 'hint';
  } else if (test) {
    const ph = phDraft[Number(test.dataset.testPh)];
    await testDevice({ target: 'pihole', url: ph.url, password: ph.password }, $('#piholeCfgMsg'), test);
  }
});

async function loadAdminConfig() {
  try {
    const d = await getJson('/manager/admin/config');
    const c = d.config;
    phDraft = (c.piholes && c.piholes.length ? c.piholes : [{
      id: 'pihole1', label: 'Primary', url: c.pihole.url || '', hasPassword: c.pihole.hasPassword,
    }]).map((ph) => ({ ...ph, password: '' }));
    renderPhConfig();
    $('#cfgPiholeTls').checked = !!c.pihole.insecureTls;
    $('#cfgGwHost').value = c.gateway.host || '';
    $('#cfgGwLabel').value = c.gateway.model || '';
    $('#cfgGwUser').value = c.gateway.username || 'user';
    $('#cfgGwPw').value = '';
    $('#cfgGwPw').placeholder = c.gateway.hasPassword ? 'password set (blank = unchanged)' : 'no password set';
    $('#cfgGwVendor').innerHTML = vendorOptions(c.gateway.vendor);
    $('#cfgGwDriver').innerHTML = driverOptions(c.gateway.driver || '');
    syncGwVendor();
    apDraft = (c.aps || []).map((a) => ({ ...a, password: '' }));
    renderApConfig();
  } catch (e) { toast(`Could not load the configuration: ${e.message}`, 'err'); }
}

function renderApConfig() {
  $('#apCfgCount').textContent = apDraft.length;
  $('#apConfigList').innerHTML = apDraft.map((a, i) => `
    <div class="ap-cfg-row">
      <input type="text" data-ap="${i}" data-k="host" value="${esc(a.host || '')}" placeholder="192.168.1.3" aria-label="AP IP" />
      <input type="text" data-ap="${i}" data-k="label" value="${esc(a.label || '')}" placeholder="Archer AX10" aria-label="AP label" />
      <input type="text" data-ap="${i}" data-k="username" value="${esc(a.username || 'admin')}" placeholder="admin" aria-label="AP username" />
      <input type="password" data-ap="${i}" data-k="password" value="" placeholder="${a.hasPassword ? 'password set (blank = unchanged)' : 'password'}" aria-label="AP password" autocomplete="off" />
      <select data-ap="${i}" data-k="vendor" aria-label="AP vendor">${vendorOptions(a.vendor)}</select>
      <select data-ap="${i}" data-k="driver" aria-label="AP model / driver" ${vendorUsesDrivers(a.vendor) ? '' : 'style="display:none"'}>${driverOptions(a.driver || '')}</select>
      <button class="btn btn-sm" data-test-ap="${i}">Test</button>
      <button class="btn btn-sm btn-icon-sm" data-del-ap="${i}" aria-label="Remove access point ${i + 1}" title="Remove access point ${i + 1}">${iconHtml('trash')}</button>
    </div>`).join('') || '<div class="empty">No access points configured</div>';
}

const apFieldEdit = (e) => {
  const t = e.target.closest('[data-ap]'); if (!t) return;
  apDraft[Number(t.dataset.ap)][t.dataset.k] = t.value;
  if (t.dataset.k === 'vendor') renderApConfig();   // model list only applies to TP-Link
};
$('#apConfigList').addEventListener('input', apFieldEdit);
$('#apConfigList').addEventListener('change', apFieldEdit);   // <select>
$('#driverFilter').addEventListener('input', debounce(renderDriverList));
$('#addApBtn').addEventListener('click', () => {
  if (apDraft.length >= 8) { toast('Maximum of 8 access points', 'err'); return; }
  apDraft.push({ host: '', label: `AP ${apDraft.length + 1}`, username: 'admin', password: '', driver: '', vendor: 'tplink', hasPassword: false });
  renderApConfig();
});
$('#apConfigList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-ap]'), test = e.target.closest('[data-test-ap]');
  if (del) {
    apDraft.splice(Number(del.dataset.delAp), 1);
    renderApConfig();
    $('#apCfgMsg').textContent = 'Removed from the list — click "Save configuration" to apply.';
    $('#apCfgMsg').className = 'hint';
  } else if (test) {
    const a = apDraft[Number(test.dataset.testAp)];
    await testDevice({ target: 'ap', host: a.host, username: a.username, password: a.password, driver: a.driver || '', vendor: a.vendor || 'tplink' }, $('#apCfgMsg'), test);
  }
});

async function testDevice(payload, msgEl, btn) {
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  msgEl.textContent = 'Testing connection…'; msgEl.className = 'hint';
  try {
    const r = await fetch('/manager/admin/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const d = await r.json();
    msgEl.textContent = (d.ok ? '✓ ' : '✕ ') + (d.message || (d.ok ? 'OK' : 'Failed'));
    msgEl.className = `hint ${d.ok ? 'ok' : 'error'}`;
  } catch (e) {
    msgEl.textContent = `✕ ${e.message}`; msgEl.className = 'hint error';
  } finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}

// Pi-hole instances are tested per row — see the #phConfigList handler above.
$('#testGwBtn').addEventListener('click', (e) => testDevice(
  { target: 'gateway', host: $('#cfgGwHost').value.trim(), username: $('#cfgGwUser').value.trim(),
    password: $('#cfgGwPw').value, driver: $('#cfgGwDriver').value, vendor: $('#cfgGwVendor').value },
  $('#gwCfgMsg'), e.target));
function syncGwVendor() {
  const uses = vendorUsesDrivers($('#cfgGwVendor').value);
  $('#cfgGwDriver').style.display = uses ? '' : 'none';
}
$('#cfgGwVendor').addEventListener('change', syncGwVendor);
$('#reloadCfgBtn').addEventListener('click', () => { loadAdminConfig(); toast('Reloaded saved configuration'); });

$('#saveCfgBtn').addEventListener('click', async () => {
  const msg = $('#saveCfgMsg');
  const body = {
    piholes: phDraft.filter((ph) => String(ph.url || '').trim()).map((ph) => ({
      id: ph.id, label: ph.label, url: ph.url, password: ph.password,
    })),
    pihole: { insecureTls: $('#cfgPiholeTls').checked },
    gateway: {
      host: $('#cfgGwHost').value.trim(),
      model: $('#cfgGwLabel').value.trim(),
      username: $('#cfgGwUser').value.trim(),
      password: $('#cfgGwPw').value,
      driver: $('#cfgGwDriver').value,
      vendor: $('#cfgGwVendor').value,
    },
    aps: apDraft.filter((a) => String(a.host || '').trim()),
  };
  if (!(await confirmDialog('Apply this configuration?\nBlackhole.Net will immediately start using the new addresses and credentials.',
    { title: 'Save configuration', yes: 'Save & apply' }))) return;
  msg.textContent = 'Saving…'; msg.className = 'hint';
  try {
    const r = await fetch('/manager/admin/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.message || 'Failed');
    msg.textContent = 'Configuration saved and applied.'; msg.className = 'hint ok';
    toast('Configuration applied', 'ok');
    loadAdminConfig();
    loadPiholeFleet();
    initHost();
  } catch (e) { msg.textContent = e.message; msg.className = 'hint error'; }
});

// ===========================================================================
//  Boot + auto-refresh
// ===========================================================================
loaders.overview = guard(loadOverview);
loaders.mesh = guard(loadMesh);
loaders.insights = guard(loadInsights);
loaders.queries = guard(loadQueries);
loaders.domains = guard(loadDomains);
loaders.lists = guard(loadLists);
loaders.groups = guard(loadGroups);
loaders.clients = guard(loadClients);
loaders.localdns = guard(loadLocalDns);
loaders.dhcp = guard(loadDhcp);
loaders.gateway = guard(loadGateway);
loaders.infra = guard(loadInfra);
loaders.admin = guard(loadAdmin);
loaders.network = guard(loadNetwork);
loaders.diagnostics = guard(loadDiagnostics);
loaders.settings = guard(loadSettings);
loaders.backup = () => {}; // action-driven section, nothing to preload

async function initHost() {
  try {
    const h = await getJson('/manager/health');
    $('#hostLabel').textContent = h.pihole || '';
    const badge = $('#connBadge'), vt = $('#verText');
    if (h.connected) { badge.className = 'conn ok'; $('#connText').textContent = 'Connected'; }
    else { badge.className = 'conn bad'; $('#connText').textContent = 'Offline'; }
    if (h.version?.core?.local?.version) vt.textContent = `Core ${h.version.core.local.version}`;
  } catch { $('#connBadge').className = 'conn bad'; $('#connText').textContent = 'Offline'; }
}

function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
  // live countdown while blocking is temporarily disabled
  if (blockTimerEnd && blockingState !== 'enabled') {
    const left = Math.max(0, Math.round((blockTimerEnd - Date.now()) / 1000));
    $('#blockingSub').textContent = left > 0 ? `resumes ${left}s` : 'resuming…';
    if (left <= 0) { blockTimerEnd = null; setTimeout(loadBlocking, 1500); }
  }
}
setInterval(tickClock, 1000); tickClock();

// Canvases are CSS-sized now, so a viewport change needs a repaint.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const active = document.querySelector('.nav-item.active')?.dataset.section;
    if (active === 'overview') loaders.overview?.();
    else if (active === 'gateway') drawRouterHistory();
    else if (active === 'mesh') loaders.mesh?.();
  }, 200);
});

$('#refreshBtn').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.classList.add('is-busy');
  b.disabled = true;
  const active = document.querySelector('.nav-item.active')?.dataset.section;
  const t0 = Date.now();
  try { await Promise.allSettled([loadBlocking(), loaders[active]?.()]); }
  finally {
    // Hold for a 450ms minimum so a 40ms round trip reads as a spin rather than
    // a flicker.
    const wait = Math.max(0, 450 - (Date.now() - t0));
    setTimeout(() => { b.classList.remove('is-busy'); b.disabled = false; }, wait);
    toast('Refreshed');
  }
});

initHud();
initTheme();
(async () => {
  if (!(await loadMe())) return;      // redirects to /login.html when signed out
  initHost(); loadBlocking(); loaders.overview();
})();

// Auto-refresh: blocking always; live sections when visible.
const LIVE_SECTIONS = new Set(['overview', 'gateway', 'mesh']);
setInterval(() => {
  loadBlocking();
  const active = document.querySelector('.nav-item.active')?.dataset.section;
  // never re-render the map out from under a drag/pan in progress
  if (active === 'mesh' && meshBusy) return;
  if (LIVE_SECTIONS.has(active)) loaders[active]?.();
  else if (active === 'queries' && $('#queryLive').checked) loaders.queries();
}, 15000);
