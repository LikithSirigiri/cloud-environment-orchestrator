# Cloud Environment Orchestrator

A self-service platform that lets an operator stand up **brand-new (DC) environments** and **Disaster Recovery (DR) environments** on **Azure and AWS** from a browser — without hand-running Terraform or touching either cloud console. Built end-to-end: Angular frontend, Node/Express orchestration API, and four independent Terraform root modules, wired together with live deployment logs, an RBAC layer, and a deployment lifecycle state machine.

> This is a sanitized excerpt of a production system I designed and built. Real client names, credentials, internal hostnames, and one vendored application payload (the actual client app the platform deploys) have been removed or replaced with placeholders — see [SANITIZATION.md](SANITIZATION.md). Everything else — the orchestration engine, the auth model, and all Terraform — is unmodified.

**[Read the full architecture writeup →](ARCHITECTURE.md)**

---

## What it does

| Capability | Azure | AWS |
|---|---|---|
| **DR provisioning** — stand up a Disaster Recovery copy of a client's environment in a second region | ✅ Fresh VMs, app data restored from Blob Storage | ✅ Live AMI snapshot of running DC instances, cross-region copy, IP cutover |
| **New Environment** — provision a brand-new client environment from scratch, two-stage (infra → app) | ✅ | ✅ |
| Live deployment logs (streamed over WebSocket, filtered + full-firehose modes) | ✅ | ✅ |
| Destroy / teardown | ✅ | ✅ |
| Terraform state lock recovery, state inspection | ✅ | ✅ |
| Real-time VM size / instance type lookup from the cloud's own API | ✅ | ✅ |
| Per-provider RBAC, admin panel | ✅ | ✅ |
| SSO login (Microsoft Entra ID) + break-glass fallback admin login | ✅ | ✅ |

A single deploy is fully described by **client name + provider** — that pair is the entire identity of a Terraform state file, a working directory, and a row in the deployment-history database. No separate "environment" or "version" concept: re-running a deploy for the same client reconciles state against whatever the form currently says.

## Architecture at a glance

```
Browser (Angular 22, standalone components)
        │  HTTPS + WebSocket (Socket.IO)
        ▼
Node/Express API  ── one process, one port ──▶ serves the built Angular SPA too
        │
        ├─ Auth: Microsoft Entra ID (MSAL) + JWKS-verified JWT, break-glass fallback login
        ├─ SQLite: deployment lifecycle state machine + user/RBAC store
        ├─ Hand-rolled Azure Shared-Key/SAS + AWS SigV4 request signing (no cloud SDKs)
        └─ spawns `terraform` as a child process per deploy ──▶ streams stdout/stderr live
                        │
                        ▼
        4 independent Terraform root modules
        (Azure DR · AWS DR · Azure New-Env · AWS New-Env)
                        │
                        ▼
              Azure / AWS resources
```

Full request flow, the DR replication strategy for each cloud, and the reasoning behind each design decision are in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Tech stack

- **Frontend** — Angular 22 (standalone components, no NgModules), Angular CDK, Tailwind CSS, RxJS, Socket.IO client, Vitest
- **Backend** — Node.js 22, Express 5, Socket.IO, `better-sqlite3` (no external DB server), `@azure/msal-node`, hand-rolled JWT/JWKS verification
- **Infrastructure as Code** — Terraform ≥1.5, `hashicorp/azurerm`, `hashicorp/aws`, `hashicorp/tls`, `hashicorp/random`
- **Delivery** — multi-stage Docker build (Node 22-bookworm, `tini` as PID 1, non-root user), Jenkins declarative pipeline

## Repository layout

```
backend/            Express API: auth, Terraform orchestration, log streaming, SQLite state
frontend/           Angular 22 dashboard (login → provider/mode selection → form wizard → activity log)
infrastructure/
  dr-azure/           Terraform root module — Azure DR provisioning
  dr-aws/             Terraform root module — AWS DR provisioning (live DC→DR replication)
  new-environment-azure/   Terraform root module — fresh Azure client environment (2-stage apply)
  new-environment-aws/     Terraform root module — fresh AWS client environment (2-stage apply)
deploy/             Dockerfile, docker-compose.yml, Jenkins pipeline
.env.example        Full list of required configuration, no real values
```

## Highlights worth a closer look

- **[`infrastructure/dr-aws/main.tf`](infrastructure/dr-aws/main.tf)** — a genuine DC→DR replication pipeline: snapshots live production EC2 instances to AMIs, copies them cross-region, launches DR instances from those images, then does a dependency-ordered, health-gated IP cutover across nginx, app configs, and an encrypted secrets store.
- **[`backend/server.js`](backend/server.js)** — the orchestration core: per-client Terraform working-directory isolation, a deployment lifecycle state machine, and a curated log-filtering layer that still preserves the full raw log on disk.
- **The "create-vs-existing" Terraform pattern**, applied consistently across every module for VNets/VPCs, subnets, NAT gateways, and public IPs — see [ARCHITECTURE.md § IaC design patterns](ARCHITECTURE.md#iac-design-patterns).
- **Hand-rolled Azure Shared-Key/SAS and AWS SigV4 request signing** in the backend (no cloud SDKs used for auxiliary calls) — see [ARCHITECTURE.md § Why no cloud SDKs](ARCHITECTURE.md#why-no-cloud-sdks).

## Running it locally

```bash
npm run install:all   # installs backend/ and frontend/ deps
npm run build          # builds the Angular UI into backend-servable static files
cp .env.example .env   # fill in your own Azure AD app registration + storage account
npm start               # node backend/server.js — serves API + UI on :3000
```

Terraform itself is never run standalone against a real client in this workflow — the backend always generates the client-specific `tfvars` and picks the state key first. `terraform init/validate/fmt` from inside any `infrastructure/*` module works fine for sanity-checking changes.

## Known gaps (stated plainly)

- No automated test suite for the backend or Terraform modules yet.
- Heavy use of `remote-exec`/`local-exec` provisioners in the "New Environment" modules — a pragmatic tradeoff for orchestrating multi-VM app bring-up, not idiomatic Terraform, and a good target for future migration to cloud-init/config-management.
- No automatic failover — this is operator-triggered DR *provisioning*, not a monitored, self-healing failover system.

## License

MIT — see [LICENSE](LICENSE).
