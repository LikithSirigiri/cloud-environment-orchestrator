const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'deployments.db'));

// 'infra_ready' sits between a New Environment's two apply stages — Stage 1
// (infra) landed here successfully but Stage 2 (app setup) hasn't run yet. It
// stays "active" so a duplicate Stage 1 can't be started and so it's exactly
// what getActiveDeployment finds when the UI offers "Setup Application".
const ACTIVE_STATUSES = ['provisioning', 'infra_ready', 'running', 'destroying'];

// Everything ACTIVE_STATUSES covers, plus 'failed' — a failed apply can still have
// left real Azure resources behind (whatever succeeded before the failing resource),
// so destroy needs to find it even though a fresh apply retry correctly ignores it
// (ACTIVE_STATUSES intentionally excludes 'failed' so it never blocks a retry).
const DESTROYABLE_STATUSES = [...ACTIVE_STATUSES, 'failed'];

db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    flow TEXT NOT NULL DEFAULT 'dr',
    stage TEXT NOT NULL DEFAULT 'infra',
    status TEXT NOT NULL,
    work_dir TEXT NOT NULL,
    state_key TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT,
    ready_at TEXT,
    destroy_requested_by TEXT,
    destroyed_at TEXT,
    last_job_id TEXT,
    last_error TEXT,
    credentials_encrypted TEXT,
    pre_destroy_status TEXT,
    env TEXT
  )
`);

// Adds columns to a deployments.db that predates them. Idempotent — SQLite has no
// "ADD COLUMN IF NOT EXISTS", so a rerun on an already-migrated DB just hits (and
// swallows) the duplicate-column error.
for (const ddl of [
  `ALTER TABLE deployments ADD COLUMN flow TEXT NOT NULL DEFAULT 'dr'`,
  `ALTER TABLE deployments ADD COLUMN credentials_encrypted TEXT`,
  `ALTER TABLE deployments ADD COLUMN stage TEXT NOT NULL DEFAULT 'infra'`,
  `ALTER TABLE deployments ADD COLUMN pre_destroy_status TEXT`,
  `ALTER TABLE deployments ADD COLUMN env TEXT`
]) {
  try {
    db.exec(ddl);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

function now() {
  return new Date().toISOString();
}

// credentialsEncrypted (optional): an encrypted blob of the Service Principal
// credentials used for this deploy, so a later destroy (or New Environment's
// Stage 2) can reuse the same credentials instead of requiring them to be
// retyped. Never stored in plaintext — see encryptCredentials()/
// decryptCredentials() in server.js. `stage` only matters for the New
// Environment flow's two-stage apply (deployments-db.js has no opinion on what
// the stages mean) — DR deployments just keep the 'infra' default, unused.
// env (optional): only meaningful for flow='new-env' — 'UAT'/'PROD'. A client can
// have one active New Environment deployment *per env* (separate infra/state each),
// so env is part of this deployment's identity everywhere below, alongside
// client_name/provider/flow. DR rows never set it.
function createDeployment({ clientName, provider, flow, stage, env, workDir, stateKey, createdBy, jobId, credentialsEncrypted }) {
  const info = db.prepare(`
    INSERT INTO deployments (client_name, provider, flow, stage, env, status, work_dir, state_key, created_by, created_at, last_job_id, credentials_encrypted)
    VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?)
  `).run(clientName, provider, flow || 'dr', stage || 'infra', env || null, workDir, stateKey, createdBy || '', now(), jobId || '', credentialsEncrypted || null);
  return getById(info.lastInsertRowid);
}

function getById(id) {
  return db.prepare('SELECT * FROM deployments WHERE id = ?').get(id);
}

// `flow` distinguishes a DR deployment from a New Environment deployment for the
// same client+provider, so a client can have one of each active at once without
// either blocking or overwriting the other. `env` (optional — New Environment only)
// further distinguishes UAT from PROD the same way: passing it scopes the lookup to
// that exact env; omitting it (every DR call site) leaves the old behavior untouched.
function getActiveDeployment(clientName, provider, flow, env) {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const envClause = env ? 'AND env = ?' : '';
  const params = [clientName, provider, flow || 'dr'];
  if (env) params.push(env);
  return db.prepare(`
    SELECT * FROM deployments
    WHERE client_name = ? AND provider = ? AND flow = ? ${envClause} AND status IN (${placeholders})
    ORDER BY id DESC LIMIT 1
  `).get(...params, ...ACTIVE_STATUSES);
}

// Same as getActiveDeployment but also matches 'failed' — used only by destroy,
// so a failed apply's leftover resources can still be torn down even though it
// doesn't block (and shouldn't block) a fresh apply retry.
//
// env has three distinct meanings here, not two — this matters because a client
// can have BOTH legacy (pre-env-scoping) rows with env=NULL and newer UAT/PROD
// rows at once, and "don't care" would silently grab whichever is most recent by
// id instead of the specific row the caller actually means:
//   - 'UAT' / 'PROD'  -> exact match
//   - null            -> exactly the legacy row(s), env IS NULL
//   - undefined       -> no filter at all (match any env) — only for callers that
//                        genuinely don't know/care which one
function getDestroyableDeployment(clientName, provider, flow, env) {
  const placeholders = DESTROYABLE_STATUSES.map(() => '?').join(',');
  const params = [clientName, provider, flow || 'dr'];
  let envClause = '';
  if (env === null) {
    envClause = 'AND env IS NULL';
  } else if (env) {
    envClause = 'AND env = ?';
    params.push(env);
  }
  return db.prepare(`
    SELECT * FROM deployments
    WHERE client_name = ? AND provider = ? AND flow = ? ${envClause} AND status IN (${placeholders})
    ORDER BY id DESC LIMIT 1
  `).get(...params, ...DESTROYABLE_STATUSES);
}

function markReady(id, jobId) {
  db.prepare(`UPDATE deployments SET status = 'running', ready_at = ?, last_job_id = ? WHERE id = ?`)
    .run(now(), jobId || '', id);
  return getById(id);
}

// New Environment Stage 1 (infra) succeeded — waiting for Stage 2 (app setup).
function markInfraReady(id, jobId) {
  db.prepare(`UPDATE deployments SET status = 'infra_ready', last_job_id = ? WHERE id = ?`)
    .run(jobId || '', id);
  return getById(id);
}

// New Environment Stage 2 (app setup) kickoff — transitions out of infra_ready.
function markAppStageStarted(id, jobId) {
  db.prepare(`UPDATE deployments SET status = 'provisioning', stage = 'app', last_job_id = ? WHERE id = ?`)
    .run(jobId || '', id);
  return getById(id);
}

function markFailed(id, error) {
  db.prepare(`UPDATE deployments SET status = 'failed', last_error = ? WHERE id = ?`)
    .run(error || '', id);
  return getById(id);
}

// A successful plan never creates real infrastructure, so it must not be left in
// (or land in) any of ACTIVE_STATUSES — otherwise it permanently blocks every future
// plan/apply for this client, since nothing else ever moves it out of that state.
function markPlanned(id) {
  db.prepare(`UPDATE deployments SET status = 'planned' WHERE id = ?`).run(id);
  return getById(id);
}

// Remembers the status it was in before destroy started (in `last_error`'s sibling
// column below) so a *failed* destroy can restore that exact status — 'running' for
// a DR/fully-provisioned deployment, but 'infra_ready' for a New Environment still
// sitting between its two stages. Getting this wrong would silently misrepresent an
// infra_ready deployment as fully running after a failed destroy attempt.
function markDestroying(id, destroyRequestedBy, jobId, priorStatus) {
  db.prepare(`UPDATE deployments SET status = 'destroying', destroy_requested_by = ?, last_job_id = ?, pre_destroy_status = ? WHERE id = ?`)
    .run(destroyRequestedBy || '', jobId || '', priorStatus || 'running', id);
  return getById(id);
}

function markDestroyed(id) {
  db.prepare(`UPDATE deployments SET status = 'destroyed', destroyed_at = ? WHERE id = ?`)
    .run(now(), id);
  return getById(id);
}

function markDestroyFailed(id, error) {
  // Destroy attempt failed — infra is still considered up, in whatever status it
  // was actually in before destroy started (see markDestroying).
  const row = getById(id);
  const priorStatus = row?.pre_destroy_status || 'running';
  db.prepare(`UPDATE deployments SET status = ?, last_error = ? WHERE id = ?`)
    .run(priorStatus, error || '', id);
  return getById(id);
}

function listDeployments() {
  return db.prepare('SELECT * FROM deployments ORDER BY id DESC').all();
}

// Removes a deployment's tracking row outright — distinct from destroy, which
// tears down real cloud resources. Only meant for rows that don't represent
// anything live (failed/destroyed): the caller (server.js) is responsible for
// enforcing that before calling this, since deleting the row for an
// active deployment would just orphan its real infra with no tracking left.
function deleteDeployment(id) {
  db.prepare('DELETE FROM deployments WHERE id = ?').run(id);
}

module.exports = {
  createDeployment,
  getById,
  getActiveDeployment,
  getDestroyableDeployment,
  markReady,
  markInfraReady,
  markAppStageStarted,
  markFailed,
  markPlanned,
  markDestroying,
  markDestroyed,
  markDestroyFailed,
  listDeployments,
  deleteDeployment
};
