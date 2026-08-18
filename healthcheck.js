// Container healthcheck. Both processes must answer: a live UI backed by a dead
// vendor sidecar would leave every router and AP panel blank while the container
// still reported healthy.
//
// Written in Node rather than as a shell one-liner because the Debian slim base
// ships neither wget nor curl, and node is guaranteed to be present.
import http from 'node:http';

const PORT = process.env.PORT || 3000;
const ROUTER_PORT = process.env.ROUTER_PORT || 5000;
const MODE = (process.env.ROUTER_SIDECAR || 'embedded').toLowerCase();

const ok = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, { timeout: 4000 }, (res) => {
    res.resume();
    // Any non-5xx means the process is up and routing. /login.html is served
    // before authentication, and /health needs no credentials.
    if (res.statusCode < 500) resolve();
    else reject(new Error(`${url} -> ${res.statusCode}`));
  });
  req.on('timeout', () => req.destroy(new Error(`${url} -> timeout`)));
  req.on('error', reject);
});

const checks = [ok(`http://127.0.0.1:${PORT}/login.html`)];
if (MODE === 'embedded') checks.push(ok(`http://127.0.0.1:${ROUTER_PORT}/health`));

Promise.all(checks).then(
  () => process.exit(0),
  (err) => { console.error(`unhealthy: ${err.message}`); process.exit(1); },
);
