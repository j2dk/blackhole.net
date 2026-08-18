// Blackhole.Net — SQLite storage.
//
// Everything persistent lives in data/blackhole.db:
//   users     — accounts + scrypt password hashes
//   devices   — Pi-hole / gateway / access points, with secrets ENCRYPTED
//   settings  — scalar preferences
//
// Device passwords (Pi-hole, routers, APs) have to be recoverable — we need the
// cleartext to log in to those devices — so they are encrypted at rest with
// AES-256-GCM rather than hashed. The key lives in data/secret.key, separate
// from the database, so a stray copy of the .db alone does not reveal them.
// User passwords are never decryptable: those stay one-way scrypt hashes.
//
// Nothing here is read from the environment: .env no longer holds secrets.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = path.join(DATA_DIR, 'blackhole.db');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
const LEGACY_USERS = path.join(DATA_DIR, 'users.json');
const LEGACY_CONFIG = path.join(DATA_DIR, 'config.json');

let db = null;
let KEY = null;

// ---------------------------------------------------------------------------
// Encryption key — generated once, never in the environment or the database
// ---------------------------------------------------------------------------
function loadKey() {
  if (KEY) return KEY;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) { KEY = buf; return KEY; }
    throw new Error('bad key length');
  } catch {
    KEY = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, KEY.toString('base64'), { mode: 0o600 });
    return KEY;
  }
}

export function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return '';
  const parts = String(blob).split('.');
  // Anything not in our format is treated as legacy cleartext so a hand-edited
  // value still works; it gets re-encrypted on the next save.
  if (parts.length !== 4 || parts[0] !== 'v1') return String(blob);
  try {
    const [, iv, tag, ct] = parts;
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';   // wrong/rotated key — treat as unset rather than crashing
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export function initDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      username      TEXT PRIMARY KEY,
      role          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT,
      last_login    TEXT,
      must_change   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS devices (
      id       TEXT PRIMARY KEY,
      kind     TEXT NOT NULL,
      host     TEXT,
      label    TEXT,
      username TEXT,
      secret   TEXT,
      vendor   TEXT,
      driver   TEXT,
      sort     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- ---------------------------------------------------------------------
    -- Automation. Deliberately NO foreign keys to automations(id): the
    -- PRAGMA above is ON, so an FK would cascade-delete the audit trail the
    -- moment a rule is removed. auto_name/kind are denormalised into the run
    -- and event rows so history outlives the rule it describes.
    -- ---------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS automations (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      name           TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 0,
      config         TEXT NOT NULL DEFAULT '{}',
      last_fired_key TEXT,      -- local-minute string 'YYYY-MM-DDTHH:MM'
      last_run_at    INTEGER,
      last_result    TEXT,
      last_message   TEXT,
      first_bad_at   INTEGER,   -- dwell clock for watchdog/monitor kinds
      snooze_until   INTEGER,
      created_by     TEXT,
      created_at     TEXT,
      updated_at     TEXT,
      sort           INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      auto_id    TEXT,
      auto_name  TEXT,
      kind       TEXT,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,
      source     TEXT,                        -- schedule|reconcile|manual|simulate|boot|panic
      actor      TEXT NOT NULL DEFAULT '',
      outcome    TEXT NOT NULL,               -- running|ok|failed|skipped|simulated
      detail     TEXT,
      error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ar_auto ON automation_runs(auto_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_ar_started ON automation_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS automation_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      auto_id TEXT,
      kind    TEXT,
      level   TEXT NOT NULL,                  -- info|warn|err
      dedupe  TEXT,
      title   TEXT NOT NULL,
      detail  TEXT,
      acked   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ae_ts ON automation_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_ae_dedupe ON automation_events(dedupe, ts DESC);
    CREATE TABLE IF NOT EXISTS seen_devices (
      mac        TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      name       TEXT,
      vendor     TEXT,
      ip         TEXT,
      acked      INTEGER NOT NULL DEFAULT 0
    );
  `);
  try { fs.chmodSync(DB_FILE, 0o600); } catch {}
  addProfileColumns();
  migrateLegacyJson();
  return db;
}

// Additive, idempotent migration. `ALTER TABLE ... ADD COLUMN` THROWS if the
// column already exists, so each add is gated on PRAGMA table_info rather than
// wrapped in a try/catch that would also swallow a real error.
function addProfileColumns() {
  const have = new Set(db.prepare('PRAGMA table_info(users)').all().map((r) => r.name));
  const cols = {
    display_name: 'TEXT',
    nickname:     'TEXT',
    dob:          'TEXT',          // 'YYYY-MM-DD'
    title:        'TEXT',          // job title / description
    location:     'TEXT',
    timezone:     'TEXT',
    avatar:       'BLOB',
    avatar_type:  'TEXT',          // the validated image/* type, never client-supplied
    updated_at:   'TEXT',
  };
  for (const [name, type] of Object.entries(cols)) {
    if (!have.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
}

const q = (sql) => initDb().prepare(sql);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const rowToUser = (r) => ({
  username: r.username, role: r.role, password: r.password_hash,
  createdAt: r.created_at, lastLogin: r.last_login,
  mustChangePassword: !!r.must_change,
});

export function dbUsers() {
  return q('SELECT * FROM users ORDER BY created_at').all().map(rowToUser);
}

export function dbUser(username) {
  const r = q('SELECT * FROM users WHERE username = ?').get(username);
  return r ? rowToUser(r) : null;
}

export function dbInsertUser(u) {
  q(`INSERT INTO users (username, role, password_hash, created_at, must_change)
     VALUES (?, ?, ?, ?, ?)`)
    .run(u.username, u.role, u.password, u.createdAt || new Date().toISOString(),
      u.mustChangePassword ? 1 : 0);
}

export function dbUpdateUser(username, fields) {
  const sets = [], vals = [];
  if (fields.role !== undefined) { sets.push('role = ?'); vals.push(fields.role); }
  if (fields.password !== undefined) {
    sets.push('password_hash = ?', 'must_change = 0'); vals.push(fields.password);
  }
  if (fields.lastLogin !== undefined) { sets.push('last_login = ?'); vals.push(fields.lastLogin); }
  if (!sets.length) return;
  vals.push(username);
  q(`UPDATE users SET ${sets.join(', ')} WHERE username = ?`).run(...vals);
}

export function dbDeleteUser(username) {
  q('DELETE FROM users WHERE username = ?').run(username);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function setSetting(key, value) {
  q(`INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}
function getSetting(key, fallback = null) {
  const r = q('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
// The automation engine stores its own scalars here (engine on/off, time zone,
// webhook URL, gravity high-water mark). Exported as thin wrappers so there is
// still exactly one copy of the SQL.
export const dbSetSetting = (key, value) => setSetting(key, value);
export const dbGetSetting = (key, fallback = null) => getSetting(key, fallback);

// ---------------------------------------------------------------------------
// Devices  ->  the { pihole, gateway, aps[] } shape the app already uses
// ---------------------------------------------------------------------------
export function dbConfig() {
  const rows = q('SELECT * FROM devices ORDER BY sort, id').all();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const g = byId.gateway || {};
  const insecureTls = getSetting('pihole.insecureTls') === 'true';
  // 'pihole' is the legacy single-instance row id; pihole1..N are the rest.
  const phRows = rows.filter((r) => r.kind === 'pihole');
  const piholes = phRows.map((r, i) => ({
    id: r.id, label: r.label || (i === 0 ? 'Primary' : `Instance ${i + 1}`),
    url: r.host || '', password: decrypt(r.secret), insecureTls,
  }));
  const primary = piholes[0] || { url: '', password: '', label: 'Primary' };
  return {
    piholes,
    // Kept so single-instance callers keep working unchanged.
    pihole: { url: primary.url, password: primary.password, insecureTls },
    gateway: {
      host: g.host || '', model: g.label || '',
      username: g.username || 'user', password: decrypt(g.secret),
      driver: g.driver || '', vendor: g.vendor || 'tplink',
    },
    aps: rows.filter((r) => r.kind === 'ap').map((r, i) => ({
      id: `ap${i + 1}`, host: r.host || '', label: r.label || `AP ${i + 1}`,
      username: r.username || 'admin', password: decrypt(r.secret),
      driver: r.driver || '', vendor: r.vendor || 'tplink',
    })),
  };
}

export function dbSaveConfig(cfg) {
  const d = initDb();
  const upsert = d.prepare(`
    INSERT INTO devices (id, kind, host, label, username, secret, vendor, driver, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind, host=excluded.host, label=excluded.label,
      username=excluded.username, secret=excluded.secret,
      vendor=excluded.vendor, driver=excluded.driver, sort=excluded.sort`);

  d.exec('BEGIN');
  try {
    // Rewrite the whole Pi-hole set so removals actually disappear.
    d.prepare("DELETE FROM devices WHERE kind = 'pihole'").run();
    const list = (cfg.piholes && cfg.piholes.length)
      ? cfg.piholes
      : [{ label: 'Primary', url: cfg.pihole?.url || '', password: cfg.pihole?.password || '' }];
    list.slice(0, 8).forEach((ph, i) => {
      upsert.run(`pihole${i + 1}`, 'pihole', ph.url || '',
        ph.label || (i === 0 ? 'Primary' : `Instance ${i + 1}`), '',
        encrypt(ph.password || ''), '', '', i);
    });
    setSetting('pihole.insecureTls', !!(cfg.pihole?.insecureTls ?? cfg.piholes?.[0]?.insecureTls));
    upsert.run('gateway', 'gateway', cfg.gateway.host || '', cfg.gateway.model || '',
      cfg.gateway.username || 'user', encrypt(cfg.gateway.password || ''),
      cfg.gateway.vendor || 'tplink', cfg.gateway.driver || '', 1);
    // rewrite the AP set so removals actually disappear
    d.prepare("DELETE FROM devices WHERE kind = 'ap'").run();
    (cfg.aps || []).slice(0, 8).forEach((a, i) => {
      upsert.run(`ap${i + 1}`, 'ap', a.host || '', a.label || `AP ${i + 1}`,
        a.username || 'admin', encrypt(a.password || ''),
        a.vendor || 'tplink', a.driver || '', 10 + i);
    });
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return dbConfig();
}

// ---------------------------------------------------------------------------
// One-time import of the old JSON files, then get them out of the way.
// ---------------------------------------------------------------------------
function migrateLegacyJson() {
  const readJson = (f) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  };
  const park = (f) => {
    try { fs.renameSync(f, `${f}.migrated`); } catch {}
  };

  const usersEmpty = q('SELECT COUNT(*) AS n FROM users').get().n === 0;
  if (usersEmpty) {
    const legacy = readJson(LEGACY_USERS);
    for (const u of (legacy?.users || [])) {
      if (!u?.username || !u?.password) continue;
      try {
        dbInsertUser({
          username: u.username, role: u.role || 'reader', password: u.password,
          createdAt: u.createdAt, mustChangePassword: u.mustChangePassword,
        });
        if (u.lastLogin) dbUpdateUser(u.username, { lastLogin: u.lastLogin });
      } catch {}
    }
    if (legacy) {
      console.log(`  migrated ${legacy.users?.length || 0} user(s) from users.json into SQLite`);
      park(LEGACY_USERS);
    }
  }

  const devicesEmpty = q('SELECT COUNT(*) AS n FROM devices').get().n === 0;
  if (devicesEmpty) {
    const legacy = readJson(LEGACY_CONFIG);
    if (legacy?.pihole) {
      dbSaveConfig({
        pihole: legacy.pihole || {},
        gateway: legacy.gateway || {},
        aps: legacy.aps || [],
      });
      console.log(`  migrated device config (+${(legacy.aps || []).length} AP(s)) into SQLite; secrets now encrypted`);
      park(LEGACY_CONFIG);
    }
  }
}

// Seed from the environment ONLY on a completely fresh install, so a first boot
// can be unattended. After that the database is authoritative and these are
// ignored entirely.
export function seedFromEnvIfEmpty() {
  if (q('SELECT COUNT(*) AS n FROM devices').get().n > 0) return false;
  const aps = [];
  for (let i = 1; i <= 8; i++) {
    const host = process.env[`AP${i}_HOST`];
    if (!host) continue;
    aps.push({
      host, label: process.env[`AP${i}_LABEL`] || `AP ${i}`,
      username: process.env[`AP${i}_USERNAME`] || 'admin',
      password: process.env[`AP${i}_PASSWORD`] || '',
      driver: process.env[`AP${i}_DRIVER`] || '',
      vendor: process.env[`AP${i}_VENDOR`] || 'tplink',
    });
  }
  const piholes = [{
    label: process.env.PIHOLE_LABEL || 'Primary',
    url: process.env.PIHOLE_URL || 'http://192.168.1.10',
    password: process.env.PIHOLE_PASSWORD || '',
  }];
  for (let i = 2; i <= 8; i++) {
    const url = process.env[`PIHOLE${i}_URL`];
    if (!url) continue;
    piholes.push({
      label: process.env[`PIHOLE${i}_LABEL`] || `Instance ${i}`,
      url, password: process.env[`PIHOLE${i}_PASSWORD`] || '',
    });
  }
  dbSaveConfig({
    piholes,
    pihole: {
      url: piholes[0].url, password: piholes[0].password,
      insecureTls: String(process.env.PIHOLE_INSECURE_TLS).toLowerCase() === 'true',
    },
    gateway: {
      host: process.env.GATEWAY_HOST || '192.168.1.1',
      model: process.env.ROUTER_MODEL || '',
      username: process.env.ROUTER_USERNAME || 'user',
      password: process.env.ROUTER_PASSWORD || '',
      driver: process.env.ROUTER_DRIVER || '',
      vendor: process.env.ROUTER_VENDOR || 'tplink',
    },
    aps,
  });
  return true;
}


// ---------------------------------------------------------------------------
// Automation storage
// ---------------------------------------------------------------------------
function rowToAutomation(r) {
  const a = {
    id: r.id, kind: r.kind, name: r.name, enabled: !!r.enabled,
    lastFiredKey: r.last_fired_key, lastRunAt: r.last_run_at,
    lastResult: r.last_result, lastMessage: r.last_message,
    firstBadAt: r.first_bad_at, snoozeUntil: r.snooze_until,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    sort: r.sort, config: {},
  };
  // A hand-edited or truncated config must make the rule REFUSE to run rather
  // than run against an empty object with default behaviour.
  try { a.config = JSON.parse(r.config || '{}'); }
  catch { a.invalid = 'Stored configuration is not valid JSON'; }
  if (a.config === null || typeof a.config !== 'object' || Array.isArray(a.config)) {
    a.config = {};
    a.invalid = 'Stored configuration is not an object';
  }
  return a;
}

export function dbAutomations() {
  return q('SELECT * FROM automations ORDER BY sort, created_at, id').all().map(rowToAutomation);
}
export function dbAutomation(id) {
  const r = q('SELECT * FROM automations WHERE id = ?').get(id);
  return r ? rowToAutomation(r) : null;
}
export function dbInsertAutomation(a) {
  q(`INSERT INTO automations (id, kind, name, enabled, config, created_by, created_at, updated_at, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.id, a.kind, a.name, a.enabled ? 1 : 0, JSON.stringify(a.config ?? {}),
    a.createdBy || '', a.createdAt || new Date().toISOString(),
    a.updatedAt || new Date().toISOString(), a.sort ?? 0);
  return dbAutomation(a.id);
}
// Sparse SET builder — same shape as dbUpdateUser, so an absent field is left
// untouched instead of being written as NULL.
export function dbUpdateAutomation(id, fields) {
  const map = {
    kind: 'kind', name: 'name', enabled: 'enabled', config: 'config',
    lastFiredKey: 'last_fired_key', lastRunAt: 'last_run_at',
    lastResult: 'last_result', lastMessage: 'last_message',
    firstBadAt: 'first_bad_at', snoozeUntil: 'snooze_until', sort: 'sort',
  };
  const set = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in fields)) continue;
    set.push(`${col} = ?`);
    let v = fields[k];
    if (k === 'enabled') v = v ? 1 : 0;
    else if (k === 'config') v = JSON.stringify(v ?? {});
    vals.push(v === undefined ? null : v);
  }
  set.push('updated_at = ?'); vals.push(new Date().toISOString());
  if (!set.length) return dbAutomation(id);
  vals.push(id);
  q(`UPDATE automations SET ${set.join(', ')} WHERE id = ?`).run(...vals);
  return dbAutomation(id);
}
export function dbDeleteAutomation(id) {
  q('DELETE FROM automations WHERE id = ?').run(id);
}
// Narrow UPDATE for the tick's hot path: one statement, no JSON work.
export function dbSetAutoState(id, s) {
  q(`UPDATE automations SET last_fired_key = COALESCE(?, last_fired_key),
       last_run_at = COALESCE(?, last_run_at), last_result = COALESCE(?, last_result),
       last_message = COALESCE(?, last_message), first_bad_at = ?, snooze_until = ?
     WHERE id = ?`).run(
    s.lastFiredKey ?? null, s.lastRunAt ?? null, s.lastResult ?? null,
    s.lastMessage ?? null,
    s.firstBadAt === undefined ? null : s.firstBadAt,
    s.snoozeUntil === undefined ? null : s.snoozeUntil, id);
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export function dbInsertRun(r) {
  const res = q(`INSERT INTO automation_runs
      (auto_id, auto_name, kind, started_at, ended_at, source, actor, outcome, detail, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    r.autoId ?? null, clip(r.autoName, 200), r.kind ?? null,
    r.startedAt ?? Date.now(), r.endedAt ?? null, r.source ?? 'schedule',
    r.actor || '', r.outcome || 'running', clip(r.detail, 4096), clip(r.error, 500));
  return Number(res.lastInsertRowid);
}
export function dbFinishRun(id, r) {
  q(`UPDATE automation_runs SET outcome = ?, ended_at = ?, detail = ?, error = ? WHERE id = ?`)
    .run(r.outcome, r.endedAt ?? Date.now(), clip(r.detail, 4096), clip(r.error, 500), id);
}
// Rewrites rows left mid-flight by a crash or restart; without this the UI shows
// phantom in-flight runs forever.
export function dbReconcileRuns() {
  const res = q(`UPDATE automation_runs SET outcome = 'failed', ended_at = ?, error = ?
                 WHERE outcome = 'running'`).run(Date.now(), 'Interrupted by a restart');
  return Number(res.changes || 0);
}
export function dbRuns({ autoId = null, limit = 100, before = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (autoId && before) return q('SELECT * FROM automation_runs WHERE auto_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(autoId, before, lim);
  if (autoId) return q('SELECT * FROM automation_runs WHERE auto_id = ? ORDER BY id DESC LIMIT ?').all(autoId, lim);
  if (before) return q('SELECT * FROM automation_runs WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, lim);
  return q('SELECT * FROM automation_runs ORDER BY id DESC LIMIT ?').all(lim);
}

export function dbInsertEvent(e) {
  q(`INSERT INTO automation_events (ts, auto_id, kind, level, dedupe, title, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    e.ts ?? Date.now(), e.autoId ?? null, e.kind ?? null, e.level || 'info',
    clip(e.dedupe, 200), clip(e.title, 300), clip(e.detail, 4096));
}
export function dbEvents({ limit = 100, before = null, level = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (level && before) return q('SELECT * FROM automation_events WHERE level = ? AND id < ? ORDER BY id DESC LIMIT ?').all(level, before, lim);
  if (level) return q('SELECT * FROM automation_events WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, lim);
  if (before) return q('SELECT * FROM automation_events WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, lim);
  return q('SELECT * FROM automation_events ORDER BY id DESC LIMIT ?').all(lim);
}
export function dbLastEvent(dedupe) {
  return q('SELECT * FROM automation_events WHERE dedupe = ? ORDER BY id DESC LIMIT 1').get(dedupe) || null;
}
export function dbAckEvents(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
  if (!list.length) return 0;
  const st = q('UPDATE automation_events SET acked = 1 WHERE id = ?');
  const d = initDb();
  d.exec('BEGIN');
  try { for (const id of list) st.run(id); d.exec('COMMIT'); }
  catch (e) { d.exec('ROLLBACK'); throw e; }
  return list.length;
}
export const dbUnackedEvents = () =>
  Number(q("SELECT COUNT(*) AS n FROM automation_events WHERE acked = 0 AND level IN ('warn','err')").get().n || 0);

export const dbSeenDevice = (mac) => q('SELECT * FROM seen_devices WHERE mac = ?').get(mac) || null;
export function dbUpsertSeen(d) {
  q(`INSERT INTO seen_devices (mac, first_seen, last_seen, name, vendor, ip)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mac) DO UPDATE SET last_seen = excluded.last_seen,
       name = COALESCE(excluded.name, seen_devices.name),
       ip = COALESCE(excluded.ip, seen_devices.ip)`).run(
    d.mac, d.firstSeen ?? Date.now(), d.lastSeen ?? Date.now(),
    d.name ?? null, d.vendor ?? null, d.ip ?? null);
}
// First arming of the new-device rule adopts the CURRENT inventory as the
// baseline, or every existing device would alert at once.
export function dbSeedSeen(list) {
  const d = initDb();
  const st = q(`INSERT INTO seen_devices (mac, first_seen, last_seen, name, vendor, ip, acked)
                VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(mac) DO NOTHING`);
  const now = Date.now();
  d.exec('BEGIN');
  try {
    for (const x of list) st.run(x.mac, now, now, x.name ?? null, x.vendor ?? null, x.ip ?? null);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return list.length;
}
export const dbSeenCount = () => Number(q('SELECT COUNT(*) AS n FROM seen_devices').get().n || 0);

// Bounded DELETEs on indexed columns only. DatabaseSync is synchronous, so a
// table scan here would stall every HTTP response including the login page.
export function dbPruneAutomation() {
  const now = Date.now();
  q('DELETE FROM automation_runs WHERE started_at < ?').run(now - 30 * 86400000);
  q(`DELETE FROM automation_runs WHERE id NOT IN
       (SELECT id FROM automation_runs ORDER BY id DESC LIMIT 4000)`).run();
  q('DELETE FROM automation_events WHERE ts < ? AND acked = 1').run(now - 90 * 86400000);
  q('DELETE FROM seen_devices WHERE last_seen < ?').run(now - 180 * 86400000);
}

// ---------------------------------------------------------------------------
// Profile
//
// SECURITY: `role` is deliberately absent from dbUpdateProfile's field map. A
// self-service endpoint that accepts a role from its own request body is a
// privilege escalation — a reader could promote themselves to admin. Role stays
// with updateUser(), which is admin-gated. Adding it here would silently
// re-open the hole, so the omission is load-bearing.
// ---------------------------------------------------------------------------
export function dbProfile(username) {
  const r = q(`SELECT username, role, display_name, nickname, dob, title, location,
                      timezone, avatar_type, created_at, last_login, updated_at,
                      LENGTH(avatar) AS avatar_bytes
               FROM users WHERE username = ?`).get(username);
  if (!r) return null;
  return {
    username: r.username, role: r.role,
    displayName: r.display_name || '', nickname: r.nickname || '',
    dob: r.dob || '', title: r.title || '', location: r.location || '',
    timezone: r.timezone || '',
    hasAvatar: !!r.avatar_bytes, avatarBytes: r.avatar_bytes || 0,
    createdAt: r.created_at, lastLogin: r.last_login, updatedAt: r.updated_at,
  };
}

export function dbUpdateProfile(username, fields) {
  const map = {
    displayName: 'display_name', nickname: 'nickname', dob: 'dob',
    title: 'title', location: 'location', timezone: 'timezone',
  };
  const set = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in fields)) continue;
    set.push(`${col} = ?`);
    const v = fields[k];
    vals.push(v === undefined || v === null || v === '' ? null : String(v));
  }
  if (!set.length) return dbProfile(username);
  set.push('updated_at = ?'); vals.push(new Date().toISOString());
  vals.push(username);
  q(`UPDATE users SET ${set.join(', ')} WHERE username = ?`).run(...vals);
  return dbProfile(username);
}

// Read separately and only when actually serving the image.
export function dbAvatar(username) {
  const r = q('SELECT avatar, avatar_type FROM users WHERE username = ?').get(username);
  if (!r || !r.avatar) return null;
  return { bytes: Buffer.from(r.avatar), type: r.avatar_type || 'image/png' };
}
export function dbSetAvatar(username, bytes, type) {
  q('UPDATE users SET avatar = ?, avatar_type = ?, updated_at = ? WHERE username = ?')
    .run(bytes, type, new Date().toISOString(), username);
}
export function dbClearAvatar(username) {
  q('UPDATE users SET avatar = NULL, avatar_type = NULL, updated_at = ? WHERE username = ?')
    .run(new Date().toISOString(), username);
}
