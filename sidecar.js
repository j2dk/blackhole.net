// ---------------------------------------------------------------------------
//  Embedded vendor sidecar
//
//  The router/AP drivers (TP-Link, Asus, OpenWrt) are Python libraries, so they
//  run as a small Flask service. It used to be a second container; it now runs
//  as a supervised child process inside this one, listening on loopback only.
//
//  ROUTER_SIDECAR:
//    embedded (default) — spawn and supervise router/router_service.py here
//    external           — do not spawn; talk to ROUTER_SERVICE_URL as before
//    off                — do not spawn and do not expect one
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MODE = (process.env.ROUTER_SIDECAR || 'embedded').toLowerCase();
const BIND = process.env.ROUTER_BIND || '127.0.0.1';
const PORT = Number(process.env.ROUTER_PORT || 5000);

// In the image this is the venv interpreter; on a dev box, whatever is on PATH.
const PYTHON_CANDIDATES = [
  process.env.PYTHON_BIN,
  '/opt/venv/bin/python',
  'python3',
  'python',
].filter(Boolean);

const state = {
  mode: MODE,
  running: false,
  pid: null,
  restarts: 0,
  lastExit: null,
  lastError: null,
  startedAt: null,
};

let child = null;
let stopping = false;
let backoff = 1000;
const BACKOFF_MAX = 30000;
let timer = null;

function resolvePython() {
  for (const c of PYTHON_CANDIDATES) {
    // A bare command name has to be resolved by the OS, so only absolute paths
    // can be checked up front; bare names are handed to spawn and fail loudly.
    if (!c.includes('/') && !c.includes('\\')) return c;
    if (existsSync(c)) return c;
  }
  return 'python3';
}

// Keep the child's chatter distinguishable from the app's own log lines.
function pipe(stream, label) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) console.log(`  [sidecar${label}] ${line}`);
  });
}

function launch(dirname) {
  const script = path.join(dirname, 'router', 'router_service.py');
  if (!existsSync(script)) {
    state.lastError = `router_service.py not found at ${script}`;
    console.warn(`  Vendor sidecar not started: ${state.lastError}`);
    return;
  }
  const bin = resolvePython();
  child = spawn(bin, ['-u', 'router_service.py'], {
    cwd: path.join(dirname, 'router'),
    env: {
      ...process.env,
      ROUTER_BIND: BIND,
      ROUTER_PORT: String(PORT),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.running = true;
  state.pid = child.pid;
  state.startedAt = Date.now();
  pipe(child.stdout, '');
  pipe(child.stderr, ':err');

  child.on('error', (err) => {
    state.lastError = err.message;
    console.error(`  Vendor sidecar failed to start (${bin}): ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    state.running = false;
    state.pid = null;
    state.lastExit = signal ? `signal ${signal}` : `code ${code}`;
    child = null;
    if (stopping) return;
    // Exponential backoff: a misconfigured interpreter would otherwise spin.
    state.restarts += 1;
    console.warn(`  Vendor sidecar exited (${state.lastExit}); restarting in ${backoff}ms`);
    timer = setTimeout(() => { launch(dirname); }, backoff);
    timer.unref?.();
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });

  // A process that stays up for a while has clearly started cleanly, so the
  // next crash should retry promptly rather than inherit a long backoff.
  const settle = setTimeout(() => { backoff = 1000; }, 60000);
  settle.unref?.();
}

export function startSidecar(dirname) {
  if (MODE !== 'embedded') {
    console.log(`  Vendor sidecar: ${MODE} (not spawned here)`);
    return state;
  }
  launch(dirname);
  return state;
}

export function stopSidecar() {
  stopping = true;
  if (timer) clearTimeout(timer);
  if (!child) return Promise.resolve();
  const c = child;
  return new Promise((resolve) => {
    const done = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }, 5000);
    done.unref?.();
    c.once('exit', () => { clearTimeout(done); resolve(); });
    try { c.kill('SIGTERM'); } catch { clearTimeout(done); resolve(); }
  });
}

export const sidecarState = () => ({
  ...state,
  url: `http://${BIND === '0.0.0.0' ? '127.0.0.1' : BIND}:${PORT}`,
  uptimeMs: state.startedAt && state.running ? Date.now() - state.startedAt : 0,
});
