# =============================================================================
#  Blackhole.Net — single container
#
#  Node serves the UI and API; the Python vendor drivers (TP-Link / Asus /
#  OpenWrt) run as a supervised child process on loopback inside this same
#  container (see sidecar.js). There is no second service to deploy.
#
#  Debian slim rather than Alpine on purpose: the Python dependency tree pulls
#  in cryptography and aiohttp, which ship prebuilt manylinux (glibc) wheels.
#  On musl those would have to be compiled from source, dragging in Rust and a
#  full build toolchain into the image for no benefit.
# =============================================================================
FROM node:22-bookworm-slim

WORKDIR /app

# --- Python runtime for the vendor drivers -----------------------------------
# A venv keeps pip out of the distro's site-packages (PEP 668) without needing
# --break-system-packages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv
ENV PYTHON_BIN=/opt/venv/bin/python

COPY router/requirements.txt ./router/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r router/requirements.txt

# --- Node dependencies (separate layer so source edits do not re-install) ----
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Application source ------------------------------------------------------
COPY server.js auth.js db.js sidecar.js automation.js healthcheck.js ./
COPY public ./public
COPY router/router_service.py ./router/router_service.py
COPY router/vendors ./router/vendors

# data/ holds blackhole.db and secret.key; it is bind-mounted in compose.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    ROUTER_SIDECAR=embedded \
    ROUTER_BIND=127.0.0.1 \
    ROUTER_PORT=5000

# Only the UI port is published. The sidecar stays on loopback.
EXPOSE 3000

# Checks BOTH processes: a live UI with a dead sidecar is not a healthy
# container, because every router and AP panel would be blank.
HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=3 \
  CMD ["node", "healthcheck.js"]

CMD ["node", "server.js"]
