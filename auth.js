// Blackhole.Net — authentication, roles and the runtime config store.
//
// Roles (ascending): reader < contributor < admin
//   reader      — read-only: view every section, change nothing
//   contributor — day-to-day ops: blocking, domains, lists, groups, clients,
//                 local DNS, DHCP entries, gravity/flush
//   admin       — everything: DNS/upstream config, router reboot & Wi-Fi radios,
//                 backup restore, device settings and user management
//
// Passwords are scrypt-hashed with a per-user salt. Sessions are opaque random
// tokens held server-side and delivered in an HttpOnly, SameSite=Strict cookie,
// so a stolen JS context can't read them and cross-site posts can't ride them.

import crypto from 'node:crypto';
import {
  initDb, dbUsers, dbUser, dbInsertUser, dbUpdateUser, dbDeleteUser,
  dbConfig, dbSaveConfig, seedFromEnvIfEmpty,
} from './db.js';

// Null-prototype so a role string like "constructor" or "toString" can't
// resolve through Object.prototype and produce a truthy rank.
export const ROLES = Object.assign(Object.create(null), { reader: 1, contributor: 2, admin: 3 });
export const ROLE_NAMES = ['reader', 'contributor', 'admin'];
const isRole = (r) => ROLE_NAMES.includes(r);
// Exported so automation.js re-checks a rule author's live role through this
// one fail-closed implementation instead of a second copy that could drift.
export const rankOf = (r) => (isRole(r) ? ROLES[r] : 0);   // unknown role ⇒ no rights

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 3600 * 1000;
const COOKIE = 'bh_session';

initDb();   // opens data/blackhole.db and migrates any legacy JSON on first run

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const calc = crypto.scryptSync(password, salt, 64, { N: +N, r: +r, p: +p });
    const known = Buffer.from(hash, 'hex');
    return calc.length === known.length && crypto.timingSafeEqual(calc, known);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export function loadUsers() { return dbUsers(); }

export const publicUser = (u) => ({
  username: u.username, role: u.role, createdAt: u.createdAt,
  lastLogin: u.lastLogin || null, mustChangePassword: !!u.mustChangePassword,
});

export function listUsers() { return loadUsers().map(publicUser); }

export function createUser({ username, password, role }) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 chars: a–z, 0–9, . _ -');
  if (!isRole(role)) throw new Error('Invalid role');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
  if (dbUser(username)) throw new Error('That username already exists');
  dbInsertUser({ username, role, password: hashPassword(password),
    createdAt: new Date().toISOString() });
  return publicUser(dbUser(username));
}

export function updateUser(username, { role, password }, actingUser, keepSid = null) {
  const users = dbUsers();
  const u = users.find((x) => x.username === username);
  if (!u) throw new Error('No such user');
  const fields = {};
  if (role) {
    if (!isRole(role)) throw new Error('Invalid role');
    // Never allow the last admin to be demoted — that would lock everyone out.
    if (u.role === 'admin' && role !== 'admin' && users.filter((x) => x.role === 'admin').length <= 1) {
      throw new Error('Cannot demote the only remaining admin');
    }
    fields.role = role;
    // per-request resolution already handles this, but drop the sessions too so
    // a demoted user is forced through a fresh login
    for (const [sid, s] of sessions) if (s.username === username) sessions.delete(sid);
  }
  if (password !== undefined) {
    if (String(password).length < 8) throw new Error('Password must be at least 8 characters');
    fields.password = hashPassword(password);
    // Revoke every session for this user except the caller's own — a rotated
    // password must invalidate anything already stolen.
    for (const [sid, s] of sessions) if (s.username === username && sid !== keepSid) sessions.delete(sid);
  }
  dbUpdateUser(username, fields);
  return publicUser(dbUser(username));
}

export function deleteUser(username, actingUser) {
  if (username === actingUser) throw new Error('You cannot delete your own account');
  const users = dbUsers();
  const u = users.find((x) => x.username === username);
  if (!u) throw new Error('No such user');
  if (u.role === 'admin' && users.filter((x) => x.role === 'admin').length <= 1) {
    throw new Error('Cannot delete the only remaining admin');
  }
  dbDeleteUser(username);
  for (const [sid, s] of sessions) if (s.username === username) sessions.delete(sid);
  return true;
}

// Create a first admin on a fresh install and print the generated password.
export function bootstrapAdmin() {
  seedFromEnvIfEmpty();                 // fresh install: import .env once
  if (dbUsers().length) return null;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  dbInsertUser({
    username: 'admin', role: 'admin', password: hashPassword(password),
    createdAt: new Date().toISOString(), mustChangePassword: !process.env.ADMIN_PASSWORD,
  });
  return { username: 'admin', password, generated: !process.env.ADMIN_PASSWORD };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
// Precomputed once at startup so the unknown-user branch does one scrypt, not two.
const DECOY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

const sessions = new Map();   // sid -> { username, role, expires, absoluteExpiry }

const ABSOLUTE_TTL_MS = SESSION_TTL_MS * 4;   // hard cap; sliding expiry can't extend past this

function newSession(user) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, {
    username: user.username, role: user.role,
    expires: Date.now() + SESSION_TTL_MS,
    absoluteExpiry: Date.now() + ABSOLUTE_TTL_MS,
  });
  return sid;
}
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expires < now) sessions.delete(sid);
}, 60_000).unref?.();

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// ---------------------------------------------------------------------------
// Login throttling — slows credential stuffing without locking a user out
// permanently. Keyed by IP + username.
// ---------------------------------------------------------------------------
const attempts = new Map();
const MAX_ATTEMPTS = 8, LOCK_MS = 5 * 60 * 1000;
function throttleKey(ip, username) { return `${ip}|${username}`; }
function isLocked(key) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (a.count < MAX_ATTEMPTS) return 0;
  const left = a.until - Date.now();
  if (left <= 0) { attempts.delete(key); return 0; }
  return Math.ceil(left / 1000);
}
function noteFailure(key) {
  const a = attempts.get(key) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) a.until = Date.now() + LOCK_MS;
  attempts.set(key, a);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export function attachUser(req, _res, next) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  const s = sid && sessions.get(sid);
  if (s && s.expires > Date.now()) {
    // The role is resolved from storage on every request rather than trusted
    // from the session snapshot, so a demotion or deletion takes effect at once
    // instead of lingering until the old session happens to expire.
    const live = loadUsers().find((u) => u.username === s.username);
    if (!live) { sessions.delete(sid); return next(); }
    if (s.absoluteExpiry && Date.now() > s.absoluteExpiry) { sessions.delete(sid); return next(); }
    s.expires = Date.now() + SESSION_TTL_MS;   // sliding idle timeout
    s.role = live.role;
    req.user = { username: live.username, role: live.role };
    req.sid = sid;
  }
  next();
}

export function requireRole(min) {
  const need = ROLES[min];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated', message: 'Sign in to continue' });
    // Fail closed: an unrecognised role ranks 0 and is refused everything.
    if (!(rankOf(req.user.role) >= need)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `This action requires the "${min}" role — you are signed in as "${req.user.role}".`,
      });
    }
    next();
  };
}

export function login(req, res) {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  // socket address only: X-Forwarded-For is attacker-controlled here
  const ip = req.socket?.remoteAddress || '?';
  const key = throttleKey(ip, uname);

  const lockedFor = Math.max(isLocked(key), isLocked(`user|${uname}`));
  if (lockedFor) {
    return res.status(429).json({ error: 'locked', message: `Too many attempts. Try again in ${lockedFor}s.` });
  }
  const user = loadUsers().find((u) => u.username === uname);
  // Exactly ONE scrypt on both branches: a missing user costs the same as a
  // wrong password (no enumeration oracle) without hashing twice (which would
  // make the unknown-user path a cheap CPU amplification).
  const ok = user
    ? verifyPassword(String(password || ''), user.password)
    : (verifyPassword(String(password || ''), DECOY_HASH), false);
  if (!ok) {
    noteFailure(key);
    noteFailure(`user|${uname}`);   // so a distributed guess still locks the account
    return res.status(401).json({ error: 'bad_credentials', message: 'Incorrect username or password' });
  }
  attempts.delete(key);
  attempts.delete(`user|${uname}`);

  dbUpdateUser(uname, { lastLogin: new Date().toISOString() });
  const stored = dbUser(uname);

  const sid = newSession(stored);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true, user: publicUser(stored) });
}

export function logout(req, res) {
  if (req.sid) sessions.delete(req.sid);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

// Let a signed-in user rotate their own password (needs the current one).
export function changeOwnPassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const u = dbUser(req.user.username);
  if (!u || !verifyPassword(String(currentPassword || ''), u.password)) {
    return res.status(403).json({ error: 'bad_credentials', message: 'Current password is incorrect' });
  }
  if (String(newPassword || '').length < 8) {
    return res.status(400).json({ error: 'weak', message: 'New password must be at least 8 characters' });
  }
  dbUpdateUser(u.username, { password: hashPassword(newPassword) });
  // keep the caller signed in, sign out everywhere else
  for (const [sid, s] of sessions) if (s.username === u.username && sid !== req.sid) sessions.delete(sid);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Runtime config store — the admin panel writes here; .env only seeds defaults.
// ---------------------------------------------------------------------------
export function loadConfig() { return dbConfig(); }

export function saveConfig(cfg) {
  const piholes = (Array.isArray(cfg.piholes) && cfg.piholes.length
    ? cfg.piholes
    : [{ label: 'Primary', url: cfg.pihole?.url, password: cfg.pihole?.password }])
    .slice(0, 8)
    .filter((ph) => String(ph.url || '').trim())
    .map((ph, i) => ({
      label: String(ph.label || (i === 0 ? 'Primary' : `Instance ${i + 1}`)).trim(),
      url: String(ph.url || '').trim().replace(/\/+$/, ''),
      password: ph.password ?? '',
    }));
  return dbSaveConfig({
    piholes,
    pihole: {
      url: piholes[0]?.url || '',
      password: piholes[0]?.password ?? '',
      insecureTls: !!cfg.pihole?.insecureTls,
    },
    gateway: {
      host: String(cfg.gateway?.host || '').trim(),
      model: String(cfg.gateway?.model || '').trim(),
      username: String(cfg.gateway?.username || 'user').trim() || 'user',
      password: cfg.gateway?.password ?? '',
      driver: String(cfg.gateway?.driver || '').trim(),
      vendor: String(cfg.gateway?.vendor || 'tplink').trim() || 'tplink',
    },
    aps: (Array.isArray(cfg.aps) ? cfg.aps : []).slice(0, 8)
      .filter((a) => String(a.host || '').trim())
      .map((a, i) => ({
        host: String(a.host).trim(),
        label: String(a.label || ('AP ' + (i + 1))).trim(),
        username: String(a.username || 'admin').trim() || 'admin',
        password: a.password ?? '',
        driver: String(a.driver || '').trim(),
        vendor: String(a.vendor || 'tplink').trim() || 'tplink',
      })),
  });
}

// Never send secrets to the browser — report only whether one is set.
export function redactConfig(cfg) {
  return {
    pihole: { url: cfg.pihole.url, hasPassword: !!cfg.pihole.password, insecureTls: cfg.pihole.insecureTls },
    piholes: (cfg.piholes || []).map((ph) => ({
      id: ph.id, label: ph.label, url: ph.url, hasPassword: !!ph.password,
    })),
    gateway: {
      host: cfg.gateway.host, model: cfg.gateway.model, username: cfg.gateway.username,
      driver: cfg.gateway.driver || '', vendor: cfg.gateway.vendor || 'tplink',
      hasPassword: !!cfg.gateway.password,
    },
    aps: cfg.aps.map((a) => ({
      id: a.id, host: a.host, label: a.label, username: a.username,
      driver: a.driver || '', vendor: a.vendor || 'tplink', hasPassword: !!a.password,
    })),
  };
}
