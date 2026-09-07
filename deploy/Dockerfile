# Multi-stage build: compile the Angular UI in one stage, then produce a
# single runtime image that serves both the API and the built UI (server.js
# does the static-file serving itself -- see the comment block at the bottom
# of backend/server.js). One image, one process, one port.
#
# Note: this Dockerfile is written to build from the repo root, one level up
# from this deploy/ folder (`docker build -f deploy/Dockerfile .`).

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci
COPY frontend/ ./
# AZURE_AD_CLIENT_ID/TENANT_ID/REDIRECT_URI are fetched by the frontend at
# runtime from GET /api/auth/config (server.js), not baked into this build --
# so the same image works against any client_id/tenant/domain purely by
# changing the container's .env, no rebuild needed.
RUN npm run build

# bookworm-slim (Debian, glibc) rather than an alpine base -- better-sqlite3's
# native addon needs to match the image's libc, and prebuilt binaries for it
# target glibc, not musl. Mixing bases here caused a real crash-on-startup
# earlier when this was considered for Alpine.
FROM node:22-bookworm-slim AS runtime
ARG TERRAFORM_VERSION=1.9.8
# tini is PID 1 and does proper signal forwarding + zombie reaping -- needed
# because server.js spawns terraform (and terraform in turn spawns its own
# provider plugin subprocesses); without a real init, a `docker stop` can
# leave orphaned terraform processes and SIGTERM never reaches them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates tini \
    && curl -fsSL -o /tmp/terraform.zip \
       "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
    && unzip /tmp/terraform.zip -d /usr/local/bin \
    && rm /tmp/terraform.zip \
    && apt-get purge -y unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./backend/
# better-sqlite3 has no prebuilt binary for this Node/arch combo here, so npm
# falls back to compiling its native addon via node-gyp -- which needs
# Python + a C++ toolchain that bookworm-slim doesn't ship by default. Install
# them just for this step, then remove them so they don't bloat the final
# image (the compiled .node binary itself doesn't need them at runtime).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --prefix backend --omit=dev --no-audit --no-fund \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY backend/ ./backend/
COPY infrastructure/dr-azure/ ./infrastructure/dr-azure/
COPY infrastructure/dr-aws/ ./infrastructure/dr-aws/
# New Environment's own root modules (distinct from the DR roots above) plus
# the vendored app-setup payload (3rdparty/microservices/webconfig) both
# providers' deploymentfiles modules copy onto VMs/instances via config_repo_path
# -- omitted from this public showcase (see repo root SANITIZATION.md), so the
# New Environment flow isn't buildable from this Dockerfile as-is.
COPY infrastructure/new-environment-azure/ ./infrastructure/new-environment-azure/
COPY infrastructure/new-environment-aws/ ./infrastructure/new-environment-aws/
COPY --from=frontend-build /app/frontend/dist/azure-dr-ui/browser ./frontend/dist/azure-dr-ui/browser

# runs/ (per-client terraform workdirs), and the SQLite DBs + logs dir that
# docker-compose bind-mounts over, all need to be writable by the non-root
# user below -- created here so ownership is right from the first layer,
# not fixed up by a slower `chown -R` after COPY.
RUN mkdir -p /app/runs /app/backend/logs \
    && chown -R node:node /app/runs /app/backend

USER node
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/server.js"]
