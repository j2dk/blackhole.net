// ===========================================================================
//  Blackhole.Net — automation engine
//
//  DESIGN, in one paragraph. Automations are TYPED, not generic: every kind is
//  a code-defined entry in the frozen KINDS registry with one fixed effect, one
//  config schema, one required role and its own linter. There is deliberately
//  no "action + params" primitive, because "call path X with body Y" is an
//  arbitrary-request capability, and this codebase has already been burned once
//  by authorizing on a path string (see resolvePhPath in server.js). A rule
//  therefore cannot express anything the code here did not anticipate.
//
//  TIMING. Nothing stores an absolute due time. State-holding kinds RECONCILE
//  (compute the desired state from the wall clock every tick and assert it),
//  and one-shot kinds fire on a local-minute KEY that is re-derived each tick.
//  A backwards clock jump re-derives an already-fired key and no-ops; a forward
//  jump or a container pause yields exactly one catch-up inside the grace
//  window and a recorded `skipped` row outside it; a DST spring-forward gap
//  leaves a journal row rather than silence. There is no recomputation branch
//  to fail at 03:15.
//
//  All wall-clock arithmetic goes through Intl with an explicit timeZone.
//  Date#getHours() reads /usr/share/zoneinfo, which a slim base image may not
//  carry; Intl uses ICU's own bundled database, which the official Node image
//  always ships.
// ===========================================================================
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  dbAutomations, dbAutomation, dbInsertAutomation, dbUpdateAutomation,
  dbDeleteAutomation, dbSetAutoState,
  dbInsertRun, dbFinishRun, dbReconcileRuns, dbRuns,
  dbInsertEvent, dbEvents, dbLastEvent, dbAckEvents, dbUnackedEvents,
  dbSeenDevice, dbUpsertSeen, dbSeedSeen, dbSeenCount,
  dbPruneAutomation, dbGetSetting, dbSetSetting, dbUser,
} from './db.js';
import { requireRole, rankOf } from './auth.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DISABLE_FILE = path.join(DATA_DIR, 'automation.disable');
const TICK_MS = 30_000;

let D = null;           // injected server primitives
const engine = {
  startedAt: null, lastTickAt: null, lastError: null,
  ticks: 0, lag: 0, tzUnsupported: false,
};

// ---------------------------------------------------------------------------
//  Wall clock — Intl only
// ---------------------------------------------------------------------------
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let TZ_CACHE = null;
export function validZone(z) {
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
}
function tz() {
  if (TZ_CACHE) return TZ_CACHE;
  const want = dbGetSetting('automation.tz', '') || process.env.TZ || 'UTC';
  TZ_CACHE = validZone(want) ? want : 'UTC';
  return TZ_CACHE;
}
const clearTz = () => { TZ_CACHE = null; };

function wall(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz(), hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((x) => x.type === t)?.value ?? '00';
  // en-GB with hour12:false emits "24" for midnight on several ICU versions.
  // Without the % 24 a 00:xx schedule would never match.
  const hh = String(Number(g('hour')) % 24).padStart(2, '0');
  const date = `${g('year')}-${g('month')}-${g('day')}`;
  return { dow: DOW[g('weekday')] ?? 0, hhmm: `${hh}:${g('minute')}`, date, key: `${date}T${hh}:${g('minute')}` };
}

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A window whose end is before its start crosses midnight and belongs to the
// day it STARTED on — the case most implementations get wrong.
function inWindow({ days, start, end }, w) {
  if (start === end) return false;
  if (start < end) return days.includes(w.dow) && w.hhmm >= start && w.hhmm < end;
  const prev = (w.dow + 6) % 7;
  return (days.includes(w.dow) && w.hhmm >= start) || (days.includes(prev) && w.hhmm < end);
}

// One-shot due check. No stored due time: the key is re-derived every tick.
function dueNow(cfg, row, w) {
  if (!cfg.days.includes(w.dow) || w.hhmm < cfg.at) return null;
  const key = `${w.date}T${cfg.at}`;
  if (row.lastFiredKey === key) return null;
  const late = toMin(w.hhmm) - toMin(cfg.at);
  return late > (cfg.graceMinutes ?? 20) ? { key, skip: 'missed_window' } : { key };
}

// ---------------------------------------------------------------------------
//  Journal
// ---------------------------------------------------------------------------
const clip = (v, n = 480) => (v == null ? null : String(v).replace(/\s+/g, ' ').slice(0, n));

function beginRun(row, source, actor = '') {
  return dbInsertRun({
    autoId: row.id, autoName: row.name, kind: row.kind,
    startedAt: Date.now(), source, actor, outcome: 'running',
  });
}
function endRun(id, outcome, detail, error) {
  dbFinishRun(id, { outcome, endedAt: Date.now(), detail: detail ? JSON.stringify(detail) : null, error: clip(error) });
}
// The engine never declines to act without leaving a record: a silently
// not-running automation is worse than a visibly broken one.
function skip(row, source, reason, detail) {
  const id = beginRun(row, source);
  endRun(id, 'skipped', detail ? { reason, ...detail } : { reason }, reason);
  dbSetAutoState(row.id, {
    lastRunAt: Date.now(), lastResult: 'skipped', lastMessage: reason,
    firstBadAt: row.firstBadAt, snoozeUntil: row.snoozeUntil,
  });
}

function raise(row, level, title, detail, dedupe, cooldownMin = 60) {
  if (dedupe) {
    const last = dbLastEvent(dedupe);
    if (last && Date.now() - last.ts < cooldownMin * 60000) return false;
  }
  dbInsertEvent({ autoId: row?.id ?? null, kind: row?.kind ?? null, level, title, detail: detail ? JSON.stringify(detail) : null, dedupe });
  notify(level, title, detail).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
//  Optional webhook. Public hosts are allowed (Slack/Discord/ntfy are the whole
//  point); the specific pivots that would turn this into an SSRF into our own
//  LAN services are refused.
// ---------------------------------------------------------------------------
const DENY_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|169\.254\.|metadata\.)/i;
export function webhookProblem(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return 'Not a valid URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http and https are supported';
  if (DENY_HOST.test(u.hostname)) return 'Loopback, link-local and metadata hosts are not permitted';
  const sidecarPort = String(process.env.ROUTER_PORT || 5000);
  if (u.port === sidecarPort) return 'That port is used by the internal vendor service';
  return null;
}
async function notify(level, title, detail) {
  const url = dbGetSetting('automation.webhookUrl', '') || '';
  if (!url || webhookProblem(url)) return;
  if (level === 'info' && dbGetSetting('automation.webhookWarnOnly', 'true') === 'true') return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'manual',       // a 302 to loopback would defeat the host check
      body: JSON.stringify({ text: `[Blackhole.Net ${level}] ${title}`, level, title, detail }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* delivery is best-effort; the journal is the record */ }
}

// ---------------------------------------------------------------------------
//  Kill switches. Three, because the UI is unreachable exactly when DNS is.
// ---------------------------------------------------------------------------
let enabledCache = null;
export const invalidateEngineCache = () => { enabledCache = null; clearTz(); };

export function engineEnabled() {
  // Out-of-band file first: `touch ./data/automation.disable` on the host stops
  // everything with no UI and no working DNS.
  try { if (fs.existsSync(DISABLE_FILE)) return false; } catch { /* fall through */ }
  if (enabledCache === null) enabledCache = dbGetSetting('automation.enabled', 'true') !== 'false';
  return enabledCache;
}

// ---------------------------------------------------------------------------
//  Pi-hole helpers, always through the injected primitives so the engine shares
//  the cached SID, the deduped auth and the 401-retry already in server.js.
// ---------------------------------------------------------------------------
const primary = () => {
  const inst = D.primaryInstance();
  if (!inst) throw new Error('No Pi-hole instance is configured');
  return inst;
};
const phGet = (p) => D.instanceJson(primary(), p);
const phWrite = (p, method, body) => D.callInstance(primary(), p, { method, body });

async function internetUp() {
  try { const r = await D.probeSamples('1.1.1.1', 443, 2); return !!r.up; } catch { return false; }
}

// ---------------------------------------------------------------------------
//  Blast radius for a group: which clients and which domains a lockdown group
//  actually covers. This is what the UI shows before letting a rule be armed.
// ---------------------------------------------------------------------------
async function groupRadius(groupName) {
  const [groups, clients, domains] = await Promise.all([
    phGet('groups').catch(() => ({ groups: [] })),
    phGet('clients').catch(() => ({ clients: [] })),
    phGet('domains').catch(() => ({ domains: [] })),
  ]);
  const g = (groups.groups || []).find((x) => x.name === groupName);
  if (!g) return { found: false, groupName };
  const members = (clients.clients || []).filter((c) => (c.groups || []).includes(g.id));
  const rules = (domains.domains || []).filter((d) => (d.groups || []).includes(g.id));
  const catchAll = rules.filter((d) => d.type === 'deny' && d.kind === 'regex' && isCatchAll(d.domain));
  return {
    found: true, groupName, groupId: g.id, enabled: !!g.enabled,
    clients: members.map((c) => c.client),
    denyCount: rules.filter((d) => d.type === 'deny').length,
    allowCount: rules.filter((d) => d.type === 'allow').length,
    catchAll: catchAll.map((d) => d.domain),
  };
}

// Three probes is enough to recognise a catch-all without re-implementing the
// browser's linter here; the duplication is deliberate and stated.
function isCatchAll(pattern) {
  try {
    const re = new RegExp(String(pattern).split(';')[0], 'i');
    return re.test('example.com') && re.test('internal.lan') && re.test('a-b-c.test');
  } catch { return false; }
}

// ---------------------------------------------------------------------------
//  Shared config validators
// ---------------------------------------------------------------------------
const vDays = (v) => {
  const days = Array.isArray(v) ? [...new Set(v.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  return days.length ? days : null;
};
const vName = (v) => {
  const s = String(v ?? '').trim();
  return s && s.length <= 120 ? s : null;
};
const daysText = (days) =>
  days.length === 7 ? 'every day'
    : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'Monday to Friday'
      : days.length === 2 && days.includes(0) && days.includes(6) ? 'weekends'
        : days.map((d) => DOW_LABEL[d]).join(', ');

// ===========================================================================
//  KIND REGISTRY — the security model. Null-prototype so a stored kind of
//  "constructor" or "toString" cannot resolve to a truthy entry.
// ===========================================================================
const KINDS = Object.freeze(Object.assign(Object.create(null), {

  // -------------------------------------------------------------- 1. lockdown
  'access.window': {
    label: 'Scheduled Access Window', role: 'admin', model: 'reconcile', schedulable: true,
    blurb: 'Enables a Pi-hole group on a schedule. Point it at a group holding a catch-all deny pattern and the clients in that group lose DNS resolution for the window.',
    validate(raw) {
      const groupName = vName(raw.groupName);
      const days = vDays(raw.days);
      const start = HHMM.test(raw.start) ? raw.start : null;
      const end = HHMM.test(raw.end) ? raw.end : null;
      if (!groupName) return { error: 'Select the Pi-hole group this window controls.' };
      if (!days) return { error: 'Select at least one day.' };
      if (!start || !end) return { error: 'Start and end must be times of day, such as 22:00.' };
      if (start === end) return { error: 'Start and end cannot be the same time.' };
      return { config: { groupName, days, start, end } };
    },
    sentence: (c) => `${daysText(c.days)}, from ${c.start} to ${c.end}${c.end < c.start ? ' the next morning' : ''}, enable the group "${c.groupName}".`,
    async lint(c) {
      const notes = [];
      const r = await groupRadius(c.groupName).catch(() => null);
      if (!r) { notes.push(['warn', 'Could not read the group list from Pi-hole, so the blast radius is unknown.']); return notes; }
      if (!r.found) { notes.push(['err', `No group named "${c.groupName}" exists. Create it in the Groups section first.`]); return notes; }
      if (r.groupId === 0) notes.push(['err', 'The Default group applies to every client that is not assigned elsewhere. This rule would take DNS away from the whole network.']);
      if (!r.clients.length) notes.push(['warn', 'No client is assigned to this group, so the window will have no effect until you add one in the Clients section.']);
      else notes.push(['info', `${r.clients.length} client${r.clients.length > 1 ? 's' : ''} in scope: ${r.clients.slice(0, 6).join(', ')}${r.clients.length > 6 ? ', …' : ''}.`]);
      if (!r.catchAll.length) notes.push(['warn', `The group holds no catch-all deny pattern, so enabling it blocks only its ${r.denyCount} specific deny entr${r.denyCount === 1 ? 'y' : 'ies'} rather than all resolution.`]);
      else notes.push(['info', `Catch-all deny pattern present (${r.catchAll[0]}), so resolution stops entirely for those clients during the window.`]);
      const span = c.end < c.start ? (1440 - toMin(c.start)) + toMin(c.end) : toMin(c.end) - toMin(c.start);
      if (span >= 1380) notes.push(['warn', 'The window covers almost the entire day.']);
      return notes;
    },
    preview: (c) => groupRadius(c.groupName),
    // Refuses group 0 at execution time too, not only in the linter: the group
    // could have been renamed after the rule was armed.
    async reconcile(row, w) {
      const c = row.config;
      const want = inWindow(c, w);
      const gs = await phGet('groups');
      const g = (gs.groups || []).find((x) => x.name === c.groupName);
      if (!g) return { changed: false, skip: `No group named "${c.groupName}"` };
      if (g.id === 0) return { changed: false, skip: 'Refusing to control the Default group' };
      if (!!g.enabled === want) return { changed: false, state: want ? 'in window' : 'outside window' };
      // Echo name and comment back so the PUT does not blank them.
      await phWrite(`groups/${encodeURIComponent(g.name)}`, 'PUT', {
        name: g.name, comment: g.comment ?? '', enabled: want,
      });
      return { changed: true, state: want ? 'window opened' : 'window closed', group: g.name, enabled: want };
    },
  },

  // ------------------------------------------------------- 2. gravity refresh
  'gravity.refresh': {
    label: 'Filter List Refresh', role: 'contributor', model: 'edge', schedulable: true, exclusive: 'gravity',
    blurb: 'Runs a Pi-hole gravity update so the filter lists pick up upstream changes. Skipped when the internet is down, because a refresh during an outage truncates every list.',
    validate(raw) {
      const days = vDays(raw.days);
      const at = HHMM.test(raw.at) ? raw.at : null;
      const minHours = Math.min(Math.max(Number(raw.minHours ?? 20) || 0, 0), 168);
      if (!days) return { error: 'Select at least one day.' };
      if (!at) return { error: 'Set a time of day, such as 03:30.' };
      return { config: { days, at, minHours } };
    },
    sentence: (c) => `${daysText(c.days)} at ${c.at}, refresh every filter list${c.minHours ? `, unless one ran in the previous ${c.minHours} hours` : ''}.`,
    async lint(c) {
      const notes = [['info', 'A refresh takes a few minutes and briefly raises load on the Pi-hole host. Filtering keeps working throughout.']];
      if (toMin(c.at) >= 360 && toMin(c.at) <= 1380) notes.push(['warn', 'This runs during the day. An overnight time is usually less disruptive.']);
      return notes;
    },
    async preview() {
      const last = Number(dbGetSetting('automation.gravityLastRun', '0')) || 0;
      return { lastRun: last || null, internetUp: await internetUp() };
    },
    async run(row) {
      const c = row.config;
      const last = Number(dbGetSetting('automation.gravityLastRun', '0')) || 0;
      if (c.minHours && last && Date.now() - last < c.minHours * 3600000) {
        return { skip: `A refresh already ran within the last ${c.minHours} hours` };
      }
      // Hardcoded precondition, not a user-editable condition: a gravity run
      // while the upstream lists are unreachable replaces them with empty ones.
      if (!await internetUp()) return { skip: 'The internet is unreachable; refusing to refresh filter lists' };
      await phWrite('action/gravity', 'POST');
      dbSetSetting('automation.gravityLastRun', String(Date.now()));
      const sum = await phGet('stats/summary').catch(() => null);
      return { detail: { domainsOnLists: sum?.gravity?.domains_being_blocked ?? null } };
    },
  },

  // -------------------------------------------------------- 3. config backup
  'backup.teleporter': {
    label: 'Configuration Backup', role: 'admin', model: 'edge', schedulable: true,
    blurb: 'Writes a Pi-hole Teleporter archive into data/backups and keeps the most recent few.',
    validate(raw) {
      const days = vDays(raw.days);
      const at = HHMM.test(raw.at) ? raw.at : null;
      const keep = Math.min(Math.max(Number(raw.keep ?? 7) || 1, 1), 60);
      if (!days) return { error: 'Select at least one day.' };
      if (!at) return { error: 'Set a time of day, such as 04:00.' };
      return { config: { days, at, keep } };
    },
    sentence: (c) => `${daysText(c.days)} at ${c.at}, save a configuration archive and keep the ${c.keep} most recent.`,
    lint: async () => ([['info', 'Archives are written inside the mounted data directory, so they survive a container rebuild. They contain your full Pi-hole configuration — treat them as sensitive.']]),
    async preview() {
      const files = listBackups();
      return { count: files.length, newest: files[0]?.name ?? null, dir: 'data/backups' };
    },
    async run(row) {
      const buf = await D.teleporterBuffer();
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = wall().key.replace(/[:T]/g, '-');
      const name = `pihole-${stamp}.zip`;
      const file = path.join(BACKUP_DIR, name);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      const removed = rotateBackups(row.config.keep);
      return { detail: { file: `data/backups/${name}`, bytes: buf.length, removed } };
    },
  },

  // ------------------------------------------------------ 4. blocking watchdog
  'blocking.watchdog': {
    label: 'Filtering Watchdog', role: 'contributor', model: 'reconcile', schedulable: true,
    blurb: 'Re-enables filtering if it was switched off without a timer and left off. Pi-hole only auto-resumes when a timer was set; this covers the case where nobody set one.',
    validate(raw) {
      const afterMinutes = Math.min(Math.max(Number(raw.afterMinutes ?? 30) || 0, 5), 720);
      return { config: { afterMinutes } };
    },
    sentence: (c) => `If filtering is switched off with no timer, turn it back on after ${c.afterMinutes} minutes.`,
    lint: async () => ([['info', 'A pause created with an explicit timer is left alone — Pi-hole resumes those itself. Only an open-ended pause is corrected.']]),
    async preview() {
      const b = await phGet('dns/blocking').catch(() => null);
      return b ? { blocking: b.blocking, timer: b.timer ?? null } : { unreachable: true };
    },
    async reconcile(row) {
      const c = row.config;
      const b = await phGet('dns/blocking');
      // An explicit timer means somebody chose a duration; leave it.
      if (b.blocking === 'enabled' || b.timer) {
        return { changed: false, clearBad: true, state: b.timer ? 'paused with a timer' : 'filtering enabled' };
      }
      const since = row.firstBadAt || Date.now();
      const mins = Math.floor((Date.now() - since) / 60000);
      if (!row.firstBadAt) return { changed: false, setBad: Date.now(), state: 'open-ended pause detected' };
      if (mins < c.afterMinutes) return { changed: false, state: `open-ended pause, ${mins} of ${c.afterMinutes} minutes` };
      await phWrite('dns/blocking', 'POST', { blocking: true, timer: null });
      raise(row, 'warn', 'Filtering was re-enabled automatically',
        { pausedMinutes: mins, threshold: c.afterMinutes }, `watchdog:${row.id}`, 30);
      return { changed: true, clearBad: true, state: `re-enabled after ${mins} minutes` };
    },
  },

  // ------------------------------------------------------ 5. integrity monitor
  'integrity.monitor': {
    label: 'Filtering Integrity', role: 'reader', model: 'poll', schedulable: true, alertOnly: true,
    blurb: 'Alerts when Pi-hole is answering plenty of queries but blocking almost none — the signature of an empty gravity database or a filter list that stopped loading.',
    validate(raw) {
      const minQueries = Math.min(Math.max(Number(raw.minQueries ?? 500) || 0, 50), 100000);
      const floorPercent = Math.min(Math.max(Number(raw.floorPercent ?? 2) || 0, 0), 90);
      return { config: { minQueries, floorPercent } };
    },
    sentence: (c) => `Alert when more than ${c.minQueries} queries have been answered today but under ${c.floorPercent}% were blocked.`,
    lint: async () => ([['info', 'Alert only — this never changes anything. A brand-new install legitimately blocks 0% until the first filter-list refresh completes.']]),
    async preview() {
      const s = await phGet('stats/summary').catch(() => null);
      if (!s) return { unreachable: true };
      return { total: s.queries?.total ?? 0, percentBlocked: s.queries?.percent_blocked ?? 0, onLists: s.gravity?.domains_being_blocked ?? 0 };
    },
    async poll(row) {
      const c = row.config;
      const s = await phGet('stats/summary');
      const total = s.queries?.total ?? 0;
      const pct = s.queries?.percent_blocked ?? 0;
      const onLists = s.gravity?.domains_being_blocked ?? 0;
      if (total < c.minQueries) return { state: `only ${total} queries so far today` };
      if (pct >= c.floorPercent) return { clearBad: true, state: `${pct.toFixed(1)}% blocked` };
      const fired = raise(row, 'err', 'Filtering may have stopped working',
        { total, percentBlocked: pct, domainsOnLists: onLists },
        `integrity:${row.id}`, 180);
      return { state: `${pct.toFixed(1)}% blocked of ${total} queries`, alerted: fired };
    },
  },

  // ---------------------------------------------------------- 6. new devices
  'device.new': {
    label: 'New Device Alert', role: 'reader', model: 'poll', schedulable: true, alertOnly: true,
    blurb: 'Records every MAC address seen on the network and raises an alert the first time an unfamiliar one appears.',
    validate: () => ({ config: {} }),
    sentence: () => 'Alert when a device with an unfamiliar MAC address appears on the network.',
    lint: async () => ([
      ['info', 'Alert only — a new device is never blocked or quarantined.'],
      ['warn', 'Modern phones randomise their MAC address per network, so a familiar device can occasionally appear as a new one.'],
    ]),
    async preview() {
      return { known: dbSeenCount(), note: 'Arming this rule adopts the devices currently on the network as the baseline.' };
    },
    // Adopt the current inventory when the rule is first armed, or every
    // existing device alerts at once.
    async onArm() {
      const list = await currentMacs();
      if (list.length) dbSeedSeen(list);
      return { baseline: list.length };
    },
    async poll(row) {
      const list = await currentMacs();
      const fresh = [];
      for (const d of list) {
        if (!dbSeenDevice(d.mac)) fresh.push(d);
        dbUpsertSeen(d);
      }
      if (!fresh.length) return { state: `${list.length} devices, none new` };
      for (const d of fresh) {
        raise(row, 'warn', `New device on the network: ${d.name || d.mac}`,
          { mac: d.mac, ip: d.ip, name: d.name }, `device:${d.mac}`, 1440);
      }
      return { state: `${fresh.length} new device(s)`, detail: { macs: fresh.map((f) => f.mac) } };
    },
  },

  // ------------------------------------------------------------- 7. infra watch
  'infra.watch': {
    label: 'Infrastructure Watch', role: 'reader', model: 'poll', schedulable: true, alertOnly: true,
    blurb: 'Watches the gateway and access points for sustained WAN loss or high CPU/memory, and alerts once per episode rather than once per sample.',
    validate(raw) {
      const cpuPct = Math.min(Math.max(Number(raw.cpuPct ?? 90) || 0, 40), 100);
      const memPct = Math.min(Math.max(Number(raw.memPct ?? 90) || 0, 40), 100);
      const dwellMinutes = Math.min(Math.max(Number(raw.dwellMinutes ?? 5) || 0, 1), 120);
      const watchWan = raw.watchWan !== false;
      return { config: { cpuPct, memPct, dwellMinutes, watchWan } };
    },
    sentence: (c) => `Alert when ${[c.watchWan ? 'the internet is unreachable' : null, `gateway CPU is above ${c.cpuPct}%`, `memory is above ${c.memPct}%`].filter(Boolean).join(', or ')}, sustained for ${c.dwellMinutes} minutes.`,
    lint: async () => ([['info', 'Alert only. Gateway reboots and Wi-Fi radio changes are deliberately not automatable — they stay manual, confirmed actions in the Routers & APs section.']]),
    async preview() {
      const st = await D.routerJson('/status').catch(() => null);
      return st ? { cpu: st.cpu_usage ?? null, mem: st.mem_usage ?? null, wanUp: st.wan_ipv4_up ?? null, stale: !!st.stale } : { unreachable: true };
    },
    async poll(row) {
      const c = row.config;
      const [st, net] = await Promise.all([
        D.routerJson('/status').catch(() => null),
        c.watchWan ? internetUp() : Promise.resolve(true),
      ]);
      const bad = [];
      if (c.watchWan && !net) bad.push('the internet is unreachable');
      if (st && !st.stale) {
        const cpu = Number(st.cpu_usage);
        const mem = Number(st.mem_usage);
        if (Number.isFinite(cpu) && cpu >= c.cpuPct) bad.push(`gateway CPU at ${cpu}%`);
        if (Number.isFinite(mem) && mem >= c.memPct) bad.push(`gateway memory at ${mem}%`);
      }
      if (!bad.length) return { clearBad: true, state: 'healthy' };
      // Hysteresis: a flapping WAN must produce one alert, not fifty.
      if (!row.firstBadAt) return { setBad: Date.now(), state: `degraded: ${bad.join('; ')}` };
      const mins = Math.floor((Date.now() - row.firstBadAt) / 60000);
      if (mins < c.dwellMinutes) return { state: `degraded for ${mins} of ${c.dwellMinutes} minutes` };
      const fired = raise(row, 'err', `Infrastructure degraded: ${bad.join('; ')}`,
        { minutes: mins, conditions: bad }, `infra:${row.id}`, 60);
      return { state: `degraded for ${mins} minutes`, alerted: fired };
    },
  },
}));

export const kindList = () => Object.entries(KINDS).map(([key, k]) => ({
  key, label: k.label, role: k.role, model: k.model, blurb: k.blurb, alertOnly: !!k.alertOnly,
}));

// ---------------------------------------------------------------------------
//  Backups on disk
// ---------------------------------------------------------------------------
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('pihole-') && f.endsWith('.zip'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
function rotateBackups(keep) {
  const files = listBackups();
  const doomed = files.slice(Math.max(Number(keep) || 1, 1));
  for (const f of doomed) { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch { /* ignore */ } }
  return doomed.map((f) => f.name);
}

async function currentMacs() {
  const out = new Map();
  const dev = await phGet('network/devices').catch(() => null);
  for (const d of dev?.devices || []) {
    const mac = String(d.hwaddr || '').toLowerCase();
    if (!mac || mac === '00:00:00:00:00:00') continue;
    const ipRec = (d.ips || [])[0];
    out.set(mac, { mac, ip: ipRec?.ip ?? null, name: ipRec?.name ?? null, vendor: d.macVendor ?? null });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
//  Executor
// ---------------------------------------------------------------------------
const inFlight = new Set();      // automation ids
const mutex = new Set();         // named exclusive resources

// The author's role is re-resolved live, so a demotion or deletion revokes the
// rule immediately rather than at the end of their session.
function authorProblem(row, kind) {
  if (!row.createdBy) return null;              // legacy/seeded rows
  const live = dbUser(row.createdBy);
  if (!live) return 'The rule author no longer exists';
  if (rankOf(live.role) < rankOf(kind.role)) return 'The rule author no longer holds the required role';
  return null;
}

async function execute(row, source, actor = '') {
  const kind = KINDS[row.kind];
  if (!kind) { skip(row, source, `Unknown automation type "${row.kind}"`); return; }
  if (row.invalid) { skip(row, source, row.invalid); return; }
  if (inFlight.has(row.id)) { skip(row, source, 'A previous run is still in progress'); return; }
  if (kind.exclusive && mutex.has(kind.exclusive)) { skip(row, source, `Another ${kind.exclusive} operation is in progress`); return; }
  const revoked = authorProblem(row, kind);
  if (revoked) {
    dbUpdateAutomation(row.id, { enabled: false });
    skip(row, source, revoked);
    raise(row, 'warn', `Automation disabled: ${row.name}`, { reason: revoked }, `revoked:${row.id}`, 1440);
    return;
  }

  inFlight.add(row.id);
  if (kind.exclusive) mutex.add(kind.exclusive);
  const runId = beginRun(row, source, actor);
  try {
    // Re-read the kill switch immediately before the first write so a panic
    // lands mid-tick rather than after it.
    if (source !== 'manual' && !engineEnabled()) {
      endRun(runId, 'skipped', { reason: 'Engine disabled' }, 'Engine disabled');
      return;
    }
    const w = wall();
    const fn = kind.reconcile || kind.poll || kind.run;
    const res = (await fn.call(kind, row, w)) || {};
    const state = {
      lastRunAt: Date.now(),
      lastResult: res.skip ? 'skipped' : 'ok',
      lastMessage: res.skip || res.state || 'Completed',
    };
    if (res.setBad) state.firstBadAt = res.setBad;
    else if (res.clearBad) state.firstBadAt = null;
    else state.firstBadAt = row.firstBadAt ?? null;
    state.snoozeUntil = row.snoozeUntil ?? null;
    dbSetAutoState(row.id, state);
    endRun(runId, res.skip ? 'skipped' : 'ok', res.detail ? { state: state.lastMessage, ...res.detail } : { state: state.lastMessage }, res.skip || null);
    return res;
  } catch (e) {
    dbSetAutoState(row.id, {
      lastRunAt: Date.now(), lastResult: 'failed', lastMessage: clip(e.message, 200),
      firstBadAt: row.firstBadAt ?? null, snoozeUntil: row.snoozeUntil ?? null,
    });
    endRun(runId, 'failed', null, e.message);
    raise(row, 'err', `Automation failed: ${row.name}`, { error: clip(e.message) }, `fail:${row.id}`, 60);
    throw e;
  } finally {
    inFlight.delete(row.id);
    if (kind.exclusive) mutex.delete(kind.exclusive);
  }
}

// ---------------------------------------------------------------------------
//  Tick
// ---------------------------------------------------------------------------
let ticking = false;

async function tick() {
  if (ticking) { engine.lag += 1; return; }
  ticking = true;
  // The entire body is guarded: an unhandled rejection inside a timer callback
  // terminates the process under Node's default policy, which would take the
  // login page down because one router was unreachable.
  try {
    engine.ticks += 1;
    engine.lastTickAt = Date.now();
    if (!engineEnabled()) return;
    const w = wall();
    for (const row of dbAutomations()) {
      if (!row.enabled) continue;
      const kind = KINDS[row.kind];
      if (!kind) continue;
      if (row.snoozeUntil && Date.now() < row.snoozeUntil) continue;
      try {
        if (kind.model === 'edge') {
          const due = dueNow(row.config, row, w);
          if (!due) continue;
          // Claim the key first, so a slow run cannot be started twice.
          dbSetAutoState(row.id, { lastFiredKey: due.key, firstBadAt: row.firstBadAt ?? null, snoozeUntil: row.snoozeUntil ?? null });
          if (due.skip) { skip(row, 'schedule', 'Missed its window while the service was not running', { key: due.key }); continue; }
          await execute({ ...row, lastFiredKey: due.key }, 'schedule');
        } else {
          await execute(row, kind.model === 'poll' ? 'poll' : 'reconcile');
        }
      } catch (e) {
        engine.lastError = `${row.name}: ${e.message}`;
      }
    }
  } catch (e) {
    engine.lastError = e.message;
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
export function initAutomation(deps) {
  const required = ['instances', 'primaryInstance', 'instanceById', 'callInstance',
    'instanceJson', 'piholeJson', 'routerJson', 'probeSamples', 'teleporterBuffer'];
  for (const k of required) {
    if (typeof deps?.[k] !== 'function') {
      // Fail loudly at boot, not silently at 03:15, if a future refactor
      // renames one of these helpers.
      throw new Error(`initAutomation: missing required primitive "${k}"`);
    }
  }
  D = deps;
  engine.startedAt = Date.now();

  const stuck = dbReconcileRuns();
  if (stuck) console.log(`  automation: marked ${stuck} interrupted run(s) as failed`);

  // Boot self-test: if two different zones format one instant identically, ICU
  // has no tz data and every schedule would silently revert to UTC.
  try {
    const t = new Date('2026-06-15T12:00:00Z');
    const a = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', hour12: false }).format(t);
    const b = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(t);
    if (a === b) { engine.tzUnsupported = true; console.warn('  automation: WARNING this runtime has no time-zone data; schedules will use UTC'); }
  } catch { engine.tzUnsupported = true; }

  dbPruneAutomation();
  setInterval(dbPruneAutomation, 3_600_000).unref?.();
  const t = setInterval(tick, TICK_MS);
  t.unref?.();
  tick();
  console.log(`  automation: engine ${engineEnabled() ? 'armed' : 'DISABLED'} (zone ${tz()}, ${TICK_MS / 1000}s tick)`);
  return engine;
}

export function automationStatus() {
  const rows = dbAutomations();
  return {
    enabled: engineEnabled(),
    killFile: (() => { try { return fs.existsSync(DISABLE_FILE); } catch { return false; } })(),
    tz: tz(), tzUnsupported: engine.tzUnsupported,
    now: wall(), startedAt: engine.startedAt, lastTickAt: engine.lastTickAt,
    // A dead engine must read as "Stalled", not as a quiet night.
    stalled: !!engine.lastTickAt && Date.now() - engine.lastTickAt > TICK_MS * 3,
    ticks: engine.ticks, lag: engine.lag, lastError: engine.lastError,
    tickSeconds: TICK_MS / 1000,
    total: rows.length, armed: rows.filter((r) => r.enabled).length,
    unacked: dbUnackedEvents(),
    webhook: !!(dbGetSetting('automation.webhookUrl', '') || ''),
    backups: listBackups().slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
//  HTTP API
// ---------------------------------------------------------------------------
const shape = (row) => {
  const kind = KINDS[row.kind];
  return {
    id: row.id, kind: row.kind, name: row.name, enabled: row.enabled,
    config: row.config, invalid: row.invalid || null,
    label: kind?.label ?? row.kind, model: kind?.model ?? null,
    role: kind?.role ?? null, alertOnly: !!kind?.alertOnly,
    sentence: kind && !row.invalid ? safeSentence(kind, row.config) : null,
    lastRunAt: row.lastRunAt, lastResult: row.lastResult, lastMessage: row.lastMessage,
    lastFiredKey: row.lastFiredKey, firstBadAt: row.firstBadAt, snoozeUntil: row.snoozeUntil,
    createdBy: row.createdBy, createdAt: row.createdAt,
    nextRun: kind?.model === 'edge' && !row.invalid ? nextEdge(row.config) : null,
  };
};
const safeSentence = (kind, config) => { try { return kind.sentence(config); } catch { return null; } };

// Next occurrence of an edge schedule, for display only — never persisted.
function nextEdge(cfg) {
  if (!Array.isArray(cfg?.days) || !cfg.days.length || !HHMM.test(cfg.at || '')) return null;
  const w = wall();
  for (let i = 0; i < 8; i++) {
    const dow = (w.dow + i) % 7;
    if (!cfg.days.includes(dow)) continue;
    if (i === 0 && w.hhmm >= cfg.at) continue;
    return { in: i, dow, dowLabel: DOW_SHORT[dow], at: cfg.at };
  }
  return null;
}

export function automationRouter(deps) {
  if (!D) D = deps;
  const r = express.Router();

  r.get('/', requireRole('reader'), (_req, res) => {
    res.json({ status: automationStatus(), kinds: kindList(), automations: dbAutomations().map(shape) });
  });

  r.get('/runs', requireRole('reader'), (req, res) => {
    res.json({ runs: dbRuns({ autoId: req.query.id || null, limit: req.query.limit, before: req.query.before }) });
  });

  r.get('/events', requireRole('reader'), (req, res) => {
    res.json({ events: dbEvents({ limit: req.query.limit, before: req.query.before, level: req.query.level || null }) });
  });

  r.post('/events/ack', requireRole('contributor'), (req, res) => {
    res.json({ acked: dbAckEvents(req.body?.ids) });
  });

  // Engine settings. The webhook URL is returned redacted — it is a secret in
  // the sense that it grants posting rights to someone else's channel.
  r.get('/settings', requireRole('reader'), (_req, res) => {
    const url = dbGetSetting('automation.webhookUrl', '') || '';
    res.json({
      enabled: engineEnabled(), tz: tz(),
      webhookSet: !!url, webhookHost: url ? safeHost(url) : null,
      webhookWarnOnly: dbGetSetting('automation.webhookWarnOnly', 'true') !== 'false',
    });
  });

  r.post('/settings', requireRole('admin'), (req, res) => {
    const b = req.body || {};
    if (b.tz !== undefined) {
      if (!validZone(b.tz)) return res.status(400).json({ error: 'bad_tz', message: 'Not a recognised IANA time zone, for example Asia/Kolkata.' });
      dbSetSetting('automation.tz', b.tz);
    }
    if (b.webhookUrl !== undefined) {
      const url = String(b.webhookUrl || '').trim();
      if (url) {
        const problem = webhookProblem(url);
        if (problem) return res.status(400).json({ error: 'bad_webhook', message: problem });
      }
      dbSetSetting('automation.webhookUrl', url);
    }
    if (b.webhookWarnOnly !== undefined) dbSetSetting('automation.webhookWarnOnly', b.webhookWarnOnly ? 'true' : 'false');
    if (b.enabled !== undefined) dbSetSetting('automation.enabled', b.enabled ? 'true' : 'false');
    invalidateEngineCache();
    res.json({ ok: true, status: automationStatus() });
  });

  // One validator for create and update.
  const parse = (body, res) => {
    const kindKey = String(body?.kind || '');
    const kind = KINDS[kindKey];
    if (!kind) { res.status(400).json({ error: 'bad_kind', message: 'Unknown automation type.' }); return null; }
    const name = vName(body?.name) || kind.label;
    const v = kind.validate(body?.config || {});
    if (v.error) { res.status(400).json({ error: 'bad_config', message: v.error }); return null; }
    return { kindKey, kind, name, config: v.config };
  };

  // Creating a rule requires the role that rule's EFFECT requires — otherwise a
  // contributor could author an admin-only action and have the engine run it.
  const guardKind = (req, res, kind) => {
    if (rankOf(req.user?.role) < rankOf(kind.role)) {
      res.status(403).json({ error: 'forbidden', message: `This automation performs an action that requires the ${kind.role} role.` });
      return false;
    }
    return true;
  };

  r.post('/', requireRole('contributor'), (req, res) => {
    const p = parse(req.body, res); if (!p) return;
    if (!guardKind(req, res, p.kind)) return;
    // Always created disabled: arming is a separate, explicit act.
    const row = dbInsertAutomation({
      id: crypto.randomUUID(), kind: p.kindKey, name: p.name, enabled: false,
      config: p.config, createdBy: req.user.username,
    });
    res.json({ automation: shape(row) });
  });

  r.put('/:id', requireRole('contributor'), (req, res) => {
    const row = dbAutomation(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const p = parse({ ...req.body, kind: row.kind }, res); if (!p) return;
    if (!guardKind(req, res, p.kind)) return;
    res.json({ automation: shape(dbUpdateAutomation(row.id, { name: p.name, config: p.config })) });
  });

  r.post('/:id/enabled', requireRole('contributor'), async (req, res) => {
    const row = dbAutomation(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const kind = KINDS[row.kind];
    if (!kind) return res.status(400).json({ error: 'bad_kind' });
    if (!guardKind(req, res, kind)) return;
    const want = !!req.body?.enabled;
    if (want && row.invalid) return res.status(400).json({ error: 'invalid_config', message: row.invalid });
    if (want && kind.onArm) { try { await kind.onArm.call(kind, row); } catch { /* baseline is best-effort */ } }
    const out = dbUpdateAutomation(row.id, { enabled: want });
    dbInsertEvent({
      autoId: row.id, kind: row.kind, level: 'info',
      title: `${want ? 'Armed' : 'Disarmed'}: ${row.name}`, detail: JSON.stringify({ actor: req.user.username }),
    });
    res.json({ automation: shape(out) });
  });

  r.post('/:id/snooze', requireRole('contributor'), (req, res) => {
    const row = dbAutomation(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const mins = Math.min(Math.max(Number(req.body?.minutes ?? 60) || 0, 0), 10080);
    dbSetAutoState(row.id, { firstBadAt: row.firstBadAt ?? null, snoozeUntil: mins ? Date.now() + mins * 60000 : null });
    res.json({ automation: shape(dbAutomation(row.id)) });
  });

  r.delete('/:id', requireRole('contributor'), (req, res) => {
    const row = dbAutomation(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const kind = KINDS[row.kind];
    if (kind && !guardKind(req, res, kind)) return;
    dbDeleteAutomation(row.id);
    dbInsertEvent({ autoId: row.id, kind: row.kind, level: 'info', title: `Deleted: ${row.name}`, detail: JSON.stringify({ actor: req.user.username }) });
    res.json({ ok: true });
  });

  // Preview / lint / simulate — the three things that let an operator see what a
  // rule WOULD do before arming it.
  r.post('/inspect', requireRole('reader'), async (req, res) => {
    const kindKey = String(req.body?.kind || '');
    const kind = KINDS[kindKey];
    if (!kind) return res.status(400).json({ error: 'bad_kind' });
    const v = kind.validate(req.body?.config || {});
    if (v.error) return res.json({ valid: false, message: v.error, notes: [], sentence: null });
    let notes = [], preview = null;
    try { notes = (await kind.lint.call(kind, v.config)) || []; } catch (e) { notes = [['warn', `Could not complete the checks: ${e.message}`]]; }
    try { preview = kind.preview ? await kind.preview.call(kind, v.config) : null; } catch { preview = null; }
    res.json({ valid: true, sentence: safeSentence(kind, v.config), notes, preview, config: v.config, role: kind.role });
  });

  r.post('/:id/run', requireRole('contributor'), async (req, res) => {
    const row = dbAutomation(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const kind = KINDS[row.kind];
    if (!kind) return res.status(400).json({ error: 'bad_kind' });
    if (!guardKind(req, res, kind)) return;
    const simulate = !!req.body?.simulate;
    if (simulate) {
      // Separate evaluate-only path; still writes a full run row.
      const runId = beginRun(row, 'simulate', req.user.username);
      try {
        const notes = (await kind.lint.call(kind, row.config)) || [];
        const preview = kind.preview ? await kind.preview.call(kind, row.config) : null;
        const w = wall();
        const would = kind.model === 'reconcile' && row.kind === 'access.window'
          ? (inWindow(row.config, w) ? 'enable the group' : 'leave the group disabled')
          : kind.model === 'edge' ? `run at ${row.config.at}` : 'evaluate the current state';
        endRun(runId, 'simulated', { would, notes, preview });
        return res.json({ simulated: true, would, notes, preview, at: w });
      } catch (e) {
        endRun(runId, 'failed', null, e.message);
        return res.status(502).json({ error: 'simulate_failed', message: e.message });
      }
    }
    try {
      const out = await execute(row, 'manual', req.user.username);
      res.json({ ok: true, result: out ?? null, automation: shape(dbAutomation(row.id)) });
    } catch (e) {
      res.status(502).json({ error: 'run_failed', message: e.message });
    }
  });

  // Kill switch. Deliberately CONTRIBUTOR, not admin: stopping something must
  // never need a higher privilege than starting it.
  r.post('/panic', requireRole('contributor'), async (req, res) => {
    const actor = req.user?.username || '';
    dbSetSetting('automation.enabled', 'false');
    let disarmed = 0;
    for (const row of dbAutomations()) {
      if (row.enabled) { dbUpdateAutomation(row.id, { enabled: false }); disarmed += 1; }
    }
    invalidateEngineCache();
    const steps = [];
    // Report honestly: a failure here must not be dressed up as success.
    try { await phWrite('dns/blocking', 'POST', { blocking: true, timer: null }); steps.push({ step: 'filtering re-enabled', ok: true }); }
    catch (e) { steps.push({ step: 'filtering re-enabled', ok: false, message: e.message }); }
    const lockGroup = dbGetSetting('automation.lockdownGroup', '') || '';
    if (lockGroup) {
      try {
        const gs = await phGet('groups');
        const g = (gs.groups || []).find((x) => x.name === lockGroup);
        if (g && g.id !== 0 && g.enabled) {
          await phWrite(`groups/${encodeURIComponent(g.name)}`, 'PUT', { name: g.name, comment: g.comment ?? '', enabled: false });
          steps.push({ step: `group "${lockGroup}" disabled`, ok: true });
        }
      } catch (e) { steps.push({ step: `group "${lockGroup}" disabled`, ok: false, message: e.message }); }
    }
    dbInsertRun({ autoName: 'Emergency stop', kind: 'panic', startedAt: Date.now(), endedAt: Date.now(),
      source: 'panic', actor, outcome: steps.every((s) => s.ok) ? 'ok' : 'failed', detail: JSON.stringify({ disarmed, steps }) });
    dbInsertEvent({ level: 'warn', title: 'Emergency stop invoked', detail: JSON.stringify({ actor, disarmed, steps }) });
    res.json({ ok: steps.every((s) => s.ok), disarmed, steps, status: automationStatus() });
  });

  return r;
}

const safeHost = (u) => { try { return new URL(u).host; } catch { return null; } };
