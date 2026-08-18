// Blackhole.Net — Express server.
// - Authenticates to Pi-hole v6 (cached session, deduped re-auth) and proxies /ph/*
// - Teleporter backup/restore (binary + multipart)
// - Gateway/internet health via TCP-connect probes
// - Router sidecar proxy (TP-Link deep telemetry)
// - /manager/mesh: fused network topology (Pi-hole + DHCP + router + live latency)

import express from 'express';
import compression from 'compression';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import {
  attachUser, requireRole, login, logout, changeOwnPassword,
  bootstrapAdmin, listUsers, createUser, updateUser, deleteUser, publicUser, loadUsers,
  loadConfig, saveConfig, redactConfig, ROLE_NAMES,
} from './auth.js';

import { startSidecar, stopSidecar, sidecarState } from './sidecar.js';
import { initAutomation, automationRouter, automationStatus } from './automation.js';
import { dbProfile, dbUpdateProfile, dbAvatar, dbSetAvatar, dbClearAvatar } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Asset fingerprinting.
//
// The browser cannot be relied on to notice that style.css changed: a bare
// `style.css` is the SAME URL before and after a deploy, so a cached copy stays
// valid until the browser chooses to revalidate. Giving the URL a content hash
// makes staleness impossible by construction rather than by convention — new
// bytes mean a new URL, and the old one is simply never requested again.
//
// public/ is baked into the image and never mutates at runtime, so hashing once
// at startup is correct; a restart is the only way the files can change.
// ---------------------------------------------------------------------------
const ASSETS = ['style.css', 'app.js'];
const assetHash = Object.create(null);
for (const f of ASSETS) {
  try {
    assetHash[f] = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, 'public', f))).digest('hex').slice(0, 12);
  } catch { assetHash[f] = 'dev'; }
}

// Rewrite the asset references once, at startup, and serve the result from
// memory. Anchored on the quote so a substring like "app.js.map" cannot match.
function fingerprintHtml(file) {
  let html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  for (const f of ASSETS) html = html.split(`"${f}"`).join(`"${f}?v=${assetHash[f]}"`);
  return html;
}
const PAGES = Object.create(null);
for (const p of ['index.html', 'login.html']) {
  try { PAGES[p] = fingerprintHtml(p); } catch { /* login-only deploys */ }
}

// HTML must always be revalidated — it is what carries the new asset URLs. An
// HTML response cached even briefly pins the client to the previous deploy.
function sendPage(res, name) {
  const body = PAGES[name];
  if (body === undefined) return res.status(404).end();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(body);
}

// A fingerprinted request can be cached for a year; an unfingerprinted or stale
// one must revalidate, so an old URL can never pin a client to old bytes.
function sendAsset(req, res, name) {
  res.setHeader('Cache-Control', req.query.v === assetHash[name]
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');
  res.sendFile(path.join(__dirname, 'public', name));
}

// Runtime configuration lives in data/config.json (seeded from .env on first
// run) so it can be edited from the admin panel without touching the host.
let CFG = loadConfig();
const cfgPihole = () => (CFG.pihole.url || 'http://192.168.1.10').replace(/\/+$/, '');

let PIHOLE_URL = cfgPihole();
let PIHOLE_HOST = new URL(PIHOLE_URL).hostname;
let PIHOLE_PASSWORD = CFG.pihole.password || '';
let GATEWAY_HOST = CFG.gateway.host || '192.168.1.1';
let ROUTER_MODEL = CFG.gateway.model || '';

// ---------------------------------------------------------------------------
// Pi-hole instances. One session per instance, so several can be managed and
// the Overview can aggregate across them (e.g. an HA pair).
// ---------------------------------------------------------------------------
const phSessions = new Map();   // instance id -> { sid, expiresAt, inFlight }

function instances() {
  const list = (CFG.piholes || []).filter((p) => p.url);
  if (list.length) return list;
  return CFG.pihole.url ? [{ id: 'pihole1', label: 'Primary', url: CFG.pihole.url, password: CFG.pihole.password }] : [];
}
const primaryInstance = () => instances()[0] || null;
function instanceById(id) {
  const list = instances();
  return list.find((p) => p.id === id) || list[0] || null;
}
const PORT = Number(process.env.PORT || 3000);
// The sidecar now runs inside this container on loopback, so it has a working
// default instead of being "not configured" until an env var is supplied.
const ROUTER_SERVICE_URL = (process.env.ROUTER_SERVICE_URL
  || `http://127.0.0.1:${process.env.ROUTER_PORT || 5000}`).replace(/\/+$/, '');

function applyConfig(cfg) {
  CFG = cfg;
  PIHOLE_URL = cfgPihole();
  PIHOLE_HOST = new URL(PIHOLE_URL).hostname;
  PIHOLE_PASSWORD = CFG.pihole.password || '';
  GATEWAY_HOST = CFG.gateway.host || '192.168.1.1';
  ROUTER_MODEL = CFG.gateway.model || '';
  session = { sid: null, expiresAt: 0 };   // creds may have changed
  phSessions.clear();
  meshProbeCache.clear(); openPortCache.clear();
}

if (CFG.pihole.insecureTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const boot = bootstrapAdmin();

const app = express();
// Do NOT trust X-Forwarded-For: this is served directly on the LAN, and a
// spoofed header would let an attacker reset the login throttle at will.
app.set('trust proxy', false);
app.use(compression()); // gzip/brotli all responses
app.use(express.json());
app.use(attachUser);

// --- public assets: the login page and its styling only.
// These run BEFORE the express.static below, so its Cache-Control never reached
// them: res.sendFile defaults to `public, max-age=0`, which let a browser reuse
// a cached stylesheet across a deploy. They must set their own headers.
app.get('/login.html', (_req, res) => sendPage(res, 'login.html'));
app.get('/style.css', (req, res) => sendAsset(req, res, 'style.css'));

// --- auth endpoints
app.post('/auth/login', login);
app.post('/auth/logout', logout);
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  const u = loadUsers().find((x) => x.username === req.user.username);
  res.json({ ok: true, user: u ? publicUser(u) : req.user, roles: ROLE_NAMES });
});
app.post('/auth/password', requireRole('reader'), changeOwnPassword);

// ---------------------------------------------------------------------------
// Profile — self-service, for every role including reader.
//
// `role` is NOT accepted here. A self-service endpoint that reads a role from
// its own request body is a privilege escalation: a reader could promote
// themselves to admin. Role changes stay on the admin-gated user management.
// ---------------------------------------------------------------------------
const MAX_AVATAR = 512 * 1024;

// Validate by MAGIC BYTES, never by filename or the client-supplied
// Content-Type — both are attacker-controlled. SVG is refused outright: it can
// carry <script>, and serving one from our own origin is stored XSS.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanProfile(body) {
  const out = {};
  const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
  for (const [k, n] of [['displayName', 80], ['nickname', 40], ['title', 80],
                        ['location', 80], ['timezone', 64]]) {
    if (k in body) out[k] = str(body[k], n);
  }
  if ('dob' in body) {
    const d = str(body.dob, 10);
    if (d === '') out.dob = '';
    else {
      if (!DOB_RE.test(d)) return { error: 'Date of birth must be in the form YYYY-MM-DD.' };
      const t = Date.parse(`${d}T00:00:00Z`);
      const year = Number(d.slice(0, 4));
      if (!Number.isFinite(t) || t > Date.now()) return { error: 'Date of birth cannot be in the future.' };
      if (year < 1900) return { error: 'Date of birth looks implausible.' };
      out.dob = d;
    }
  }
  if (out.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: out.timezone }); }
    catch { return { error: 'Not a recognised IANA time zone, for example Asia/Kolkata.' }; }
  }
  return { fields: out };
}

app.get('/auth/profile', requireRole('reader'), (req, res) => {
  const p = dbProfile(req.user.username);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json({ profile: p });
});

app.post('/auth/profile', requireRole('reader'), (req, res) => {
  const c = cleanProfile(req.body || {});
  if (c.error) return res.status(400).json({ error: 'bad_field', message: c.error });
  if (!Object.keys(c.fields).length) return res.status(400).json({ error: 'empty', message: 'Nothing to update.' });
  res.json({ profile: dbUpdateProfile(req.user.username, c.fields) });
});

app.post('/auth/avatar', requireRole('reader'),
  express.raw({ type: '*/*', limit: MAX_AVATAR }), (req, res) => {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'no_file', message: 'No image received.' });
    if (buf.length > MAX_AVATAR) {
      return res.status(413).json({ error: 'too_large', message: 'The image must be under 512 KB.' });
    }
    const type = sniffImage(buf);
    if (!type) {
      return res.status(415).json({ error: 'bad_type',
        message: 'Only PNG, JPEG and WebP images are accepted. SVG is not permitted.' });
    }
    dbSetAvatar(req.user.username, buf, type);
    res.json({ ok: true, type, bytes: buf.length });
  });

app.delete('/auth/avatar', requireRole('reader'), (req, res) => {
  dbClearAvatar(req.user.username);
  res.json({ ok: true });
});

// Any signed-in user may render another's avatar (they already see usernames in
// the Admin table), but nothing is served to an unauthenticated caller.
app.get('/auth/avatar/:username', requireRole('reader'), (req, res) => {
  const a = dbAvatar(String(req.params.username || ''));
  if (!a) return res.status(404).end();
  res.setHeader('Content-Type', a.type);
  // nosniff so a crafted payload cannot be re-interpreted as HTML/JS, and the
  // CSP forbids everything even if it somehow were.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.send(a.bytes);
});

// --- everything else needs at least a reader session
app.use((req, res, next) => {
  if (req.user) return next();
  if (req.method === 'GET' && !req.path.startsWith('/ph/') && !req.path.startsWith('/manager/')) {
    return res.redirect('/login.html');           // browser navigation
  }
  res.status(401).json({ error: 'unauthenticated', message: 'Sign in to continue' });
});

// Ahead of express.static so the fingerprinted copies win; static still serves
// icons, fonts and anything else under public/.
app.get(['/', '/index.html'], (_req, res) => sendPage(res, 'index.html'));
app.get('/app.js', (req, res) => sendAsset(req, res, 'app.js'));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'), // revalidate; etags still apply
}));

// ---------------------------------------------------------------------------
// Pi-hole session — cached, with deduped concurrent authentication.
// ---------------------------------------------------------------------------
let session = { sid: null, expiresAt: 0 };
let authInFlight = null; // concurrent callers share one auth round-trip

async function authenticate() {
  const res = await fetch(`${PIHOLE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PIHOLE_PASSWORD }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Pi-hole authentication failed (HTTP ${res.status}). ${text}`);
  }
  const data = await res.json();
  const s = data.session;
  if (!s || !s.valid) throw new Error('Pi-hole rejected the password. Check PIHOLE_PASSWORD in your .env file.');
  if (!s.sid) {
    // Passwordless Pi-hole: valid session with no SID. Cache a sentinel so we
    // don't re-authenticate on every single request.
    session = { sid: '', expiresAt: Date.now() + 3600000 };
    return '';
  }
  session = { sid: s.sid, expiresAt: Date.now() + Math.max(30, (s.validity || 300) - 30) * 1000 };
  return session.sid;
}

function getSid() {
  if (session.sid !== null && Date.now() < session.expiresAt) return Promise.resolve(session.sid);
  if (!authInFlight) {
    authInFlight = authenticate().finally(() => { authInFlight = null; });
  }
  return authInFlight;
}

// --- per-instance variants of the auth/call helpers -----------------------
async function authenticateInstance(inst) {
  const res = await fetch(`${inst.url}/api/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: inst.password || '' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${inst.label}: authentication failed (HTTP ${res.status})`);
  const d = await res.json();
  if (!d.session || !d.session.valid) throw new Error(`${inst.label}: password rejected`);
  const st = { sid: d.session.sid || '', expiresAt: Date.now() + Math.max(30, (d.session.validity || 300) - 30) * 1000 };
  phSessions.set(inst.id, st);
  return st.sid;
}

function getSidFor(inst) {
  const st = phSessions.get(inst.id);
  if (st && st.sid !== null && Date.now() < st.expiresAt) return Promise.resolve(st.sid);
  if (st && st.inFlight) return st.inFlight;
  const inFlight = authenticateInstance(inst).finally(() => {
    const cur = phSessions.get(inst.id);
    if (cur) delete cur.inFlight;
  });
  phSessions.set(inst.id, { ...(st || {}), sid: null, expiresAt: 0, inFlight });
  return inFlight;
}

async function callInstance(inst, apiPath, { method = 'GET', query = '', body } = {}) {
  const build = (sid) => {
    const init = {
      method,
      headers: { Accept: 'application/json', ...(sid ? { 'X-FTL-SID': sid } : {}) },
      signal: AbortSignal.timeout(timeoutFor(apiPath)),
    };
    if (body !== undefined && !['GET', 'HEAD'].includes(method)) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return init;
  };
  const url = `${inst.url}/api/${apiPath}${query ? `?${query}` : ''}`;
  let r = await fetch(url, build(await getSidFor(inst)));
  if (r.status === 401) {
    phSessions.delete(inst.id);
    r = await fetch(url, build(await getSidFor(inst)));
  }
  return r;
}

async function instanceJson(inst, apiPath) {
  const r = await callInstance(inst, apiPath);
  if (!r.ok) throw new Error(`${inst.label}/${apiPath}: HTTP ${r.status}`);
  return r.json();
}

// Long-running Pi-hole actions get a generous timeout; everything else 20s.
const timeoutFor = (apiPath) => (/^action\/gravity|^teleporter/.test(apiPath) ? 180000 : 20000);
// (callers pass the canonical authzPath so an encoded variant can't dodge it)

async function callPihole(apiPath, { method = 'GET', query = '', body } = {}, sid) {
  const url = `${PIHOLE_URL}/api/${apiPath}${query ? `?${query}` : ''}`;
  const init = {
    method,
    headers: { Accept: 'application/json', ...(sid ? { 'X-FTL-SID': sid } : {}) },
    signal: AbortSignal.timeout(timeoutFor(apiPath)),
  };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

// Server-side JSON helper with one 401 retry — used by mesh and health routes.
async function piholeJson(apiPath) {
  let sid = await getSid();
  let r = await callPihole(apiPath, {}, sid);
  if (r.status === 401) {
    session = { sid: null, expiresAt: 0 };
    sid = await getSid();
    r = await callPihole(apiPath, {}, sid);
  }
  if (!r.ok) throw new Error(`${apiPath}: HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Generic authenticated proxy: /ph/<pihole-api-path>
// ---------------------------------------------------------------------------
// Canonicalise the proxied path ONCE, and authorise on exactly what the
// upstream will receive.
//
// This is security-critical. Express leaves req.originalUrl un-normalised, but
// the WHATWG parser inside fetch() removes dot segments — so testing the raw
// string let "PATCH /ph/./config" (and "%63onfig", and "x/../config") slip past
// an admin-only rule and still land on /api/config with the cached Pi-hole
// admin session. "GET /ph/../admin/" likewise escaped the /api/ prefix entirely.
//
// Returns { encodedPath, authzPath } or null when the path is unusable:
//   encodedPath — normalised but still percent-encoded, safe to forward
//                 (preserves "127.0.0.1%235335", regex '?', adlist URLs)
//   authzPath   — same path with each SEGMENT decoded, for the role decision.
//                 Decoding per-segment means an encoded '/' inside a value
//                 cannot fabricate a new path segment.
function resolvePhPath(originalUrl) {
  const raw = originalUrl.split('?')[0].replace(/^\/ph\/?/, '');
  let canon;
  try { canon = new URL(`/api/${raw}`, PIHOLE_URL); } catch { return null; }
  if (canon.pathname !== '/api' && !canon.pathname.startsWith('/api/')) return null; // ../ escaped the API root
  const encodedPath = canon.pathname.replace(/^\/api\/?/, '');
  const segments = encodedPath.split('/');
  const decoded = segments.map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (decoded.some((s) => s === '.' || s === '..')) return null;  // traversal smuggled via encoding
  return { encodedPath, authzPath: decoded.join('/') };
}

// Role rules, evaluated against the canonical path:
//   GET/HEAD       -> reader
//   config/*       -> admin        (DNS servers, DNSSEC, listening mode, …)
//   everything else-> contributor  (domains, lists, groups, clients, actions)
function phRequiredRole(method, authzPath) {
  if (method === 'GET' || method === 'HEAD') return 'reader';
  if (/^config(\/|$)/.test(authzPath)) return 'admin';
  return 'contributor';
}

app.all('/ph/*', (req, res, next) => {
  const resolved = resolvePhPath(req.originalUrl);
  if (!resolved) {
    return res.status(400).json({ error: 'bad_path', message: 'Invalid API path' });
  }
  req.ph = resolved;
  requireRole(phRequiredRole(req.method, resolved.authzPath))(req, res, next);
}, async (req, res) => {
  const apiPath = req.ph.encodedPath;
  const params = new URL(req.originalUrl, 'http://x').searchParams;
  // `ph` selects which Pi-hole instance to talk to; it is ours, not Pi-hole's.
  const wanted = params.get('ph');
  params.delete('ph');
  const query = params.toString();
  const method = req.method;
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? req.body : undefined;

  try {
    const inst = wanted ? instanceById(wanted) : primaryInstance();
    if (!inst) {
      return res.status(503).json({ error: 'not_configured', message: 'No Pi-hole instance is configured' });
    }
    const phRes = await callInstance(inst, apiPath, { method, query, body });
    const contentType = phRes.headers.get('content-type') || '';
    res.status(phRes.status);
    if (contentType.includes('application/json')) {
      res.json(await phRes.json().catch(() => ({})));
    } else {
      res.type(contentType || 'text/plain').send(await phRes.text());
    }
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'upstream_timeout' : 'proxy_error',
      message: err.message || String(err),
      pihole: PIHOLE_URL,
    });
  }
});

// ---------------------------------------------------------------------------
// Teleporter (config backup / restore)
// ---------------------------------------------------------------------------
// Callable form of the export, so the scheduled backup automation reads the
// archive through exactly the same auth and retry path as the download button.
// Deliberately still the PRIMARY instance only (via getSid, not callInstance) —
// that is the existing behaviour and widening it is not this change's job.
let lastExportName = 'pihole-backup.zip';
async function teleporterBuffer() {
  let sid = await getSid();
  const opts = () => ({ headers: { 'X-FTL-SID': sid }, signal: AbortSignal.timeout(60000) });
  let r = await fetch(`${PIHOLE_URL}/api/teleporter`, opts());
  if (r.status === 401) {
    session = { sid: null, expiresAt: 0 };
    sid = await getSid();
    r = await fetch(`${PIHOLE_URL}/api/teleporter`, opts());
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${t}`.trim());
  }
  lastExportName = r.headers.get('content-disposition') || 'attachment; filename="pihole-backup.zip"';
  return Buffer.from(await r.arrayBuffer());
}

app.get('/manager/teleporter/export', requireRole('admin'), async (_req, res) => {
  try {
    const buf = await teleporterBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', lastExportName);
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'export_error', message: e.message });
  }
});

app.post('/manager/teleporter/import', requireRole('admin'), express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'no_file', message: 'No file uploaded' });
    const build = () => {
      const form = new FormData();
      form.append('file', new Blob([req.body], { type: 'application/zip' }), 'backup.zip');
      return form;
    };
    let sid = await getSid();
    const opts = () => ({ method: 'POST', headers: { 'X-FTL-SID': sid }, body: build(), signal: AbortSignal.timeout(120000) });
    let r = await fetch(`${PIHOLE_URL}/api/teleporter`, opts());
    if (r.status === 401) {
      session = { sid: null, expiresAt: 0 };
      sid = await getSid();
      r = await fetch(`${PIHOLE_URL}/api/teleporter`, opts());
    }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json().catch(() => ({})) : { raw: await r.text().catch(() => '') };
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'import_error', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Gateway / internet health — TCP-connect timing (no ICMP needed in container)
// ---------------------------------------------------------------------------
function tcpProbe(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      sock.destroy();
      resolve({ ok, ms: ok ? Number((performance.now() - start).toFixed(1)) : null });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function probeSamples(host, port, n = 4) {
  const rs = await Promise.all(Array.from({ length: n }, () => tcpProbe(host, port))); // parallel — was serial
  const oks = rs.filter((r) => r.ok).map((r) => r.ms);
  const avg = oks.length ? Number((oks.reduce((a, b) => a + b, 0) / oks.length).toFixed(1)) : null;
  const jitter = oks.length > 1 ? Number((Math.max(...oks) - Math.min(...oks)).toFixed(1)) : 0;
  return {
    up: oks.length > 0, latency: avg, jitter,
    loss: Number((((n - oks.length) / n) * 100).toFixed(0)),
    min: oks.length ? Math.min(...oks) : null, max: oks.length ? Math.max(...oks) : null,
  };
}

app.get('/manager/gateway/health', async (_req, res) => {
  try {
    const [gateway, internet] = await Promise.all([
      probeSamples(GATEWAY_HOST, 80),
      probeSamples('1.1.1.1', 443),
    ]);
    res.json({
      gateway: { host: GATEWAY_HOST, model: ROUTER_MODEL, webUrl: `http://${GATEWAY_HOST}`, ...gateway },
      internet: { target: '1.1.1.1:443', ...internet },
    });
  } catch (e) {
    res.status(502).json({ error: 'gateway_health_error', message: e.message });
  }
});

app.get('/manager/gateway/wan', requireRole('contributor'), async (_req, res) => {
  try {
    const r = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    res.json({ ip: d.ip, org: d.connection?.isp || d.connection?.org, city: d.city, region: d.region, country: d.country, flag: d.flag?.emoji });
  } catch (e) {
    res.status(502).json({ error: 'wan_lookup_failed', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Router sidecar proxy
// ---------------------------------------------------------------------------
async function routerJson(pathName, timeout = 30000) {
  if (!ROUTER_SERVICE_URL) throw new Error('router sidecar not configured');
  const r = await fetch(`${ROUTER_SERVICE_URL}${pathName}`, { signal: AbortSignal.timeout(timeout) });
  return { status: r.status, data: await r.json().catch(() => ({ ok: false, error: 'bad_json' })) };
}

async function proxyRouter(pathName, res) {
  if (!ROUTER_SERVICE_URL) {
    return res.status(503).json({ ok: false, error: 'not_configured', message: 'Router sidecar not configured' });
  }
  try {
    const { status, data } = await routerJson(pathName);
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: 'router_service_unreachable', message: e.message });
  }
}
// The sidecar holds NO credentials of its own — they live in SQLite and are
// pushed here. Retried on boot because the sidecar may still be starting.
async function pushRouterConfig(cfg = CFG, { retries = 6, delay = 4000 } = {}) {
  if (!ROUTER_SERVICE_URL) return false;
  const body = JSON.stringify({ gateway: cfg.gateway, aps: cfg.aps });
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${ROUTER_SERVICE_URL}/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        console.log(`  router sidecar configured (${(cfg.aps || []).length} AP(s))`);
        return true;
      }
    } catch { /* sidecar not up yet */ }
    await new Promise((res) => setTimeout(res, delay));
  }
  console.log('  WARNING: could not push config to the router sidecar');
  return false;
}

app.get('/manager/sidecar', requireRole('reader'), (_req, res) => res.json(sidecarState()));
app.get('/manager/router/status', (_req, res) => proxyRouter('/status', res));
app.get('/manager/router/history', (_req, res) => proxyRouter('/history', res));
app.get('/manager/router/aps', (_req, res) => proxyRouter('/aps', res));
app.get('/manager/router/roaming', (_req, res) => proxyRouter('/roaming', res));
app.get('/manager/router/drivers', (_req, res) => proxyRouter('/clients', res));

// Control plane (reboot / Wi-Fi radios). Disruptive by nature — the UI gates
// each of these behind an explicit confirmation.
app.post('/manager/router/:id/:action', requireRole('admin'), async (req, res) => {
  const { id, action } = req.params;
  if (!['reboot', 'wifi'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'bad_action' });
  }
  if (!ROUTER_SERVICE_URL) {
    return res.status(503).json({ ok: false, error: 'not_configured', message: 'Router sidecar not configured' });
  }
  try {
    const r = await fetch(`${ROUTER_SERVICE_URL}/control/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(45000),
    });
    res.status(r.status).json(await r.json().catch(() => ({ ok: false, error: 'bad_json' })));
  } catch (e) {
    res.status(502).json({ ok: false, error: 'router_service_unreachable', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Network mesh — fused topology from Pi-hole + DHCP + router + live probes
// ---------------------------------------------------------------------------
const PROBE_PORTS = [80, 443, 22, 8080, 445, 53];
const meshProbeCache = new Map(); // ip -> { latency, port, ts }
const openPortCache = new Map(); // ip -> port | null (which port answered last)
const MESH_PROBE_TTL = 30000;

// Phase 1 — discovery: race candidate ports to find one that answers.
function discoverPort(ip) {
  return new Promise((resolve) => {
    let pending = PROBE_PORTS.length;
    let done = false;
    for (const port of PROBE_PORTS) {
      tcpProbe(ip, port, 1500).then((r) => {
        if (r.ok && !done) { done = true; resolve(port); }
        if (--pending === 0 && !done) resolve(null);
      });
    }
  });
}

// Phase 2 — measurement: time a SINGLE socket to the known-open port, so the
// number isn't inflated by dozens of concurrent connections.
async function measureDevice(ip) {
  let port = openPortCache.get(ip);
  if (port === undefined) {
    port = await discoverPort(ip);
    openPortCache.set(ip, port);
  }
  if (port === null) return { latency: null, port: null };
  const a = await tcpProbe(ip, port, 1500);
  if (!a.ok) { // port closed since discovery — re-discover next sweep
    openPortCache.delete(ip);
    return { latency: null, port: null };
  }
  const b = await tcpProbe(ip, port, 1500);
  const ms = b.ok ? Math.min(a.ms, b.ms) : a.ms; // best of two = least queuing noise
  return { latency: Number(ms.toFixed(1)), port };
}

async function probeDevices(ips) {
  const now = Date.now();
  const need = ips.filter((ip) => {
    const c = meshProbeCache.get(ip);
    return !c || now - c.ts > MESH_PROBE_TTL;
  });
  // Low concurrency keeps measurements honest (few sockets in flight at once).
  const LIMIT = 6;
  for (let i = 0; i < need.length; i += LIMIT) {
    await Promise.all(need.slice(i, i + LIMIT).map(async (ip) => {
      const r = await measureDevice(ip);
      meshProbeCache.set(ip, { ...r, ts: Date.now() });
    }));
  }
  const out = {};
  for (const ip of ips) out[ip] = meshProbeCache.get(ip) || { latency: null, port: null };
  return out;
}

app.get('/manager/mesh', async (_req, res) => {
  try {
    const [devicesR, leasesR, dhcpConfR, routerR, apsR, roamR, gwR, inetR, phR] = await Promise.allSettled([
      piholeJson('network/devices?max_devices=100'),
      piholeJson('dhcp/leases'),
      piholeJson('config/dhcp'),
      ROUTER_SERVICE_URL ? routerJson('/status', 25000) : Promise.reject(new Error('no sidecar')),
      ROUTER_SERVICE_URL ? routerJson('/aps', 25000) : Promise.reject(new Error('no sidecar')),
      ROUTER_SERVICE_URL ? routerJson('/roaming', 25000) : Promise.reject(new Error('no sidecar')),
      probeSamples(GATEWAY_HOST, 80, 2),
      probeSamples('1.1.1.1', 443, 2),
      probeSamples(PIHOLE_HOST, 80, 2),
    ]);

    // MACs arrive in three formats (aa:bb:.., AA-BB-.., mixed case) from
    // Pi-hole / gateway / APs. Normalize to bare lowercase hex for every join.
    const normMac = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');

    // --- name resolution (static DHCP > lease > AP/router hostname > reverse DNS)
    const nameByIp = {}, nameByMac = {};
    const setName = (ip, mac, name) => {
      if (!name) return;
      if (ip && !nameByIp[ip]) nameByIp[ip] = name;
      const k = normMac(mac);
      if (k && !nameByMac[k]) nameByMac[k] = name;
    };
    const GENERIC = new Set(['unknown', 'network device', '']);

    if (leasesR.status === 'fulfilled') {
      for (const l of leasesR.value.leases || []) setName(l.ip, l.hwaddr, l.name);
    }
    const routerData = routerR.status === 'fulfilled' && routerR.value.data?.ok ? routerR.value.data : null;
    const routerMacs = new Set();
    if (routerData) {
      for (const d of routerData.devices || []) {
        const k = normMac(d.mac);
        if (k) routerMacs.add(k);
        if (!GENERIC.has(String(d.hostname || '').toLowerCase())) setName(d.ip, d.mac, d.hostname);
      }
    }

    // --- access points: which radio each client is actually associated with.
    // Only radio-associated clients prove attachment; an AP in bridge mode also
    // "sees" every wired device on the segment, which proves nothing.
    const apList = (apsR.status === 'fulfilled' ? apsR.value.data?.aps : null) || [];
    const apByMac = {};                 // client mac -> { id, label, band }
    const apSelfMac = {};               // AP's own mac -> ap id
    const apSelfIp = {};                // AP's own ip  -> ap id
    for (const ap of apList) {
      if (ap.ip) apSelfIp[ap.ip] = ap.id;
      if (ap.lan_mac) apSelfMac[normMac(ap.lan_mac)] = ap.id;
      if (!ap.ok) continue;
      for (const d of ap.devices || []) {
        const k = normMac(d.mac);
        if (d.wireless && k) apByMac[k] = { id: ap.id, label: ap.label, band: d.band, signal: d.signal ?? null };
        if (!GENERIC.has(String(d.hostname || '').toLowerCase())) setName(d.ip, d.mac, d.hostname);
      }
    }

    if (dhcpConfR.status === 'fulfilled') {
      for (const h of dhcpConfR.value.config?.dhcp?.hosts || []) {
        const [mac, ip, name] = h.split(',');
        if (!name) continue;
        if (ip) nameByIp[ip] = name;             // admin-defined static names win
        const k = normMac(mac);
        if (k) nameByMac[k] = name;
      }
    }

    // --- roaming state (keyed by normalised MAC)
    const roamData = roamR.status === 'fulfilled' && roamR.value.data?.ok ? roamR.value.data : null;
    const roamAssoc = {};
    if (roamData) for (const [m, v] of Object.entries(roamData.assoc || {})) roamAssoc[normMac(m)] = v;

    // --- build device nodes from Pi-hole's network table
    const now = Math.floor(Date.now() / 1000);
    const rawDevices = devicesR.status === 'fulfilled' ? (devicesR.value.devices || []) : [];
    const nodes = [];
    for (const d of rawDevices) {
      const mac = normMac(d.hwaddr);
      const ips = (d.ips || []).slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      const primary = ips[0];
      if (!primary) continue;
      const ip = primary.ip;
      if (ip === GATEWAY_HOST) continue;                 // the router is the hub, not a leaf
      if (/^127\.|^::1$|^0\.0\.0\.0$/.test(ip)) continue; // loopback isn't a network device
      const isPihole = ip === PIHOLE_HOST;
      const apSelf = apSelfIp[ip] || apSelfMac[mac] || null; // this node IS an AP
      const via = apByMac[mac] || null;                       // attached to an AP's radio
      const revName = ips.find((i) => i.name)?.name || null;
      const name = nameByIp[ip] || nameByMac[mac] || revName || null;
      const lastSeen = Math.max(...ips.map((i) => i.lastSeen || 0), 0);
      nodes.push({
        id: mac || ip,
        kind: isPihole ? 'pihole' : apSelf ? 'ap' : 'device',
        apId: apSelf,                       // set when this node is itself an AP
        name: isPihole ? 'Pi-hole' : name,
        ip, ips: ips.map((i) => i.ip), mac: d.hwaddr,
        vendor: d.macVendor || null, iface: d.interface || null,
        firstSeen: d.firstSeen || null,
        lastQuery: d.lastQuery || null, lastSeen,
        numQueries: d.numQueries || 0,
        direct: routerMacs.has(mac),        // physically visible to the router
        viaAp: via ? via.id : null,         // which AP it is associated with
        viaApLabel: via ? via.label : null,
        band: via ? via.band : null,
        signal: via ? via.signal : null,    // dBm, where the AP reports it
        roams: roamAssoc[mac] ? roamAssoc[mac].roams : 0,
        assocHeld: roamAssoc[mac] ? roamAssoc[mac].held : null, // secs on this AP
        recentlySeen: now - lastSeen < 3600,
      });
    }
    nodes.sort((a, b) => (b.lastQuery || 0) - (a.lastQuery || 0));
    const capped = nodes.slice(0, 40);

    // --- live latency sweep (recently-seen devices + the APs, cached 30s)
    const apIps = apList.map((a) => a.ip).filter(Boolean);
    const probeTargets = [...new Set([...capped.filter((n) => n.recentlySeen).map((n) => n.ip), ...apIps])];
    const probes = await probeDevices(probeTargets);
    for (const n of capped) {
      const p = probes[n.ip];
      n.latency = p ? p.latency : null;
      n.probePort = p ? p.port : null;
    }

    res.json({
      ok: true,
      generated: now,
      internet: inetR.status === 'fulfilled' ? inetR.value : { up: false },
      gateway: {
        host: GATEWAY_HOST,
        model: routerData?.model || ROUTER_MODEL,
        ...(gwR.status === 'fulfilled' ? gwR.value : { up: false }),
        cpu: routerData?.cpu ?? null, mem: routerData?.mem ?? null,
        wan_ip: routerData?.wan_ip || null,
        wifi_2g: routerData?.wifi_2g ?? null, wifi_5g: routerData?.wifi_5g ?? null,
      },
      pihole: {
        host: PIHOLE_HOST,
        ...(phR.status === 'fulfilled' ? phR.value : { up: false }),
      },
      aps: apList.map((a) => ({
        id: a.id, label: a.label, ip: a.ip, ok: !!a.ok, model: a.model || null,
        firmware: a.firmware || null, cpu: a.cpu ?? null, mem: a.mem ?? null,
        wifi_2g: a.wifi_2g ?? null, wifi_5g: a.wifi_5g ?? null,
        clients_total: a.clients_total ?? null,
        wireless_clients: (a.devices || []).filter((d) => d.wireless).length,
        message: a.ok ? null : (a.message || a.error || null),
        latency: probes[a.ip] ? probes[a.ip].latency : null,
      })),
      roaming: roamData ? {
        trackingSince: roamData.tracking_since,
        events: (roamData.events || []).slice(0, 40).map((e) => ({
          ...e, name: nameByMac[normMac(e.mac)] || e.hostname || null,
        })),
        total: (roamData.events || []).length,
      } : null,
      nodes: capped,
      truncated: nodes.length > capped.length ? nodes.length - capped.length : 0,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'mesh_error', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Pi-hole instances: inventory, per-instance health and an aggregate rollup
// ---------------------------------------------------------------------------
app.get('/manager/piholes', requireRole('reader'), async (_req, res) => {
  const list = instances();
  const results = await Promise.all(list.map(async (inst) => {
    const base = { id: inst.id, label: inst.label, url: inst.url, primary: inst === list[0] };
    try {
      const [summary, ver] = await Promise.all([
        instanceJson(inst, 'stats/summary'),
        instanceJson(inst, 'info/version').catch(() => null),
      ]);
      const q = summary.queries || {};
      let blocking = null;
      try { blocking = (await instanceJson(inst, 'dns/blocking')).blocking; } catch {}
      return {
        ...base, ok: true, blocking,
        total: q.total || 0, blocked: q.blocked || 0,
        percentBlocked: q.percent_blocked || 0,
        activeClients: summary.clients?.active ?? null,
        gravity: summary.gravity?.domains_being_blocked ?? null,
        core: ver?.version?.core?.local?.version || null,
      };
    } catch (e) {
      return { ...base, ok: false, message: e.message };
    }
  }));
  const up = results.filter((r) => r.ok);
  res.json({
    ok: true,
    instances: results,
    aggregate: {
      instances: results.length,
      online: up.length,
      total: up.reduce((a, r) => a + r.total, 0),
      blocked: up.reduce((a, r) => a + r.blocked, 0),
      activeClients: up.reduce((a, r) => a + (r.activeClients || 0), 0),
      gravity: Math.max(0, ...up.map((r) => r.gravity || 0)),
      percentBlocked: (() => {
        const t = up.reduce((a, r) => a + r.total, 0);
        const b = up.reduce((a, r) => a + r.blocked, 0);
        return t ? (b / t) * 100 : 0;
      })(),
    },
  });
});

// ---------------------------------------------------------------------------
// Admin panel API — users and device configuration (admin only)
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(requireRole('admin'));

admin.get('/users', (_req, res) => res.json({ ok: true, users: listUsers(), roles: ROLE_NAMES }));

admin.post('/users', (req, res) => {
  try { res.json({ ok: true, user: createUser(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

admin.put('/users/:username', (req, res) => {
  try { res.json({ ok: true, user: updateUser(req.params.username, req.body || {}, req.user.username, req.sid) }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

admin.delete('/users/:username', (req, res) => {
  try { deleteUser(req.params.username, req.user.username); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

admin.get('/config', (_req, res) => res.json({ ok: true, config: redactConfig(CFG) }));

admin.put('/config', async (req, res) => {
  try {
    const incoming = req.body || {};
    // A blank password field means "leave it as it is", never "clear it".
    const merged = {
      // blank password means "keep the stored one", matched per instance by URL
      piholes: (incoming.piholes || []).map((ph) => {
        const prev = (CFG.piholes || []).find((x) => x.id === ph.id || x.url === ph.url);
        return { ...ph, password: ph.password ? ph.password : (prev?.password || '') };
      }),
      pihole: {
        ...incoming.pihole,
        password: incoming.pihole?.password ? incoming.pihole.password : CFG.pihole.password,
      },
      gateway: {
        ...incoming.gateway,
        password: incoming.gateway?.password ? incoming.gateway.password : CFG.gateway.password,
      },
      aps: (incoming.aps || []).map((a) => {
        const prev = CFG.aps.find((p) => p.host === a.host || p.id === a.id);
        return { ...a, password: a.password ? a.password : (prev?.password || '') };
      }),
    };
    const urls = (merged.piholes.length ? merged.piholes : [merged.pihole]).map((p) => String(p.url || ''));
    const bad = urls.find((u) => !/^https?:\/\/[^/\s]+$/.test(u));
    if (bad !== undefined) {
      return res.status(400).json({ ok: false,
        message: `Each Pi-hole address must be a URL such as http://192.168.1.10 (received "${bad}")` });
    }
    const saved = saveConfig(merged);
    applyConfig(saved);
    pushRouterConfig(saved);   // re-target the sidecar live
    res.json({ ok: true, config: redactConfig(saved) });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// Verify credentials against a device before saving them.
admin.post('/test', async (req, res) => {
  const { target, url, host, username, driver, vendor } = req.body || {};
  let { password } = req.body || {};
  try {
    if (target === 'pihole') {
      const known = (CFG.piholes || []).find((x) => x.url === String(url || '').replace(/\/+$/, ''));
      if (!password && known) password = known.password;
      const base = String(url || '').replace(/\/+$/, '');
      const r = await fetch(`${base}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password || CFG.pihole.password || '' }),
        signal: AbortSignal.timeout(10000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.session?.valid) return res.json({ ok: true, message: 'Pi-hole accepted the password' });
      return res.json({ ok: false, message: r.status === 401 ? 'Password rejected' : `Pi-hole returned HTTP ${r.status}` });
    }
    if (!ROUTER_SERVICE_URL) return res.json({ ok: false, message: 'Router sidecar not configured' });
    // A blank password field means "use the one already stored" — same rule as save.
    const stored = target === 'gateway'
      ? CFG.gateway
      : CFG.aps.find((a) => a.host === host) || {};
    const r = await fetch(`${ROUTER_SERVICE_URL}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: host || stored.host,
        username: username || stored.username,
        password: password || stored.password || '',
        kind: target,          // gateways don't resolve via auto-detection
        driver: driver !== undefined ? driver : (stored.driver || ''),
        vendor: vendor || stored.vendor || 'tplink',
      }),
      signal: AbortSignal.timeout(40000),
    });
    return res.json(await r.json().catch(() => ({ ok: false, message: 'Bad response from sidecar' })));
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

app.use('/manager/admin', admin);

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/manager/health', async (_req, res) => {
  try {
    // Same 401 re-auth retry as the proxy, so an FTL restart doesn't leave the
    // UI showing "offline" until the cached session would have expired.
    const data = await piholeJson('info/version');
    res.json({ connected: true, pihole: PIHOLE_URL, version: data.version || null });
  } catch (err) {
    res.status(502).json({ connected: false, pihole: PIHOLE_URL, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Automation engine
//
// Primitives are INJECTED rather than imported: the engine then shares this
// module's cached Pi-hole session, its deduped auth, its 401-retry and its
// per-endpoint timeout policy, and applyConfig() clearing phSessions
// invalidates the engine's view for free. initAutomation throws at boot if any
// of them is missing, so a future rename fails loudly at startup instead of
// silently at 03:15.
const autoDeps = {
  instances, primaryInstance, instanceById, callInstance, instanceJson,
  piholeJson, routerJson, probeSamples, teleporterBuffer, cfg: () => CFG,
};
app.use('/manager/automation', automationRouter(autoDeps));

const server = app.listen(PORT, () => {
  console.log(`\n  Blackhole.Net running`);
  console.log(`  UI:      http://localhost:${PORT}`);
  console.log(`  Pi-hole: ${PIHOLE_URL}`);
  if (boot) {
    console.log('\n  ┌──────────────────────────────────────────────────────┐');
    console.log('  │  FIRST RUN — an admin account has been created       │');
    console.log(`  │  username: ${boot.username.padEnd(41)}│`);
    console.log(`  │  password: ${boot.password.padEnd(41)}│`);
    console.log('  │  Sign in, then change it from the Admin panel.       │');
    console.log('  └──────────────────────────────────────────────────────┘');
  }
  if (!PIHOLE_PASSWORD) {
    console.log('\n  Note: no Pi-hole password set — add it in the Admin panel.');
  }
  console.log('');
  // Credentials live in SQLite, so the sidecar is configured over its HTTP API
  // instead of reading any of them from its own environment. pushRouterConfig
  // already retries with a delay, which covers the interpreter's start-up.
  startSidecar(__dirname);
  pushRouterConfig();

  // Started after pushRouterConfig so the sidecar is reachable on the first tick.
  try { initAutomation(autoDeps); }
  catch (e) { console.error(`  automation: NOT started - ${e.message}`); }
});

// One container means one process tree: stop the child before exiting, or a
// `docker stop` leaves the Python process to be SIGKILLed by the runtime.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${sig} received - stopping vendor sidecar and exiting`);
    server.close();
    await stopSidecar();
    process.exit(0);
  });
}
