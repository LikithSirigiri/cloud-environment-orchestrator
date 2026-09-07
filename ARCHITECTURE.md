# Architecture

This document walks through how the system actually works, end to end, and why it's built the way it is. It's written for someone reviewing the code, not using it — every section points at real files.

## 1. System shape

One Node/Express process does three jobs at once: it's the REST + WebSocket API, the Terraform orchestrator, and (in production) the static file server for the built Angular SPA. There's no separate frontend server, no reverse proxy required, no message queue, and no external database server — deployment state lives in two embedded SQLite files. This is a deliberate simplicity choice: the whole system ships as one Docker container.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser — Angular 22 (standalone components)                        │
│  Login → Provider select (Azure/AWS) → Mode select (DR/New-Env)      │
│  → Form wizard → live Activity log                                   │
└───────────────────────────┬───────────────────────────┬─────────────┘
                             │ HTTPS (REST)               │ WebSocket
                             ▼                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  backend/server.js  —  Express 5 + Socket.IO                         │
│                                                                        │
│  ┌───────────────┐  ┌──────────────────┐  ┌─────────────────────┐   │
│  │ auth.js        │  │ deployments-db.js │  │ Terraform runner     │   │
│  │ authz.js        │  │ (SQLite: lifecycle)│  │ (child_process.spawn)│   │
│  │ fallback-auth.js│  │ db.js (SQLite: RBAC)│  │ per-job log stream   │   │
│  └───────────────┘  └──────────────────┘  └──────────┬──────────┘   │
│                                                          │              │
│  Hand-rolled Azure Shared-Key/SAS + AWS SigV4 signing    │              │
│  (blob container listing, SAS URL generation, SKU/instance-type lookup)│
└──────────────────────────────────────────────────────────┼──────────┘
                                                              │ writes tfvars.json,
                                                              │ spawns `terraform`
                                                              ▼
                        ┌─────────────────────────────────────────────┐
                        │  runs/<client>-<provider>/                    │
                        │  (per-client working copy of one root module) │
                        └───────────────────┬─────────────────────────┘
                                             ▼
              ┌──────────────┬──────────────┬───────────────┬──────────────┐
              │ dr-azure/    │ dr-aws/      │ new-env-azure/│ new-env-aws/ │
              └──────────────┴──────────────┴───────────────┴──────────────┘
                                             │
                                             ▼
                                  Azure / AWS resources
```

## 2. Request flow: what happens when you click "Deploy"

1. **Auth.** The user signs in via Microsoft Entra ID (MSAL auth-code flow, `backend/auth.js`) or, if Entra ID is unreachable, via a break-glass fallback login (`backend/fallback-auth.js`) — bcrypt-hashed password, rate-limited per IP, issuing a locally-signed JWT distinguishable from an Entra ID token by its `iss` claim. Every subsequent request carries a bearer token; `backend/authz.js`'s `requireAuth` verifies it either against Microsoft's cached JWKS (1-hour TTL, forced refetch on an unrecognized `kid` — handles key rotation correctly) or a local HMAC secret for fallback tokens.
2. **Provider + mode selection.** The UI has the user pick Azure or AWS, then DR-replication or "New Environment." Cloud credentials are typed into the form per-request (sent as `x-azure-credentials`/`x-aws-credentials` headers) and are **never persisted in plaintext**; New Environment deployments may optionally persist them AES-256-GCM-encrypted (key from `.env`) so a later `destroy` can reuse them without asking again.
3. **VM/instance sizing.** Dropdowns for VM size, disk type, and instance type are populated by the backend calling the cloud's own API live (not a hardcoded list), so the form always reflects what's actually available in the target region/subscription.
4. **Deploy request.** `POST /api/deploy` (DR) or `/api/deploy-new-env[-aws]` (New Environment) does three things: writes a per-client `terraform.tfvars.json` into an isolated working directory (`runs/<client>-<provider>/`, copied fresh from the relevant root module on first use), records a `provisioning` row in the deployments SQLite DB, and spawns `terraform init/plan/apply` as a **child process** — Terraform is the only thing that ever talks to the cloud APIs for actual provisioning.
5. **Live log streaming.** Terraform's stdout/stderr is piped into a per-job Socket.IO namespace (`io.of('/' + jobId)`). The complete raw log is always written to disk; what reaches the browser by default is filtered through a curated regex allowlist (resource create/destroy/modify lines, the "Still creating…" heartbeat, and Terraform's boxed error format) so the UI isn't drowned by cloud-init/provider noise across many VMs. A `stream_full_logs` toggle in the form bypasses the filter for a given job.
6. **Lifecycle tracking.** The deployment's status moves through a small state machine — `provisioning → running/planned/failed`, `destroying → destroyed` — persisted in SQLite. `ACTIVE_STATUSES` is what prevents two concurrent deploys against the same client's state.
7. **Destroy.** A separate endpoint runs `terraform destroy` against the same working directory, recreating it from the root module first if it was cleaned up locally in the meantime.

## 3. DR strategy: two clouds, two different answers

The interesting engineering decision in this project is that "Disaster Recovery" means something structurally different on each cloud, and the code reflects that rather than forcing a shared abstraction.

### AWS — clone-and-cutover (`infrastructure/dr-aws/main.tf`)

This is a genuine DC→DR replication pipeline, not a from-scratch build:

1. Discover the live DC (production) instances by tag / known IP.
2. Snapshot each one to an AMI **without rebooting it** (`snapshot_without_reboot = true`) — DR gets an exact image of DC's running state, not a fresh install.
3. Copy each AMI cross-region into the DR account/region.
4. Stand up a fresh DR VPC, subnets, NAT gateway, and security groups.
5. Launch DR instances from the copied AMIs.
6. Provision a fresh MongoDB tier for DR.
7. **Cut over**, in dependency order: rewrite IPs in nginx config → app `.env` files (with the DB IP *appended* alongside the old one, not replaced — this supports dual-write during the cutover window rather than a hard switch) → an app-specific encrypted secrets blob inside a container → Keycloak's docker-compose.
8. Restart MySQL, RabbitMQ, Redis, and Keycloak, each **polled until actually healthy** rather than just "container started."

The public web/proxy tier gets an Elastic IP that doubles as an SSH bastion for the private tier — nothing on the private subnets is reachable directly.

### Azure — rebuild-and-restore (`infrastructure/dr-azure/`)

Azure takes a lighter path: fresh VMs are provisioned directly into the DR region/subscription, and each VM's application data is restored from Azure Blob Storage rather than cloned from a running DC image. A `cloud-init` script (`cloud-init.tftpl`) blobfuse-mounts the relevant blob container, copies its contents onto the VM's real filesystem (blobfuse is a transport mechanism here, not something the app runs against directly — FUSE-backed mounts aren't suitable for Docker/DB workloads), and supports old-IP → new-private-IP remapping through the same template. Success is confirmed by a real status-file check (`/var/lib/cloud/dr_provision_status`) rather than trusting `cloud-init status --wait`, which can report overall success even when a specific step inside it failed.

### Both clouds: no automatic failover

Neither path includes health monitoring or automatic promotion — DR provisioning here is **operator-triggered**, kicked off deliberately from the dashboard. That's a scope boundary worth stating plainly rather than implying more automation than exists.

## 4. IaC design patterns

### Create-vs-existing

Every piece of shared network infrastructure — VNet/VPC, subnet, NAT gateway, resource group, public IP — follows the same shape across all four Terraform root modules: a `resource` and a `data` source for the same object, gated by complementary counts:

```hcl
resource "azurerm_virtual_network" "this" {
  count = var.create_vnet ? 1 : 0
  # ...
}

data "azurerm_virtual_network" "existing" {
  count = var.create_vnet ? 0 : 1
  name  = var.vnet_name
  # ...
}

locals {
  vnet_id = var.create_vnet ? azurerm_virtual_network.this[0].id : data.azurerm_virtual_network.existing[0].id
}
```

Anything pre-existing is always referenced through the `data` source path, so it can never accidentally be destroyed when a client's infra is torn down. New infrastructure that doesn't exist yet gets created fresh. This pattern is applied uniformly rather than special-cased per resource type — deliberately, since an inconsistent version of this pattern is exactly how "terraform destroy nukes a shared resource" incidents happen.

### Per-client, per-provider isolation, not per-environment

There's no "environment" concept beyond client name + provider. `getWorkDir(client, provider)` and `getStateKey(client, provider)` both derive purely from `slugify(client) + provider`, and that pair is the entire identity of a deployment: one working directory, one Terraform state key, one row in the lifecycle DB. Re-deploying under the same client name doesn't create a parallel environment — Terraform reconciles the existing state against whatever the form currently describes, which is a conscious tradeoff (simplicity over multi-version tracking) rather than an oversight.

### Two-stage apply for "New Environment"

Provisioning a brand-new client environment happens in two Terraform passes rather than one: Stage 1 applies with `-target` restricted to raw infrastructure (resource groups/VPC, subnets, NSGs/security groups, and five VMs — web, app, central, kong, db). Only after Stage 1 succeeds does Stage 2 run, which uses `remote-exec`/`file` provisioners to install and wire up the application layer: MySQL, Keycloak, RabbitMQ, Redis, and pulls the client's application build artifacts from Blob Storage via generated SAS URLs. Splitting these means a failure in application setup never leaves the infra layer in a half-applied state, and the two concerns can be retried independently.

## 5. Why no cloud SDKs

Most of the backend's auxiliary calls to Azure and AWS — listing blob containers to auto-match them to VM names, generating SAS URLs, looking up live VM SKUs / EC2 instance types — are implemented as **hand-rolled HTTP requests with manual request signing**: Azure Shared-Key/SAS signing and AWS Signature Version 4, both built from scratch rather than pulled in via `@azure/storage-blob` or the AWS SDK. This keeps the backend's dependency footprint small (8 runtime dependencies total) and was also, frankly, a chance to actually implement the signing algorithms instead of treating them as a black box behind an SDK call. Terraform itself still does all real provisioning through the official providers — this hand-rolled signing is only for the dashboard's own auxiliary reads.

## 6. Auth model

- **Primary**: Microsoft Entra ID (Azure AD), MSAL auth-code flow. The frontend fetches its own `clientId`/`tenantId`/`redirectUri` at runtime from `GET /api/auth/config` rather than baking them into the build — the same compiled bundle works against any tenant purely by changing the container's `.env`. `AZURE_AD_CLIENT_SECRET` never leaves the backend.
- **Fallback**: a bcrypt/JWT break-glass login (`/login/manual`) for when Entra ID itself is unreachable — separate rate limiting, separate JWT issuer, verified via a local HMAC secret rather than Microsoft's JWKS.
- **Authorization**: admin status is an `ADMIN_EMAILS` allowlist in `.env`, not a database role — deliberately, since admin bootstrap shouldn't depend on the DB already having the right row. Per-provider access (can this user deploy to Azure? AWS? both?) *is* DB-driven, managed through an admin panel.

## 7. Deployment lifecycle state machine

```
        POST /api/deploy
              │
              ▼
       ┌─────────────┐    terraform plan succeeds     ┌─────────┐
       │ provisioning │ ───────────────────────────▶  │ planned │
       └──────┬───────┘                                 └─────────┘
              │ terraform apply succeeds
              ▼
        ┌─────────┐        POST /api/destroy       ┌────────────┐
        │ running │ ──────────────────────────────▶ │ destroying │
        └─────────┘                                  └──────┬─────┘
              │ apply fails                                  │ succeeds
              ▼                                                ▼
          ┌────────┐                                    ┌───────────┐
          │ failed │                                    │ destroyed │
          └────────┘                                    └───────────┘
```

`ACTIVE_STATUSES = [provisioning, running, destroying]` is what blocks a second concurrent deploy against the same client+provider. The one non-obvious edge case worth calling out: a successful `plan` **must** explicitly transition to `planned` rather than staying in `provisioning` — if it didn't, nothing would ever move that deployment out of an active status, and every future plan/apply for that client would be permanently blocked by its own prior success.

## 8. Frontend structure

Angular 22 using standalone components (no `NgModule`s). Route tree: `/login`, `/login/manual`, `/auth/callback`, `/dashboard` (the provider → mode → form wizard, route-guarded), `/activity` (deployment history + live/replayed log viewer, guarded), `/admin` (user/access management, guarded + admin-only). App-wide form state lives in a single injectable `DrConfigService` (`providedIn: 'root'`) rather than being duplicated into each form component's local state — components proxy to it through getter/setter pairs so operations like pasting a JSON config or resizing a VM list stay consistent across the whole wizard without an explicit save step. State intentionally survives navigation between Dashboard and Activity (only a hard reload resets it), matching how an operator actually works through a multi-step form.

## 9. What's deliberately out of scope

- **No automated test suite** for the backend or the Terraform modules. Acknowledged rather than hidden — Terraform's own `validate`/`fmt` and manual `plan` review are the current safety net.
- **No linting configuration.**
- **Heavy use of `remote-exec`/`local-exec` provisioners** in the New Environment modules to install and configure the application stack on freshly-provisioned VMs — not idiomatic Terraform (HashiCorp itself recommends avoiding provisioners where possible), but a pragmatic choice given the multi-service bring-up sequencing this requires. A natural next step would be migrating this to cloud-init or a config-management tool.
- **No automated failover** — DR here means "provision the standby environment on demand," not "detect an outage and promote automatically."
