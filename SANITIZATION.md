# What was changed from the original source

This folder is a curated, sanitized copy of a private production repository, prepared specifically for public portfolio use. This document lists, in full, what was removed or redacted and why — so anyone (including me, later) can audit exactly what differs from the real system.

## Excluded entirely

- **`azure-new-env-content/`** (the vendored application payload the "New Environment" Terraform flow copies onto provisioned VMs — a full client-facing application stack: Keycloak/MySQL/RabbitMQ/Redis, ~17 Node.js microservices, ~15 Angular frontends, nginx configs, and third-party SSL certs). This is the client's application, not the provisioning platform — none of it reflects the engineering in this repo, and it isn't this author's code to publish. The Terraform modules that reference it (`infrastructure/new-environment-{azure,aws}/modules/deploymentfiles/`) are included, since orchestrating that install *is* platform engineering, but they will not run standalone without that payload.
- `node_modules/` (both apps) and two ~85MB vendored `node_modules.zip` archives.
- Build output/cache: `frontend/dist/`, `frontend/.angular/`.
- Large pre-fetched data files not needed to understand the system: `frontend/disks_skus.json` (11MB), `frontend/parsed_disks.json` (4.3MB) — live Azure VM SKU/disk catalogs, fetched at runtime in the real system.
- Local runtime artifacts: `backend/logs/` (deployment logs — one pair of files in the original contained a real generated SSH private key), SQLite databases (`data.db`, `deployments.db`), `runs/` (per-client Terraform working directories), `data/` (docker-compose bind-mount volume).
- The real `.env` (only the placeholder `.env.example` is included).
- A handful of one-off, unused local dev/prototype scripts and files that had no bearing on the running application but embedded a colleague's local file path, the employer's full legal name, or a design-tool session's internal metadata: `frontend/revert.js`, `frontend/unpack.js`, `frontend/update_wordings*.js`, `frontend/fetch_logo.js`, `frontend/logos.txt`, `frontend/theme.py`. None of these are imported or referenced by the actual application.
- `frontend/CLAUDE.md` / `frontend/AGENTS.md` — leftover generic scaffolding from an unrelated project template, not specific to this codebase.
- `get_containers.ps1` — a superseded script, already dead code in the original repo per its own internal docs.

## Redacted (file kept, specific content replaced)

| File | What was there | Replaced with |
|---|---|---|
| `infrastructure/dr-aws/main.tf` | A hardcoded AES-256 decryption key (hex literal) used to decrypt a live customer's stored secrets during DR cutover | `process.env.SECRET_DECRYPT_KEY` with a `<REDACTED-FOR-PUBLIC-REPO>` fallback and an explanatory comment |
| `infrastructure/dr-azure/cloud-init.tftpl` | A base64-encoded Docker `config.json` containing a real private registry password and what appears to be a live Docker Hub personal access token | `<REDACTED-FOR-PUBLIC-REPO>` in both `auth` fields, with a comment. (If this system is still in use, that token and password should be rotated regardless of this showcase — they were sitting in plaintext-decodable base64 in source.) |
| `infrastructure/new-environment-{azure,aws}/modules/deploymentfiles/main.tf` | A hardcoded literal MySQL password for the `keycloak` DB user (inconsistent with every other password in the same block, which correctly used a Terraform variable) | `${var.mysqlpassword}`, matching the pattern used everywhere else in the same resource |
| Same two files | A real client's SSL certificate bundle filename (`terraform-test-admin.<real-domain>.zip`) | Generic `client-ssl-bundle.zip` |
| Same two files | Company-specific Linux usernames (`ezeedbuser`, and in the Azure file only, a hardcoded `ezeeadmin:ezeeadmin` chown target — the AWS file already parameterized this) | Generic `dbadmin`, `deployadmin` |
| `infrastructure/new-environment-{azure,aws}/modules/deploymentfiles/variables.tf` | Default Keycloak realm name matching the employer's brand | Generic `myorg` |
| `deploy/jenkins-pipeline-inline.groovy` | A live MS Teams incoming-webhook URL (with routing key), an internal GitLab hostname, an internal artifact-registry hostname | Jenkins credential reference, `gitlab.example.com`, `<your-registry>` |
| `deploy/Jenkinsfile` | Internal artifact-registry hostname and a registry-specific Jenkins credential ID | `<your-registry>`, generic credential ID |
| `frontend/src/index.html`, `login.component.html`, `header.component.html`, `public/login-standalone.html` | The employer's product name and full legal company name baked into UI copy, a real Azure AD tenant domain (`*.onmicrosoft.com`) used in a simulated login animation, and a hotlinked logo image hosted on the employer's Crunchbase profile | Generic placeholder product name ("Cloud Infrastructure Manager"), placeholder tenant domain, and the logo image now points at the repo's own generic favicon asset |
| `frontend/.env.example`, `frontend/angular.json` | Three real (free-tier, auto-expiring) personal ngrok tunnel hostnames used for local dev | Generic `your-tunnel*.ngrok-free.dev` placeholders |

## Structural changes (not security-related, just reorganized for a clean public layout)

The original repo's flat top-level layout (`azure-dr-api/`, `azure/`, `aws/`, `azure-new-env/`, `aws-new-env/`) was renamed/regrouped into `backend/`, `infrastructure/dr-azure/`, `infrastructure/dr-aws/`, `infrastructure/new-environment-azure/`, `infrastructure/new-environment-aws/` for readability. `deploy/Dockerfile`, `deploy/docker-compose.yml`, and `deploy/.dockerignore` were updated to reference the new paths; `backend/server.js`'s own path to the built frontend is a relative `../frontend/...` reference and needed no change.

## What was *not* touched

Application logic, Terraform resource definitions, comments explaining design decisions, the deployment lifecycle state machine, the auth flow, and every other line of actual engineering are unmodified from the original source. Business-domain naming that isn't a secret or a real company identifier (e.g. example database/service names like `lenddb`, `notification-api`) was deliberately left as-is rather than over-scrubbed, since it doesn't identify anyone and rewriting dozens of consistent cross-references would risk introducing bugs into a static showcase for no security benefit.
