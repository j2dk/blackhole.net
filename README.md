# Blackhole.Net

A self-hosted control centre for a whole home network — **Pi-hole**, the **gateway
router**, and every **Wi-Fi access point** — in one interface. A Node/Express
server fronts the Pi-hole v6 REST API (holding the credentials server-side and
sidestepping CORS), while a Python vendor sidecar speaks TP-Link's, Asus's and
OpenWrt's login protocols to the routers.

**It all runs in one container.** The sidecar is a supervised child process
listening on loopback inside the same image, so there is a single thing to build,
restart and monitor, and device credentials never cross a network to reach it.

Built and tested against **Pi-hole v6** (Core v6.4+ / FTL v6.7 / Web v6.6), a
**TP-Link GPON gateway**, and a pair of **TP-Link Archer** access points. Every
address in this document is a placeholder — set your own in the Admin panel.

A **futuristic HUD-style** interface (glassmorphism, neon accents, animated
counters, live gauges) with a full sidebar of management sections:

- **Overview** — animated stat tiles (total/blocked/rate/active clients), a
  24-hour activity chart, live **system gauges** (CPU, RAM, temperature), a
  query-type donut, upstream servers with response times, and top
  blocked/permitted domains and clients.
- **Network Map** — a live three-tier mesh of the whole LAN:
  `Internet → Router → Access Points → devices`. Each client is attributed to the
  **AP it is actually associated with** (and its band — 2.4 GHz vs 5 GHz, with
  signal strength in dBm where the AP reports it); wired clients hang off the
  router, solid when the router sees their MAC and dashed when they sit behind an
  unmanaged switch. Node size reflects DNS activity, active nodes pulse, hovering
  shows IP/MAC/vendor/path/signal/latency/connected-for, and clicking a device
  jumps to its queries. Latency uses two-phase TCP probing (discover the open
  port, then time a single socket) so numbers aren't inflated by concurrency.
  An AP status strip shows each access point's radios, client count, CPU and
  latency. The map is fully interactive: **scroll or pinch to zoom** (anchored at
  the cursor / finger midpoint), **drag the background to pan**, **drag any node
  to reposition it** — custom placements persist in `localStorage`, pin that node
  against the layout engine, and survive refreshes — plus toolbar buttons for
  zoom in/out, *Fit* (reset view), *Auto/Tiers* (layout mode) and *Reset layout*.
  Auto-refresh pauses while you're dragging or panning so the map never moves
  under your cursor.
- **Two layout modes** — **Auto** runs a Fruchterman–Reingold force simulation
  (damped repulsion with a distance cutoff, spring links, centering gravity and a
  light tier bias) that untangles the graph automatically; **Tiers** keeps the
  strict `Internet → Router → APs → devices` rows. Both run label-aware collision
  passes — each node's footprint includes the width of the text under it — so
  names never sit on top of each other, and the viewBox auto-fits the result.
- **Wi-Fi Health** — RSSI distribution across all wireless clients
  (excellent / good / fair / weak), a per-client table sorted worst-signal-first,
  and actionable advice: weak clients worth relocating, 2.4 GHz clients that could
  move to 5 GHz, uneven load between APs, and an explicit note for APs whose
  firmware doesn't report per-client RSSI (so they're excluded from the score
  rather than silently graded).
- **Roaming detection** — tracks which AP/band each client is associated with and
  records an event whenever it moves (`roam` between APs, `band-steer` between
  radios on one AP), with how long it held the previous association, a timeline of
  recent moves, and a "frequent hopper" warning for sticky clients or overlapping
  coverage. Reconciliation runs on its own timer over cached AP data, so it costs
  no extra router logins. History is in-memory and resets if the sidecar restarts.
- **Insights** — "who's doing what" per-client breakdown (queries, blocked, block
  %, unique domains, most-requested site), headline cards (busiest / most-blocked /
  widest-reach client), a **Security & Posture** checklist (blocking, DNSSEC, noisy
  clients, suspicious/DGA-like domains, Pi-hole diagnostics), recently-blocked
  domains, and a quick-reference of every manageable control.
- **Header blocking control** — enable/disable with a duration picker
  (10s → 15m → permanent) and a live pulsing status indicator + clock.
- **Query Log** — live-streaming DNS queries with **site favicons** for quick
  recognition, friendly client names, filtering, status/reply pills, and one-click
  **Allow/Deny** straight from any row.
- **Smart client names** — devices are labelled by their admin-defined DHCP static
  name, else the hostname the client shares over DHCP, else reverse-DNS — shown
  consistently across Clients, Insights, Query Log, and Top Clients.
- **Domains** — add/remove/enable/disable allow & deny entries (exact or regex)
  with comments.
- **Adlists** — add/remove/enable/disable block & allow lists, domain counts, and
  a **gravity update** button.
- **Groups** — full create / enable / delete.
- **Clients** — full create / delete plus **group assignment** via a modal.
- **Local DNS** — manage **A/AAAA host records** and **CNAME records**.
- **DHCP** — server status & range, **active leases**, and **static lease**
  management.
- **Gateway** — your router and internet in one place: live WAN/gateway health
  (latency, jitter, packet loss via TCP-connect probes), an animated
  `Devices → Pi-hole → Router → Internet` path, public IP / ISP / location lookup,
  and combined router-plus-Pi-hole health verdicts.
- **Deep router telemetry** (optional) — logs into the TP-Link gateway (via a
  small Python sidecar) for live **CPU/RAM**, WAN IP/gateway/MAC, Wi-Fi radio
  status, and the router's own device list. Router-known hostnames enrich device
  names across the app, and a cross-insight reconciles the router's view with
  Pi-hole's (e.g. "router sees 5, Pi-hole sees 16 — the rest are behind switches").
  Note: many ISP fibre gateways lock the `admin` account (use `user`) and don't
  expose per-device bandwidth at that access level.
- **Router load history** — the sidecar polls the gateway every ~20s in the
  background (independent of the UI) and keeps a rolling ~3-hour history, charted
  as live CPU + RAM lines in the Gateway section. Interval is tunable via
  `ROUTER_POLL_INTERVAL`.
- **Routers & APs** — one management surface for every piece of network hardware.
  A card per device (gateway + each AP) showing model, firmware, LAN MAC, live
  CPU/RAM gauges and client counts, with:
  - **Wi-Fi radio switches** — turn 2.4 GHz / 5 GHz on or off per device, behind a
    confirmation that spells out that connected clients will be dropped.
  - **Reboot** — per device, behind a confirmation that states the blast radius
    (whole-network outage for the gateway, AP-only for an access point).
  - A direct link to each device's own admin UI.
  - **WAN / uplink** as the gateway itself reports it — public WAN IP, ISP gateway,
    netmask, connection type (e.g. GPON), and the ISP's DNS servers — plus the
    gateway's DHCP lease table and whether its DHCP server is on (it should be off
    when Pi-hole serves DHCP).
- **Network** — gateway info and all discovered devices (MAC, vendor, IPs, query
  counts, last seen).
- **Diagnostics** — system metrics, FTL engine stats, dnsmasq cache/DHCP counters,
  and Pi-hole's own diagnosis messages.
- **Backup & Restore** — download a full **Teleporter** archive of your Pi-hole
  configuration as a `.zip`, and restore one back with a file upload.
- **Settings** — **upstream DNS** management, DNS option toggles (DNSSEC, query
  logging, bogus-priv, domain-needed), maintenance actions (**restart DNS**, flush
  query log, flush network table, update gravity), and version info.
- Auto-refreshes blocking status, the overview, and the live query stream.

## Supported hardware

## Automation

A typed automation engine runs inside the same process. Every automation is one
of seven code-defined kinds — there is deliberately no generic "run this action
with these parameters", because that is an arbitrary-request primitive.

| Kind | Effect | Role |
|---|---|---|
| **Scheduled Access Window** | Enables a Pi-hole group on a schedule — the bedtime/homework lockdown | admin |
| **Filter List Refresh** | Gravity update, skipped if one ran recently or the internet is down | contributor |
| **Configuration Backup** | Teleporter archive into `data/backups`, rotated | admin |
| **Filtering Watchdog** | Re-enables filtering left off with no timer | contributor |
| **Filtering Integrity** | Alerts when queries are high but the block rate collapses | reader |
| **New Device Alert** | Alerts the first time an unfamiliar MAC appears | reader |
| **Infrastructure Watch** | Alerts on sustained WAN loss or high gateway CPU/memory | reader |

Gateway reboots and Wi-Fi radio toggles are **deliberately not automatable** —
a reboot triggered by a failing WAN check is a self-sustaining loop. They remain
manual, confirmed actions.

**How it behaves.** A 30-second tick either *reconciles* (computes the desired
state from the wall clock and asserts it) or fires once on a local-minute key.
Nothing stores an absolute due time, so restarts, DST shifts and host clock jumps
are correct by construction: a backwards jump re-derives an already-fired key and
no-ops, a container pause yields one catch-up inside the grace window and a
recorded `skipped` row outside it. All wall-clock arithmetic uses `Intl` with an
explicit zone, not the container's `TZ`. Set the zone in **Automation → Engine
Settings** or via `TZ` in `.env`.

**Safety.** Automations are created **disarmed** and arming states the blast
radius first. The Access Window linter refuses the Default group, and the
executor refuses it again at fire time in case the group was renamed. A rule's
author role is re-resolved at every fire, so a demotion disarms the rule. Creating
a rule requires the role its *effect* requires, so a contributor cannot author an
admin-only action for the engine to run. Every decision — including every skip —
is journalled, and run history survives deleting the rule that made it.

**Three kill switches**, because the UI is unreachable exactly when DNS is:

1. **Emergency Stop** in the UI — disarms everything, switches the engine off and
   asserts filtering back on. Deliberately **contributor**-level: stopping
   something must never need more privilege than starting it.
2. **Engine Settings → Engine off** — stops scheduled work, keeps rule states.
3. **`touch ./data/automation.disable`** — works from the host shell with no UI
   and no working DNS. Checked at boot and on every tick.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl`/`⌘` + `K` | Command palette — jump to any section or run an action |
| `?` | Shortcut list |
| `G` then `O`/`A`/`D`/`Q`/`M`/`I`/`C`/`G`/`S` | Jump to a section |
| `Escape` | Close the palette or any dialog |

Blackhole.Net speaks to **three router ecosystems**. Pick the vendor per device
in **Admin**, and everything downstream — Network Map, Wi-Fi Health, roaming,
reboot and radio switches — works the same regardless of what's behind it.

| Vendor | How it connects | Model picker |
| --- | --- | --- |
| **TP-Link** | 27 model drivers (`tplinkrouterc6u`) | yes — auto-detect or pin |
| **Asus** (AsusWRT / Asuswrt-Merlin) | `asusrouter` — RT / ZenWiFi / TUF / ROG | not needed |
| **OpenWrt** | ubus JSON-RPC over HTTP | not needed |

**OpenWrt prerequisites** — the RPC endpoint must be exposed:

```sh
opkg update && opkg install uhttpd-mod-ubus rpcd
opkg install luci-mod-rpc      # optional: nicer client names + DHCP leases
```

Log in as `root` (or a user with ubus ACLs for `system`, `network*`, `iwinfo`,
`uci`, `luci-rpc`).

**Asus prerequisites** — the router's web UI must be reachable and the account
must be the admin one you use for the web UI. AiMesh nodes are reported through
the main router.

### TP-Link model drivers

TP-Link needs a per-model driver because each firmware family speaks a different
encrypted login. Leave it on **Auto-detect** and it probes for the right one; pin
a specific driver when detection can't resolve your device (some ISP-locked GPON
gateways) or to make connections faster. The **Test** button reports which vendor/driver
actually worked, so you can pin exactly that.

Add the gateway plus up to **8 access points / extenders / switches** from
**Admin → Access Points** — they can be a mix of vendors.

| Driver | Models |
| --- | --- |
| `TplinkRouter` | Archer (modern) — C6U, AX10/AX20/AX50/AX55, AX73… |
| `TplinkC1200Router` | Archer C1200 |
| `TplinkC3200Router` | Archer C3200 |
| `TPLinkC50Client` | Archer C50 / AC1200 (GDPR-encrypted) |
| `TplinkC5400XRouter` | Archer C5400X / AX11000 |
| `TplinkC80Router` | Archer C80 |
| `TPLinkVRClient` | Archer VR DSL series (VR600 / VR900 / VR2100…) |
| `TplinkVR1200vRouter` | Archer VR1200v |
| `TPLinkVR400v2Client` | Archer VR400 v2 / older DSL & Archer C5 v4 |
| `TplinkRouterSG` | Archer with SG_L1_S2 / CE_RED firmware (SHA256) |
| `TplinkRouterV1_11` | Archer, firmware 1.11+ (RSA-only login) |
| `TPLinkCPE210Client` | CPE210 outdoor CPE |
| `TPLinkDecoClient` | Deco mesh (M4 / M5 / X20 / X60…) |
| `TPLinkEAP115Client` | EAP115 access point |
| `TPLinkEXClient` | EX / XC GPON gateway (XC220-G3v, EX220, EX510…) |
| `TPLinkEXClientGCM` | EX / XC GPON gateway — AES-GCM firmware |
| `TplinkRE330Router` | RE330 range extender |
| `TPLinkMRClient` | TL-MR LTE series (MR600…) |
| `TPLinkMRClientGCM` | TL-MR LTE series — AES-GCM firmware |
| `TPLinkMR200Client` | TL-MR200 |
| `TPLinkMR600Client` | TL-MR600 |
| `TPLinkMR6400v7Client` | TL-MR6400 v7 |
| `TPLinkRClient` | TL-R router/VPN series |
| `TPLinkSG108EClient` | TL-SG108E managed switch |
| `TplinkWDRRouter` | TL-WDR series |
| `TPLinkWR841NClient` | TL-WR841N and GDPR RSA-512 routers |
| `TPLinkXDRClient` | XDR / 7DR series (TL-XDR, TL-7DR) |

Verified against real hardware: an **XC220-G3v** GPON gateway (`TPLinkEXClient`,
pinned — auto-detect does not resolve ISP-locked Aginet gateways), **Archer AX10**
(auto → `TplinkRouter`) and **Archer C5 v4** (auto → `TPLinkVR400v2Client`).

Other vendors are not supported yet; Pi-hole-only operation works fine — just
leave the router fields blank.

> **Testing status:** the TP-Link path is verified against real hardware. The
> Asus and OpenWrt adapters are verified by test suites (a mock ubus server for
> OpenWrt, and payload-level tests for the Asus normaliser) but have **not** been
> run against physical Asus/OpenWrt devices — expect to file off rough edges on
> first contact with real firmware.

## Users & access control

Blackhole.Net has its own sign-in with three roles. **Authorisation is enforced
server-side on every route** — hiding a button in the UI is presentation, the
API is the real gate.

| | reader | contributor | admin |
|---|:--:|:--:|:--:|
| View every section (all `GET`s) | ✅ | ✅ | ✅ |
| Enable/disable blocking, domains, adlists, groups, clients, local DNS, DHCP entries, gravity & flush | ❌ | ✅ | ✅ |
| DNS/upstream config (`/api/config`), DNSSEC, query logging | ❌ | ❌ | ✅ |
| Backup export & restore | ❌ | ❌ | ✅ |
| Reboot routers, toggle Wi-Fi radios | ❌ | ❌ | ✅ |
| Admin panel: users & device configuration | ❌ | ❌ | ✅ |

On first start an `admin` account is created and its generated password is
printed once to the container log:

```bash
docker compose logs blackhole | head -20
```

Sign in, then change it under **Admin → Your Password**. (Set `ADMIN_PASSWORD` in
`.env` beforehand to choose it yourself.)

## Multiple Pi-hole instances

Add as many as eight instances under **Admin → DNS Filtering**. The first entry is
the primary and is used by default.

- A **header selector** appears once more than one instance is configured, and
  switches which instance the Query Log, Domains, Filter Lists, Groups, Clients,
  Local DNS, DHCP and Settings sections act on. The choice persists per browser.
- The Overview gains a **DNS Instances** table showing per-instance status,
  blocking state, query and block counts, block rate, active clients and Core
  version, plus a **combined rollup** across every reachable instance.
- Each instance holds its own authenticated session, so one being unreachable
  never blocks the others — it is reported as offline and excluded from the
  rollup rather than failing the page.

## Storage — SQLite, no secrets in the environment

Everything persistent lives in **`data/blackhole.db`** (SQLite, via Node's
built-in `node:sqlite` — no native module to compile):

| Table | Holds |
| --- | --- |
| `users` | accounts + **one-way scrypt** password hashes |
| `devices` | Pi-hole / gateway / APs, with passwords **encrypted at rest** |
| `settings` | scalar preferences |

Device passwords have to be recoverable — the app needs the cleartext to log in
to those devices — so they are encrypted with **AES-256-GCM** rather than hashed.
The key lives in **`data/secret.key`** (mode `600`), deliberately *outside* the
database, so a stray copy of the `.db` on its own reveals nothing. User passwords
are never decryptable.

**`.env` and `docker-compose.yml` contain no secrets at all.** The vendor sidecar
holds none either: the app pushes device credentials to it over loopback inside
the container at boot and whenever they change, so nothing sensitive sits in a
container's environment or image. The sidecar's port is bound to `127.0.0.1` and
is never published. Everything is managed from the Admin panel.

`.env` is only read on a **completely fresh install** (empty database) so a first
boot can be unattended, and is ignored from then on. `data/` is gitignored.

Upgrading from an older build imports `data/users.json` and `data/config.json`
automatically on first start, encrypts the device secrets, and renames the old
files to `*.migrated` — delete those once you've confirmed things work, as they
still hold the pre-migration cleartext.

### Backing up

`data/blackhole.db` **and** `data/secret.key` — one is useless without the other.

Passwords are scrypt-hashed with a per-user salt. Sessions are opaque random
tokens held server-side and issued in an `HttpOnly; SameSite=Strict` cookie, so
page JavaScript can't read them and cross-site requests can't ride them. Sessions
live in memory, so restarting the container signs everyone out. The last
remaining admin cannot be deleted or demoted, which makes lock-out impossible.

Hardening details worth knowing:

- **Proxy paths are canonicalised before the role check.** The authorisation
  decision is made on the same normalised, per-segment-decoded path the upstream
  will receive, and anything that resolves outside `/api/` is rejected — so
  `PATCH /ph/./config`, `/ph/x/../config`, `/ph/%63onfig/…` and `/ph/../admin/`
  cannot be used to reach admin-only endpoints or escape the API root.
- **Roles fail closed.** An unrecognised role ranks zero and is refused
  everything, and role names are validated against an allowlist (a null-prototype
  map prevents `"constructor"`-style prototype lookups from ranking as valid).
- **Roles are resolved per request**, so demoting or deleting a user takes effect
  on their live session immediately rather than when it expires.
- **Sessions have an absolute lifetime** in addition to the idle slide, and are
  revoked on password change (everywhere except the session doing the changing),
  role change, and deletion.
- **Login throttling** counts against the real socket address (proxy headers are
  not trusted) and against the username, so neither a spoofed `X-Forwarded-For`
  nor a distributed guess evades the lockout. Both the found-user and
  unknown-user paths perform exactly one scrypt, so timing reveals nothing and
  the unknown-user branch isn't a CPU amplifier.

## Admin panel

**Admin** (admin only) is where the tool is configured — `.env` is only used to
*seed* the first run, after which `data/config.json` is the source of truth:

- **Users** — create accounts, change roles inline, reset passwords, delete.
- **Pi-hole** — URL, password, self-signed-TLS toggle.
- **Gateway router** — IP, label, username, password.
- **Access points** — add/remove up to 8, each with IP, label, username, password.
- **Test** buttons verify credentials against each real device *before* you save.
- Saving applies immediately and re-targets the router sidecar with no restart.

Secrets are never sent to the browser — the API reports only whether a password
is set, and a blank password field means "leave unchanged".

## Setup

Pick one of the two ways to run it.

### Option A — Docker (recommended for the homelab)

Requires Docker + Docker Compose. Put your password in a `.env` file next to
`docker-compose.yml` (the same file the Node app uses), then:

```bash
cd "Desktop/Homelab/Github/Pihole"
cp .env.example .env      # then edit .env and set PIHOLE_PASSWORD
docker compose up -d --build
```

Then open **http://localhost:3000**. Manage it with:

```bash
docker compose logs -f      # view logs
docker compose down         # stop and remove
docker compose up -d --build   # rebuild after changes
```

The container reaches your Pi-hole's LAN IP through the host's network, so no
special Docker networking is needed. It restarts automatically (`unless-stopped`)
and has a built-in healthcheck.

### Option B — Node directly

Requires **Node.js 18+**.

```bash
cd "Desktop/Homelab/Github/Pihole"
npm install
cp .env.example .env      # then edit .env
npm start
```

Then open **http://localhost:3000**.

## Configuration

Device addresses, credentials and accounts are configured **in the Admin panel**
and stored in SQLite — see *Storage* above. `.env` carries only non-secret
operational settings:

| Variable | Purpose |
| --- | --- |
| `PORT` | Port the UI listens on (default `3000`) |
| `SESSION_TTL_HOURS` | Web-UI session idle timeout (default `12`) |
| `ROUTER_POLL_INTERVAL` | Seconds between gateway telemetry samples (default `20`) |
| `AP_POLL_INTERVAL` | Seconds between AP samples (default `45`) |
| `ADMIN_PASSWORD` | **First boot only** — password for the auto-created `admin` account when the database is empty. Blank = generated and printed to the log. Ignored once the account exists. |

On a fresh install only, these are also read once to seed the database, after
which the Admin panel is authoritative: `PIHOLE_URL`, `PIHOLE_PASSWORD`,
`PIHOLE_INSECURE_TLS`, `GATEWAY_HOST`, `ROUTER_MODEL`, `ROUTER_USERNAME`,
`ROUTER_PASSWORD`, `ROUTER_DRIVER`, `ROUTER_VENDOR`, and `APn_HOST` /
`APn_LABEL` / `APn_USERNAME` / `APn_PASSWORD` / `APn_DRIVER` / `APn_VENDOR`.

## Performance & resources

- **gzip compression** on all responses; static assets sent with `no-cache` so a
  rebuilt UI is never served stale.
- **Parallel fetching** — every section loads its data with
  `Promise.all`/`allSettled` (one slow endpoint never blocks the others), plus
  in-flight request dedupe so concurrent callers share a single round-trip.
- **Timeouts everywhere** (20 s normal, 180 s for gravity/teleporter) so a hung
  Pi-hole returns `504` instead of pinning a browser connection.
- **Deduped authentication** — concurrent requests share one auth round-trip
  rather than stampeding Pi-hole's session table.
- **Debounced filters** so typing doesn't rebuild whole tables per keystroke.
- The router sidecar runs on **waitress** (multi-threaded WSGI), so a slow router
  login can't serialize the rest of the UI; stale samples are reported as stale
  rather than served as fresh.
- **No CPU or memory limits** are set on either container — they are free to use
  the full host hardware.

## Theming

Light and dark themes, toggled from the header (☀/☾) and remembered in
`localStorage`. First visit follows your OS `prefers-color-scheme`. Every surface
is driven by CSS custom properties, and the canvas charts read their colours from
those variables at draw time, so they repaint correctly when you switch. Light
mode is contrast-checked — all body, nav, and table-header text clears WCAG AA.

## Device icons

Each device gets an inline SVG icon inferred from its hostname first and its MAC
vendor second: phone, tablet, laptop, desktop, TV, camera, printer, server/NAS,
smart switch, bulb, wearable, speaker, energy device, router, access point.
Function keywords outrank brand names, so `OnePlus-TV-LAN` is a TV rather than a
OnePlus phone. Icons appear on the map, in the device table, and in the Wi-Fi
table, with a legend listing only the types actually present on your network.

## Accessibility

Focus-visible outlines throughout, keyboard-operable toggle switches (visually
hidden inputs rather than `display:none`), `aria-label`s on controls, a live
region for toasts, themed confirm dialogs instead of native `confirm()`, and full
`prefers-reduced-motion` support.

## How it works

```
Browser  ──►  /ph/<api-path>  ──►  Express proxy  ──►  http://192.168.1.10/api/<api-path>
                                     (adds X-FTL-SID session header, auto re-auths on 401)
```

The frontend is dependency-free vanilla JS/CSS served from `public/`. The only
runtime dependencies are `express` and `dotenv`.

## Security notes

- Keep `.env` out of version control (it's already in `.gitignore`).
- This app has no authentication of its own — run it only on a trusted LAN, or put
  it behind a reverse proxy / your own auth if exposing it more widely.
- **Favicons** in the Query Log are fetched from an external service
  (`icons.duckduckgo.com`) by your browser, which means queried domain names are
  sent to it. Turn them off any time with the **Icons** switch in the Query Log
  header; the app falls back to coloured letter tiles and stays fully functional.

## Project layout

```
Pihole/
├── server.js            # Express server: auth, session cache, API proxy
├── auth.js              # roles, sessions, password hashing, config accessors
├── db.js                # SQLite schema + AES-256-GCM secret encryption
├── public/
│   ├── index.html       # UI shell
│   ├── style.css        # Styling (auto light/dark)
│   └── app.js           # All frontend logic
├── Dockerfile           # App container image (blackhole-net)
├── docker-compose.yml   # Two services: blackhole + router sidecar
├── router/              # Vendor sidecar (holds no credentials)
│   ├── router_service.py
│   ├── vendors/         # asus.py, openwrt.py (+ TP-Link inline)
│   ├── requirements.txt
│   └── Dockerfile
├── data/                # gitignored: blackhole.db + secret.key
├── .dockerignore
├── .env.example
├── package.json
└── README.md
```
