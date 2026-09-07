const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { exchangeCodeForToken } = require('./auth');
const { isAdmin, requireAuth, requireAdmin } = require('./authz');
const { verifyFallbackLogin, isRateLimited, recordFailure, clearFailures } = require('./fallback-auth');
const db = require('./db');
const deploymentsDb = require('./deployments-db');

const app = express();
// All responses here are dynamic, per-user API data (auth, admin, deployments, terraform
// state) — never cache them. Without this, Express's default ETag generation makes the
// browser conditionally revalidate on the next request and get back a bare 304, which the
// UI has no useful way to render (there's no "nothing changed" state to fall back to).
app.set('etag', false);
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(cors());
app.use(express.json());

// Unauthenticated on purpose -- every other route requires a bearer token, but
// the container HEALTHCHECK/orchestrator has none, so it needs one liveness
// endpoint that doesn't depend on Azure AD being reachable.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// AWS and Azure resources live in separate root modules (separate .tf source and,
// per client below, separate working directories) — an Azure deploy must never see
// AWS-only resources/variables and vice versa.
const BASE_TF_DIR = path.join(__dirname, '..');
const RUNS_DIR = path.join(BASE_TF_DIR, 'runs');
const providerSourceDir = (provider) => path.join(BASE_TF_DIR, provider === 'aws' ? 'aws' : 'azure');

// New Environment provisioning lives in its own root module per provider,
// separate from the DR flow's azure/aws roots and (for Azure) its blob-mount
// cloud-init approach. Both providers share the same vendored app-setup content
// (3rdparty/microservices/webconfig) — that content isn't cloud-specific, only
// the infra underneath it differs.
const NEW_ENV_SOURCE_DIR = path.join(BASE_TF_DIR, 'azure-new-env');
const AWS_NEW_ENV_SOURCE_DIR = path.join(BASE_TF_DIR, 'aws-new-env');
const NEW_ENV_CONFIG_REPO_PATH = path.join(BASE_TF_DIR, 'azure-new-env-content');

function slugify(name) {
  return (
    (name || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'client'
  );
}

// `flow` distinguishes a DR deployment from a New Environment deployment for the
// same client+provider — 'dr' (default) or 'new-env'. Keeping them as separate
// work dirs/state keys means a client can have both active at once. `env`
// (New Environment only — 'UAT'/'PROD') further separates work dirs the same way,
// so a client can have a fully independent UAT and PROD deployment simultaneously.
function getWorkDir(clientName, provider, flow, env) {
  const envSuffix = flow === 'new-env' && env ? `-${env.toLowerCase()}` : '';
  const suffix = flow === 'new-env' ? `${provider}-newenv${envSuffix}` : provider;
  return path.join(RUNS_DIR, `${slugify(clientName)}-${suffix}`);
}

// New Environment deployments live in their own blob container (TF_STATE_CONTAINER_NEW_ENV)
// rather than a key prefix inside DR's container — see backendConfigArgs() — so the key
// shape itself doesn't need a flow segment; the container already keeps them apart. `env`
// (New Environment only) adds a segment so UAT and PROD get fully independent state.
function getStateKey(clientName, provider, env) {
  const envSegment = env ? `/${env.toLowerCase()}` : '';
  return `${slugify(clientName)}/${provider}${envSegment}/terraform.tfstate`;
}

// Copies the given provider's .tf/.tftpl source files into a per-client working
// directory so it's self-contained. Only that provider's files are copied — an
// Azure client's working directory never sees AWS's main.tf (or vice versa).
// New Environment's root module lives under modules/, so its files are copied
// recursively rather than the DR flow's flat .tf/.tftpl copy.
function ensureWorkDir(workDir, provider, flow) {
  fs.mkdirSync(workDir, { recursive: true });
  if (flow === 'new-env') {
    fs.cpSync(provider === 'aws' ? AWS_NEW_ENV_SOURCE_DIR : NEW_ENV_SOURCE_DIR, workDir, { recursive: true });
    return;
  }
  const sourceDir = providerSourceDir(provider);
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.tf') || f.endsWith('.tftpl'));
  for (const file of files) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(workDir, file));
  }
}

// Parses an Azure Storage "connection string" (as copied from the Access Keys blade,
// e.g. "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=...")
// into its parts. The azurerm Terraform backend doesn't accept a connection string directly —
// it wants the account name and key separately.
function parseStorageConnectionString(connectionString) {
  const parts = {};
  for (const segment of (connectionString || '').split(';')) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    parts[segment.slice(0, idx)] = segment.slice(idx + 1);
  }
  return { accountName: parts.AccountName || '', accountKey: parts.AccountKey || '' };
}

const { accountName: TF_STATE_ACCOUNT_NAME, accountKey: TF_STATE_ACCOUNT_KEY } =
  parseStorageConnectionString(process.env.TF_STATE_CONNECTION_STRING);

// New Environment deployments use their own blob container in the same storage
// account (TF_STATE_CONTAINER_NEW_ENV) instead of sharing DR's (TF_STATE_CONTAINER).
function backendConfigArgs(stateKey, flow) {
  const containerName = flow === 'new-env'
    ? (process.env.TF_STATE_CONTAINER_NEW_ENV || '')
    : (process.env.TF_STATE_CONTAINER || '');
  return [
    `-backend-config=storage_account_name=${TF_STATE_ACCOUNT_NAME}`,
    `-backend-config=container_name=${containerName}`,
    `-backend-config=key=${stateKey}`
  ];
}

function terraformEnv() {
  return { ...process.env, ARM_ACCESS_KEY: TF_STATE_ACCOUNT_KEY };
}

// Unauthenticated on purpose -- the frontend needs this before the user has
// any token, to build the Microsoft authorize URL itself. clientId/tenantId/
// redirectUri are public OAuth client-app identifiers (visible in that URL
// anyway), not secrets -- AZURE_AD_CLIENT_SECRET is never sent here.
app.get('/api/auth/config', (req, res) => {
  res.json({
    clientId: process.env.AZURE_AD_CLIENT_ID || '',
    tenantId: process.env.AZURE_AD_TENANT_ID || '',
    redirectUri: process.env.AZURE_AD_REDIRECT_URI || ''
  });
});

app.post('/api/auth/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success: false, error: 'Missing authorization code' });

  try {
    const result = await exchangeCodeForToken(code);
    const email = result.account?.username;
    const name = result.account?.name;
    const user = db.getOrCreateUser(email, name);

    res.json({
      success: true,
      idToken: result.idToken,
      name,
      username: email,
      isAdmin: isAdmin(email),
      access: { azure: !!user.azure_access, aws: !!user.aws_access }
    });
  } catch (error) {
    console.error('Microsoft AD token exchange failed:', error);
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
});

// Break-glass admin login, independent of Azure AD -- for when Entra ID is
// unreachable or misconfigured. Not linked anywhere in the UI. Guarded by its
// own bcrypt-hashed credential pair (FALLBACK_ADMIN_USERNAME/PASSWORD_HASH in
// .env, never committed) plus per-IP rate limiting, since the URL itself
// isn't a real security boundary once someone knows -- or guesses -- it.
app.post('/api/auth/fallback-login', async (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Too many attempts, try again later' });
  }

  const { username, password } = req.body || {};
  const token = await verifyFallbackLogin(username, password);
  if (!token) {
    recordFailure(ip);
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  clearFailures(ip);
  res.json({
    success: true,
    idToken: token,
    name: 'Fallback Admin',
    username,
    isAdmin: true,
    access: { azure: true, aws: true }
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  if (req.user.isFallbackAdmin) {
    return res.json({
      success: true,
      email: req.user.email,
      name: req.user.name,
      isAdmin: true,
      access: { azure: true, aws: true }
    });
  }

  const user = db.getOrCreateUser(req.user.email, req.user.name);
  res.json({
    success: true,
    email: user.email,
    name: user.name,
    isAdmin: isAdmin(user.email),
    access: { azure: !!user.azure_access, aws: !!user.aws_access }
  });
});

// Exchanges the Service Principal credentials the user typed into the Azure DR form for an
// ARM access token (client-credentials OAuth flow). The credentials never touch disk — they
// only live for the duration of this one token exchange.
async function getArmToken({ tenantId, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://management.azure.com/.default'
  });

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || 'Failed to authenticate with the provided Azure credentials');
  }
  return data.access_token;
}

// Shared by every route that needs the Azure Service Principal credentials typed
// into the UI's Azure Authentication card (sent as the x-azure-credentials header).
function parseAzureCredentials(req) {
  let credentials;
  try {
    credentials = JSON.parse(req.headers['x-azure-credentials'] || '{}');
  } catch {
    return { error: 'Invalid x-azure-credentials header' };
  }

  const { subscriptionId, tenantId, clientId, clientSecret } = credentials;
  if (!subscriptionId || !tenantId || !clientId || !clientSecret) {
    return { error: 'Missing Azure credentials (subscriptionId, tenantId, clientId, clientSecret)' };
  }
  return { credentials };
}

// AWS equivalent of parseAzureCredentials — reads the AWS Access Key/Secret/Region
// typed into the AWS New Environment form's own "AWS Authentication" card, sent as
// the x-aws-credentials header. Dedicated fields, never mixed with Azure's.
function parseAwsCredentials(req) {
  let credentials;
  try {
    credentials = JSON.parse(req.headers['x-aws-credentials'] || '{}');
  } catch {
    return { error: 'Invalid x-aws-credentials header' };
  }

  const { accessKeyId, secretAccessKey, region } = credentials;
  if (!accessKeyId || !secretAccessKey || !region) {
    return { error: 'Missing AWS credentials (accessKeyId, secretAccessKey, region)' };
  }
  return { credentials };
}

// New Environment deployments optionally store the Service Principal credentials
// used to create them (encrypted) so a later destroy can reuse the same
// credentials instead of requiring them to be retyped — see credentials_encrypted
// in deployments-db.js. AES-256-GCM with a random IV per encryption; the key comes
// from CREDENTIALS_ENCRYPTION_KEY in .env (64 hex chars = 32 bytes) and is never
// itself persisted anywhere. If that key isn't configured, credential storage is
// skipped (not a hard failure — deploys still work, destroy just falls back to
// requiring credentials typed in again, same as before this feature existed).
const CREDENTIALS_ENCRYPTION_ALGO = 'aes-256-gcm';

function getCredentialsEncryptionKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return Buffer.from(raw, 'hex');
}

function encryptCredentials(credentials) {
  const key = getCredentialsEncryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CREDENTIALS_ENCRYPTION_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptCredentials(encoded) {
  const key = getCredentialsEncryptionKey();
  if (!key || !encoded) return null;
  try {
    const data = Buffer.from(encoded, 'base64');
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = crypto.createDecipheriv(CREDENTIALS_ENCRYPTION_ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf-8'));
  } catch (err) {
    console.error('Failed to decrypt stored deployment credentials:', err.message);
    return null;
  }
}

// Fetches the storage account's own access key via the ARM control-plane API — the
// same permission Terraform itself already relies on (data.azurerm_storage_account's
// primary_access_key), so no extra RBAC beyond what deployments already need.
async function getStorageAccountKey(armToken, subscriptionId, resourceGroupName, storageAccountName) {
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/listKeys?api-version=2023-01-01`;
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${armToken}` }, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Failed to list storage account keys');
  return data.keys[0].value;
}

// Lists the real Blob containers in the storage account via the Blob service's own
// REST API, authenticated with Shared Key (the account key above) — no separate
// data-plane RBAC role needed, matching how blobfuse itself authenticates on the VMs.
async function listBlobContainers(storageAccountName, storageAccountKey) {
  const date = new Date().toUTCString();
  const version = '2021-08-06';
  const canonicalizedHeaders = `x-ms-date:${date}\nx-ms-version:${version}\n`;
  const canonicalizedResource = `/${storageAccountName}/\ncomp:list`;
  const stringToSign = ['GET', '', '', '', '', '', '', '', '', '', '', '', canonicalizedHeaders + canonicalizedResource].join('\n');
  const signature = crypto.createHmac('sha256', Buffer.from(storageAccountKey, 'base64')).update(stringToSign, 'utf-8').digest('base64');

  const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/?comp=list`, {
    headers: {
      'x-ms-date': date,
      'x-ms-version': version,
      Authorization: `SharedKey ${storageAccountName}:${signature}`
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Failed to list blob containers: ${response.status} ${await response.text()}`);

  const xml = await response.text();
  const names = [];
  const re = /<Container>\s*<Name>([^<]+)<\/Name>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[1].startsWith('$')) names.push(m[1]); // skip system containers like $logs
  }
  return names;
}

// Generates a read+list-only Service SAS for a single blob container, so the New
// Environment web VM can list/download build zips directly via plain `curl` (no
// installed CLI, no long-lived credential on the VM) instead of the Shared-Key auth
// used above — a SAS is scoped to one container and expires, unlike the account key.
// Signing follows the documented Blob Service SAS string-to-sign format for API
// version 2020-12-06 (stable since that version; newer fields are appended after,
// not reordered) — verified end-to-end against a real container before relying on it.
function generateContainerReadSas(storageAccountName, storageAccountKey, containerName, hours) {
  const version = '2020-12-06';
  const permissions = 'rl'; // read + list, nothing else
  const expiry = new Date(Date.now() + hours * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const canonicalizedResource = `/blob/${storageAccountName}/${containerName}`;

  const stringToSign = [
    permissions,
    '', // signedStart — omitted, valid from now
    expiry,
    canonicalizedResource,
    '', // signedIdentifier
    '', // signedIP
    'https',
    version,
    'c', // signedResource — container
    '', // signedSnapshotTime
    '', // signedEncryptionScope
    '', '', '', '', '' // rscc, rscd, rsce, rscl, rsct
  ].join('\n');

  const signature = crypto.createHmac('sha256', Buffer.from(storageAccountKey, 'base64')).update(stringToSign, 'utf-8').digest('base64');

  return new URLSearchParams({
    sv: version,
    sr: 'c',
    sp: permissions,
    se: expiry,
    spr: 'https',
    sig: signature
  }).toString();
}

// --- AWS SigV4 query-string ("presigned URL") request signing — hand-rolled per
// the exact documented AWS Signature Version 4 algorithm, same "no new SDK
// dependency" approach already used for the Azure SAS signing. Currently only
// used for EC2's DescribeInstanceTypeOfferings (see generateEc2QueryUrl below) —
// New Environment's AWS build-artifact fetching reuses the Azure Blob SAS helpers
// above instead of S3, since build files/state both live in the one shared Azure
// storage account regardless of which cloud a deployment's VMs are on. Kept
// generic (host/canonicalUri/service/extraQueryParams all caller-supplied) in
// case another AWS service needs signing later.
const EMPTY_PAYLOAD_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function awsSigV4Presign({ method, service, region, accessKeyId, secretAccessKey, host, canonicalUri, extraQueryParams, expiresSeconds, payloadHash }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const queryParams = {
    ...(extraQueryParams || {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host'
  };
  const canonicalQueryString = Object.keys(queryParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    `host:${host}\n`,
    'host',
    payloadHash || 'UNSIGNED-PAYLOAD'
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf-8').digest('hex')
  ].join('\n');

  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf-8').digest();
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

// EC2's "Query" API (not S3) — real GET requests with no body, so the payload hash
// must be the actual SHA-256 of an empty body ("UNSIGNED-PAYLOAD" is an S3-only
// shortcut, not part of the generic SigV4 spec other services honor).
function generateEc2QueryUrl(region, accessKeyId, secretAccessKey, actionParams) {
  return awsSigV4Presign({
    method: 'GET', service: 'ec2', region, accessKeyId, secretAccessKey,
    host: `ec2.${region}.amazonaws.com`,
    canonicalUri: '/',
    extraQueryParams: actionParams,
    expiresSeconds: 60,
    payloadHash: EMPTY_PAYLOAD_SHA256
  });
}

// Lists every EC2 instance type actually offered in a region (used to populate the
// AWS New Environment form's sizing dropdowns with the real, current list instead
// of a hand-maintained guess) — paginates via NextToken since a popular region can
// offer 700+ types. Lightweight regex XML parsing, same style already used for
// listBlobContainers above, rather than adding an XML-parsing dependency.
async function listEc2InstanceTypeOfferings(region, accessKeyId, secretAccessKey) {
  const types = new Set();
  let nextToken;
  for (let page = 0; page < 10; page++) {
    const params = {
      Action: 'DescribeInstanceTypeOfferings',
      Version: '2016-11-15',
      'LocationType': 'region',
      'Filter.1.Name': 'location',
      'Filter.1.Value': region,
      MaxResults: '1000'
    };
    if (nextToken) params.NextToken = nextToken;

    const url = generateEc2QueryUrl(region, accessKeyId, secretAccessKey, params);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const xml = await response.text();
    if (!response.ok) throw new Error(`Failed to list EC2 instance types: ${response.status} ${xml.slice(0, 500)}`);

    const typeRe = /<instanceType>([^<]+)<\/instanceType>/g;
    let m;
    while ((m = typeRe.exec(xml))) types.add(m[1]);

    const nextTokenMatch = /<nextToken>([^<]+)<\/nextToken>/.exec(xml);
    nextToken = nextTokenMatch ? nextTokenMatch[1] : null;
    if (!nextToken) break;
  }
  return [...types].sort();
}

const tokenize = (name) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// A VM and container are the same server when one name's tokens are a subset of the
// other's (order-independent) — covers containers that drop a token the VM has (e.g.
// vm "jfs-prod-app-dr" -> container "jfs-app-dr", dropping "prod") as well as the
// reverse (a container with an extra suffix token the VM name doesn't have). A real
// misspelling between the two names (different token) correctly produces no match
// instead of guessing — see JFS-PROD-SERVICICIBILITY-DR vs jfs-serviceability-dr.
function matchContainerName(vmName, containerNames) {
  const vmTokens = new Set(tokenize(vmName));
  const candidates = containerNames.filter(c => {
    const cTokens = tokenize(c);
    const cSet = new Set(cTokens);
    const cSubsetOfVm = cTokens.every(t => vmTokens.has(t));
    const vmSubsetOfC = [...vmTokens].every(t => cSet.has(t));
    return cSubsetOfVm || vmSubsetOfC;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

app.get('/api/azure/skus', requireAuth, async (req, res) => {
  const region = req.query.region;
  if (!region) return res.status(400).json({ success: false, error: 'Missing region' });

  const { credentials, error: credError } = parseAzureCredentials(req);
  if (credError) return res.status(400).json({ success: false, error: credError });
  const { subscriptionId, tenantId, clientId, clientSecret } = credentials;

  try {
    const armToken = await getArmToken({ tenantId, clientId, clientSecret });

    const skusUrl = new URL(`https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus`);
    skusUrl.searchParams.set('api-version', '2021-07-01');
    skusUrl.searchParams.set('$filter', `location eq '${region}'`);

    const skusResponse = await fetch(skusUrl, {
      headers: { Authorization: `Bearer ${armToken}` }
    });
    const skusData = await skusResponse.json();

    if (!skusResponse.ok) {
      return res.status(skusResponse.status).json({ success: false, error: skusData.error?.message || 'Failed to fetch SKUs from Azure' });
    }

    // Shape matches what the frontend (azure-vm.service.ts) already expects: { value: [...] }
    res.json(skusData);
  } catch (error) {
    console.error('Error fetching Azure SKUs:', error.message);
    res.status(502).json({ success: false, error: error.message });
  }
});

// AWS equivalent of /api/azure/skus above — real, current EC2 instance types for a
// region (used by the AWS New Environment form's per-role sizing dropdowns instead
// of a hand-maintained t3-only list).
app.get('/api/aws/instance-types', requireAuth, async (req, res) => {
  const region = req.query.region;
  if (!region) return res.status(400).json({ success: false, error: 'Missing region' });

  const { credentials, error: credError } = parseAwsCredentials(req);
  if (credError) return res.status(400).json({ success: false, error: credError });

  try {
    const instanceTypes = await listEc2InstanceTypeOfferings(region, credentials.accessKeyId, credentials.secretAccessKey);
    res.json({ success: true, instanceTypes });
  } catch (error) {
    console.error('Error fetching EC2 instance types:', error.message);
    res.status(502).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.listUsers().map(u => ({
    email: u.email,
    name: u.name,
    isAdmin: isAdmin(u.email),
    access: { azure: !!u.azure_access, aws: !!u.aws_access },
    createdAt: u.created_at
  }));
  res.json({ success: true, users });
});

app.post('/api/admin/users/:email/access', requireAuth, requireAdmin, (req, res) => {
  const { azure, aws } = req.body;
  const user = db.setAccess(req.params.email, { azure: !!azure, aws: !!aws });
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });

  res.json({
    success: true,
    email: user.email,
    name: user.name,
    isAdmin: isAdmin(user.email),
    access: { azure: !!user.azure_access, aws: !!user.aws_access }
  });
});

app.get('/api/deployments', requireAuth, (req, res) => {
  const deployments = deploymentsDb.listDeployments().map(d => {
    const readyAt = d.ready_at ? new Date(d.ready_at) : null;
    const destroyedAt = d.destroyed_at ? new Date(d.destroyed_at) : null;
    const durationSeconds = readyAt
      ? Math.max(0, Math.round(((destroyedAt || new Date()) - readyAt) / 1000))
      : null;

    return {
      id: d.id,
      clientName: d.client_name,
      provider: d.provider,
      flow: d.flow,
      env: d.env,
      status: d.status,
      createdBy: d.created_by,
      createdAt: d.created_at,
      readyAt: d.ready_at,
      destroyRequestedBy: d.destroy_requested_by,
      destroyedAt: d.destroyed_at,
      durationSeconds,
      lastError: d.last_error
    };
  });
  res.json({ success: true, deployments });
});

// Removes a deployment's tracking row from the list — NOT the same as Destroy,
// which runs terraform destroy against real cloud resources. Only allowed for
// 'failed' or 'destroyed' rows: deleting the row for anything still active would
// just orphan whatever real infra it points at with no tracking left to find it
// again, so that's refused rather than silently allowed.
app.delete('/api/deployments/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ success: false, error: 'Invalid deployment id' });
  }

  const deployment = deploymentsDb.getById(id);
  if (!deployment) {
    return res.status(404).json({ success: false, error: 'Deployment not found' });
  }
  if (!['failed', 'destroyed'].includes(deployment.status)) {
    return res.status(409).json({
      success: false,
      error: `Deployment is ${deployment.status}, not failed/destroyed — destroy it first if it's still active`
    });
  }

  deploymentsDb.deleteDeployment(id);
  res.json({ success: true });
});

app.get('/api/state', requireAuth, (req, res) => {
  const provider = req.query.provider || 'azure';
  const clientName = req.query.clientName;
  if (!clientName) return res.status(400).json({ success: false, error: 'Missing clientName' });

  const workDir = getWorkDir(clientName, provider);
  if (!fs.existsSync(workDir)) {
    return res.json({ success: true, resources: [] });
  }

  const tfShow = spawn('terraform', ['show', '-json'], { cwd: workDir, shell: true, env: terraformEnv() });
  let output = '';

  tfShow.stdout.on('data', data => {
    output += data.toString();
  });

  tfShow.on('close', code => {
    if (code === 0) {
      try {
        const state = JSON.parse(output);
        const resources = state?.values?.root_module?.resources || [];
        // Map to simpler format for UI
        const simpleResources = resources.map(r => ({
          name: r.name,
          type: r.type,
          address: r.address
        }));
        res.json({ success: true, resources: simpleResources });
      } catch (e) {
        res.json({ success: false, error: 'Failed to parse terraform state JSON' });
      }
    } else {
      res.json({ success: false, error: 'Failed to run terraform show' });
    }
  });
});

app.get('/api/download-pem/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  if (!filename.endsWith('.pem')) {
    return res.status(400).json({ error: 'Invalid file type' });
  }

  const provider = req.query.provider || 'azure';
  const clientName = req.query.clientName;
  if (!clientName) return res.status(400).json({ error: 'Missing clientName' });

  const workDir = getWorkDir(clientName, provider);
  const filePath = path.join(workDir, filename);

  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'File not found. Please ensure deployment is complete.' });
  }
});

app.post('/api/unlock', requireAuth, (req, res) => {
  const { lockId, provider, clientName } = req.body;
  if (!lockId) return res.status(400).json({ success: false, error: 'No lock ID provided' });
  if (!clientName) return res.status(400).json({ success: false, error: 'Missing clientName' });

  const workDir = getWorkDir(clientName, provider || 'azure');
  const tfUnlock = spawn('terraform', ['force-unlock', '-force', lockId], { cwd: workDir, shell: true, env: terraformEnv() });
  let output = '';

  tfUnlock.stdout.on('data', data => output += data.toString());
  tfUnlock.stderr.on('data', data => output += data.toString());

  tfUnlock.on('close', code => {
    if (code === 0) {
      res.json({ success: true, message: 'State unlocked successfully!' });
    } else {
      res.json({ success: false, error: output || 'Failed to unlock state' });
    }
  });
});

app.post('/api/deploy', requireAuth, async (req, res) => {
  try {
    const formData = req.body;

    // Extract action/provider/clientName/streamFullLogs, and remove them from tfvars data
    const action = formData.action || 'apply';
    const provider = formData.provider || 'azure';
    const clientName = formData.client_name;
    const streamFullLogs = !!formData.stream_full_logs;
    delete formData.action;
    delete formData.provider;
    delete formData.client_name;
    delete formData.stream_full_logs;

    if (!clientName) {
      return res.status(400).json({ success: false, error: 'Missing client_name' });
    }

    // The azurerm provider needs its own Service Principal credentials to actually
    // create/read/destroy resources — separate from ARM_ACCESS_KEY above, which only
    // authenticates access to the *state backend*, not the provider itself. Without
    // this, azurerm falls through to its default auth chain (env vars → Azure CLI →
    // managed identity), which has nothing configured here and fails outright.
    let azureArmEnv;
    if (provider === 'azure') {
      const { credentials, error: credError } = parseAzureCredentials(req);
      if (credError) return res.status(400).json({ success: false, error: credError });
      azureArmEnv = {
        ARM_SUBSCRIPTION_ID: credentials.subscriptionId,
        ARM_TENANT_ID: credentials.tenantId,
        ARM_CLIENT_ID: credentials.clientId,
        ARM_CLIENT_SECRET: credentials.clientSecret
      };
    }

    const existing = deploymentsDb.getActiveDeployment(clientName, provider);

    if (action === 'destroy') {
      if (!existing) {
        return res.status(404).json({ success: false, error: `No active deployment found for ${clientName} (${provider})` });
      }

      const workDir = existing.work_dir;
      if (!fs.existsSync(workDir)) {
        // Work dir was cleaned up locally — recreate it so terraform init can re-attach
        // to the same remote state key and run the destroy against it.
        ensureWorkDir(workDir, provider);
      }

      const jobId = 'deploy-' + Date.now();
      deploymentsDb.markDestroying(existing.id, req.user.email, jobId);
      startTerraformDeployment(jobId, 'destroy', workDir, existing.state_key, existing.id, azureArmEnv, streamFullLogs);
      return res.json({ success: true, jobId, message: `destroy started on ${provider}` });
    }

    if (existing) {
      return res.status(409).json({
        success: false,
        error: `A deployment for ${clientName} (${provider}) is already ${existing.status}`
      });
    }

    const workDir = getWorkDir(clientName, provider);
    const stateKey = getStateKey(clientName, provider);
    ensureWorkDir(workDir, provider);

    // Map UI fields to Terraform variables
    if (formData.vm_admin_username) formData.admin_username = formData.vm_admin_username;
    if (formData.vm_admin_password) formData.admin_password = formData.vm_admin_password;
    if (formData.disk_type) {
      if (formData.disk_type === "Premium SSD") formData.os_disk_type = "Premium_LRS";
      else if (formData.disk_type === "Standard SSD") formData.os_disk_type = "StandardSSD_LRS";
      else if (formData.disk_type === "Standard HDD") formData.os_disk_type = "Standard_LRS";
      else formData.os_disk_type = formData.disk_type;
    }

    // Parse disk sizes from strings like "64 GiB (P6)" to integers
    const parseDiskSize = (size) => {
      if (typeof size === 'number') return size;
      if (typeof size === 'string') {
        const parsed = parseInt(size, 10);
        return isNaN(parsed) ? 30 : parsed;
      }
      return 30;
    };

    // Provide defaults if still missing
    formData.default_disk_size = formData.default_disk_size ? parseDiskSize(formData.default_disk_size) : 30;
    if (formData.mongo_os_disk_size) formData.mongo_os_disk_size = parseDiskSize(formData.mongo_os_disk_size);
    if (!formData.default_blobfuse_mount_path) formData.default_blobfuse_mount_path = "/mnt/appdata";

    // Remove fields that Terraform doesn't expect to prevent warnings
    delete formData.vm_admin_username;
    delete formData.vm_admin_password;
    delete formData.disk_type;
    delete formData.vm_size;

    // An empty number input in the UI binds to null, not undefined — e.g. an
    // unset Mongo count. Writing that null explicitly into tfvars.json overrides
    // the variable's Terraform-side default (0) with an actual null, which fails
    // hard (count/size arguments require an integer). Dropping null keys here
    // lets Terraform's own defaults apply instead, same as never having sent them.
    for (const key of Object.keys(formData)) {
      if (formData[key] === null) delete formData[key];
    }

    // Resolve each VM to its real blob container by actually listing the storage
    // account, instead of leaving it to Terraform's own name-guessing fallback
    // (which has no visibility into what containers really exist and silently
    // produces a wrong, nonexistent name whenever the guess doesn't match).
    if (provider === 'azure' && formData.storage_account_name && formData.resource_group_name) {
      try {
        const { credentials } = parseAzureCredentials(req);
        const armToken = await getArmToken(credentials);
        const key = await getStorageAccountKey(armToken, credentials.subscriptionId, formData.resource_group_name, formData.storage_account_name);
        const containers = await listBlobContainers(formData.storage_account_name, key);

        formData.container_names = formData.container_names || {};
        for (const vmName of Object.keys(formData.vm_sizes || {})) {
          if (formData.container_names[vmName]) continue; // don't override a manual/existing entry
          const matched = matchContainerName(vmName, containers);
          if (matched) formData.container_names[vmName] = matched;
          else console.warn(`No unambiguous container match for VM "${vmName}" among [${containers.join(', ')}] — leaving unresolved`);
        }
      } catch (err) {
        console.error('Container name resolution failed, VMs will fall back to guessed names:', err.message);
      }
    }

    // A stray leading/trailing space typed or pasted into any name field (VNet,
    // subnet, resource group, etc.) makes Azure's exact-match lookups fail with a
    // confusing "was not found" error even though the resource genuinely exists —
    // trim every string value here so that class of bug can't reach Terraform.
    const trimStrings = (value) => {
      if (typeof value === 'string') return value.trim();
      if (Array.isArray(value)) return value.map(trimStrings);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimStrings(v)]));
      }
      return value;
    };
    const trimmedFormData = trimStrings(formData);

    // 1. Generate terraform.tfvars.json in this client's working directory
    const tfvarsFile = path.join(workDir, 'terraform.tfvars.json');
    fs.writeFileSync(tfvarsFile, JSON.stringify(trimmedFormData, null, 2), 'utf-8');

    // Generate a unique job ID
    const jobId = 'deploy-' + Date.now();

    const deployment = deploymentsDb.createDeployment({
      clientName,
      provider,
      workDir,
      stateKey,
      createdBy: req.user.email,
      jobId
    });

    // Trigger deployment process in the background
    startTerraformDeployment(jobId, action, workDir, stateKey, deployment.id, azureArmEnv, streamFullLogs);

    return res.json({ success: true, jobId, message: `${action} started on ${provider}` });
  } catch (error) {
    console.error('Error starting deployment:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Every web portal this client's nginx config actually routes (webconfig/nginx.conf),
// mapped to the key that names its version in an uploaded release manifest's
// "versions" object. The blob filename shortname is that key with "-ui" stripped —
// e.g. "document-hub-ui" -> blob prefix "document-hub", NOT the destination
// folder name ("dochub-portal") — those two are unrelated by design.
const KNOWN_PORTALS = {
  'access-portal': 'access-ui',
  'flow-portal': 'flow-designer-ui',
  'admin-portal': 'design-ui',
  'dochub-portal': 'document-hub-ui',
  'support': 'support-ui',
  'screen-portal': 'screen-ui',
  'field-portal': 'field-ui',
  'integration-portal': 'integration-ui',
  'docstudio-portal': 'document-studio-ui',
  'organization-portal': 'organization-ui',
  'lookup-portal': 'lookup-ui',
  'campaign-portal': 'campaign-ui',
  'dataset-portal': 'dataset-ui',
  'bre-portal': 'serviceability-ui',
  'user-portal': 'user-ui'
};

const trimStrings = (value) => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimStrings);
  return value;
};

// Provisions a brand-new client environment in two explicit stages against the same
// Terraform state, distinct from /api/deploy's DR flow: its own root module
// (azure-new-env/), its own work dir/state key (flow='new-env'), Azure-only, single
// environment per client (no DEV/UAT/PROD as an infra dimension).
//
// Stage 1 (formData.stage === 'infra'): RGs, VNet/subnets/NSG, storage, 5 VMs —
// `terraform apply -target=...` restricted to just those modules. Lands the
// deployment at status 'infra_ready' and persists terraform.tfvars.json with real
// infra values plus placeholders for every Stage-2-only variable (Terraform requires
// a value for every declared variable on any apply, even a targeted one that never
// references it).
//
// Stage 2 (formData.stage === 'app'): only runs once Stage 1 is 'infra_ready'. Reads
// that same tfvars.json, overwrites just the Stage-2 keys (domain, kong_domain, the
// build-container SAS, portal_zip_files) and runs a plain `terraform apply` — Terraform
// sees the infra unchanged and only creates the still-missing deploymentfilesmovement
// (app setup) resources.
app.post('/api/deploy-new-env', requireAuth, async (req, res) => {
  try {
    const formData = req.body || {};
    const action = formData.action === 'destroy' ? 'destroy' : 'apply';
    const stage = formData.stage === 'app' ? 'app' : 'infra';
    const provider = 'azure';
    const clientName = formData.client_name;
    const streamFullLogs = !!formData.stream_full_logs;

    if (!clientName) {
      return res.status(400).json({ success: false, error: 'Missing client_name' });
    }

    // New Environment state lives in its own blob container in the same storage
    // account (not just a different key inside DR's container) — needed for both
    // apply and destroy, since both run terraform init against that backend.
    if (!process.env.TF_STATE_CONTAINER_NEW_ENV) {
      return res.status(500).json({ success: false, error: 'Server is missing required config: TF_STATE_CONTAINER_NEW_ENV' });
    }

    if (action === 'destroy') {
      // env is optional here (unlike apply) specifically so deployments created
      // before env-scoping existed — stored with env=NULL — stay reachable. Three
      // distinct cases, not two: 'UAT'/'PROD' (exact match), explicit null (the
      // legacy env-less row specifically — what the Active Deployments list sends
      // for one), or the key omitted entirely (no filter — matches most-recently-
      // created regardless of env; only used as a last resort, since with both a
      // legacy row and a UAT/PROD row present this could grab the wrong one).
      // getDestroyableDeployment relies on this exact null-vs-undefined
      // distinction — don't coalesce it away here.
      if (formData.env && !['UAT', 'PROD'].includes(formData.env)) {
        return res.status(400).json({ success: false, error: 'Invalid env (must be UAT or PROD, or omitted/null for a legacy pre-env deployment)' });
      }

      // Broader than the apply-side lookup below — also matches 'failed', so a
      // failed apply's leftover resources (whatever succeeded before the resource
      // that actually failed) can still be torn down, even though 'failed' correctly
      // never blocks a fresh apply retry.
      const existing = deploymentsDb.getDestroyableDeployment(clientName, provider, 'new-env', formData.env);
      if (!existing) {
        const envLabel = formData.env ? ` (${formData.env})` : '';
        return res.status(404).json({ success: false, error: `No New Environment${envLabel} deployment found for ${clientName} to destroy` });
      }

      // Prefer the exact credentials that created this environment (stored encrypted
      // at Stage 1) so destroy always targets the right subscription/tenant even if
      // the Azure Authentication card currently holds different credentials. Falls
      // back to the header for deployments made before this existed, or if
      // CREDENTIALS_ENCRYPTION_KEY isn't configured.
      let credentials = decryptCredentials(existing.credentials_encrypted);
      if (!credentials) {
        const parsed = parseAzureCredentials(req);
        if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
        credentials = parsed.credentials;
      }
      const azureArmEnv = {
        ARM_SUBSCRIPTION_ID: credentials.subscriptionId,
        ARM_TENANT_ID: credentials.tenantId,
        ARM_CLIENT_ID: credentials.clientId,
        ARM_CLIENT_SECRET: credentials.clientSecret
      };

      const workDir = existing.work_dir;
      if (!fs.existsSync(workDir)) {
        ensureWorkDir(workDir, provider, 'new-env');
      }

      const jobId = 'deploy-' + Date.now();
      // A full destroy (no -target) is correct at either stage — Terraform only
      // tears down what's actually in state, whether that's just infra or infra+app.
      deploymentsDb.markDestroying(existing.id, req.user.email, jobId, existing.status);
      startTerraformDeployment(jobId, 'destroy', workDir, existing.state_key, existing.id, azureArmEnv, streamFullLogs, 'new-env');
      return res.json({ success: true, jobId, message: `destroy started on ${provider} (new environment)` });
    }

    // --- action === 'apply' ---

    // env ('UAT'/'PROD') is part of a New Environment deployment's identity, on par
    // with client_name — a client can have a fully independent UAT deployment and
    // PROD deployment (separate infra, separate state) at the same time. Required
    // up front (Stage 1 already needs it, to pick the work dir/state key), not just
    // at Stage 2 where it used to only matter for the build-container name.
    const env = formData.env;
    if (!env || !['UAT', 'PROD'].includes(env)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid env (must be UAT or PROD)' });
    }

    // Deliberately the narrower lookup (excludes 'failed') — a failed deployment
    // must not block a fresh Stage 1 retry, and stage 'app' below requires exactly
    // 'infra_ready' anyway so a 'failed' row wouldn't qualify there either.
    const existing = deploymentsDb.getActiveDeployment(clientName, provider, 'new-env', env);

    if (stage === 'infra') {
      if (existing) {
        return res.status(409).json({
          success: false,
          error: `A New Environment (${env}) deployment for ${clientName} is already ${existing.status}`
        });
      }

      const { credentials, error: credError } = parseAzureCredentials(req);
      if (credError) return res.status(400).json({ success: false, error: credError });
      const azureArmEnv = {
        ARM_SUBSCRIPTION_ID: credentials.subscriptionId,
        ARM_TENANT_ID: credentials.tenantId,
        ARM_CLIENT_ID: credentials.clientId,
        ARM_CLIENT_SECRET: credentials.clientSecret
      };

      const missingField = ['location', 'admin_username', 'admin_password'].find(key => !formData[key]);
      if (missingField) {
        return res.status(400).json({ success: false, error: `Missing ${missingField}` });
      }
      if (!Array.isArray(formData.ssh_allowed_ips) || !formData.ssh_allowed_ips.length) {
        return res.status(400).json({ success: false, error: 'Missing ssh_allowed_ips' });
      }
      if (!Array.isArray(formData.https_allowed_ips) || !formData.https_allowed_ips.length) {
        return res.status(400).json({ success: false, error: 'Missing https_allowed_ips' });
      }

      const workDir = getWorkDir(clientName, provider, 'new-env', env);
      const stateKey = getStateKey(clientName, provider, env);
      ensureWorkDir(workDir, provider, 'new-env');

      // Internal service credentials (MySQL/Mongo/Redis/RabbitMQ/Keycloak) — generated
      // here (Stage 1), never typed by hand, and returned once below so they can be
      // recorded. Stage 2 reuses these unchanged from tfvars.json rather than
      // regenerating them. Mirrors what this pipeline's Vault dependency used to
      // provide, without Vault.
      const genPassword = () => crypto.randomBytes(18).toString('base64url');
      const generatedSecrets = {
        mysqlpassword: genPassword(),
        mysqlRootPswrd: genPassword(),
        mongoadminpass: genPassword(),
        mongolendpassword: genPassword(),
        mongodatasetpassword: genPassword(),
        mongobrepassword: genPassword(),
        mongotemppassword: genPassword(),
        mongosnspassword: genPassword(),
        redispswrd: genPassword(),
        rabbitmqpswd: genPassword(),
        keycloak_admin_password: genPassword()
      };

      const tfvars = {
        client_name: trimStrings(clientName),
        location: trimStrings(formData.location),
        admin_username: trimStrings(formData.admin_username),
        admin_password: formData.admin_password,
        ssh_allowed_ips: trimStrings(formData.ssh_allowed_ips),
        https_allowed_ips: trimStrings(formData.https_allowed_ips),
        config_repo_path: NEW_ENV_CONFIG_REPO_PATH,
        ...generatedSecrets,
        // Stage-2-only values — every root variable needs *some* value even for a
        // -target'ed apply that never references it. Stage 2 overwrites these with
        // the real values by merging into this same file.
        domain: 'pending-stage-2',
        kong_domain: 'pending-stage-2',
        build_storage_account: TF_STATE_ACCOUNT_NAME,
        build_container_name: '',
        build_container_sas: '',
        portal_zip_files: {},
        registry_username: process.env.DOCKER_REGISTRY_USERNAME || '',
        docker_registry_address: process.env.DOCKER_REGISTRY_ADDRESS || '',
        docker_registry_password: process.env.DOCKER_REGISTRY_PASSWORD || ''
      };
      // Optional CIDR/RG-list overrides — the Terraform module has its own defaults
      // for these if the form leaves them blank.
      for (const key of ['vnet_address_space', 'app_subnet_prefixes', 'web_subnet_prefixes', 'db_subnet_prefixes', 'resource_groups']) {
        if (formData[key] !== undefined && formData[key] !== null) tfvars[key] = trimStrings(formData[key]);
      }

      fs.writeFileSync(path.join(workDir, 'terraform.tfvars.json'), JSON.stringify(tfvars, null, 2), 'utf-8');

      const jobId = 'deploy-' + Date.now();
      const deployment = deploymentsDb.createDeployment({
        clientName,
        provider,
        flow: 'new-env',
        stage: 'infra',
        env,
        workDir,
        stateKey,
        createdBy: req.user.email,
        jobId,
        credentialsEncrypted: encryptCredentials(credentials)
      });

      startTerraformDeployment(
        jobId, 'apply', workDir, stateKey, deployment.id, azureArmEnv, streamFullLogs, 'new-env',
        ['module.subnet', 'module.network', 'module.nsg', 'module.vms'], 'infra_ready'
      );

      // generatedSecrets is returned exactly once — it isn't stored anywhere server-side
      // beyond tfvars.json (not otherwise exposed via the API) — the caller is
      // responsible for recording it.
      return res.json({ success: true, jobId, message: 'Stage 1 (infrastructure) started', generatedSecrets });
    }

    // --- stage === 'app' ---

    if (!existing) {
      return res.status(404).json({ success: false, error: `No New Environment deployment found for ${clientName} — run Stage 1 (infrastructure) first` });
    }
    if (existing.status !== 'infra_ready') {
      return res.status(409).json({ success: false, error: `Deployment for ${clientName} is ${existing.status}, not ready for Stage 2` });
    }

    let credentials = decryptCredentials(existing.credentials_encrypted);
    if (!credentials) {
      const parsed = parseAzureCredentials(req);
      if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
      credentials = parsed.credentials;
    }
    const azureArmEnv = {
      ARM_SUBSCRIPTION_ID: credentials.subscriptionId,
      ARM_TENANT_ID: credentials.tenantId,
      ARM_CLIENT_ID: credentials.clientId,
      ARM_CLIENT_SECRET: credentials.clientSecret
    };

    const missingField = ['domain', 'kong_domain'].find(key => !formData[key]);
    if (missingField) {
      return res.status(400).json({ success: false, error: `Missing ${missingField}` });
    }
    // env was already validated above (shared with Stage 1) and, since `existing`
    // was looked up scoped to it, is guaranteed to match this specific deployment.

    const manifestVersions = formData.manifest_versions;
    if (!manifestVersions || typeof manifestVersions !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing manifest_versions — upload a release manifest JSON on the form' });
    }
    const missingManifestKeys = Object.values(KNOWN_PORTALS).filter(key => !manifestVersions[key]);
    if (missingManifestKeys.length) {
      return res.status(400).json({ success: false, error: `Release manifest is missing versions for: ${missingManifestKeys.join(', ')}` });
    }

    // The web VM pulls each portal's exact build zip (per the manifest above) from a
    // container named after this client+env, in the same storage account TF state
    // already lives in. That container must already exist (populated by the existing
    // build/release process) — fail clearly here rather than partway through a long apply.
    const buildContainerName = `${slugify(clientName)}-${env.toLowerCase()}`;
    try {
      const containers = await listBlobContainers(TF_STATE_ACCOUNT_NAME, TF_STATE_ACCOUNT_KEY);
      if (!containers.includes(buildContainerName)) {
        return res.status(400).json({
          success: false,
          error: `Container "${buildContainerName}" was not found in storage account "${TF_STATE_ACCOUNT_NAME}". Create it (with build zips already uploaded) before provisioning this client.`
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: `Failed to check build container: ${err.message}` });
    }

    // Resolve each portal's exact blob filename from the manifest, then confirm every
    // single one actually exists in the container before starting a long apply — a
    // typo'd version number should fail in a few seconds, not 20 minutes into a deploy.
    const portalZipFiles = {};
    for (const [destFolder, manifestKey] of Object.entries(KNOWN_PORTALS)) {
      const version = manifestVersions[manifestKey];
      const blobShortname = manifestKey.replace(/-ui$/, '');
      portalZipFiles[destFolder] = `${buildContainerName}-${blobShortname}-ui-${version}.zip`;
    }

    const buildContainerSasForCheck = generateContainerReadSas(TF_STATE_ACCOUNT_NAME, TF_STATE_ACCOUNT_KEY, buildContainerName, 1);
    const missingBlobs = [];
    try {
      await Promise.all(Object.entries(portalZipFiles).map(async ([destFolder, filename]) => {
        const url = `https://${TF_STATE_ACCOUNT_NAME}.blob.core.windows.net/${buildContainerName}/${encodeURIComponent(filename)}?${buildContainerSasForCheck}`;
        const headResp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
        if (headResp.status !== 200) missingBlobs.push(filename);
      }));
    } catch (err) {
      return res.status(500).json({ success: false, error: `Failed to verify build zips: ${err.message}` });
    }
    if (missingBlobs.length) {
      return res.status(400).json({
        success: false,
        error: `Build zip(s) not found in container "${buildContainerName}": ${missingBlobs.join(', ')}`
      });
    }

    // Docker registry is fixed, shared infra config (one real instance), not a
    // per-deploy form field — same treatment this app already gives
    // TF_STATE_CONNECTION_STRING/AZURE_AD_CLIENT_SECRET.
    const requiredEnvKeys = ['DOCKER_REGISTRY_ADDRESS', 'DOCKER_REGISTRY_USERNAME', 'DOCKER_REGISTRY_PASSWORD'];
    const missingEnvKeys = requiredEnvKeys.filter(key => !process.env[key]);
    if (missingEnvKeys.length) {
      return res.status(500).json({ success: false, error: `Server is missing required config: ${missingEnvKeys.join(', ')}` });
    }

    // Read+list-only SAS for the build container, valid for the run — the web VM
    // fetches portal build zips directly via curl+SAS, no long-lived credential or
    // installed client library needed on the VM.
    const buildContainerSas = generateContainerReadSas(TF_STATE_ACCOUNT_NAME, TF_STATE_ACCOUNT_KEY, buildContainerName, 6);

    // Merge into Stage 1's existing tfvars.json rather than writing a fresh one —
    // preserves client_name/location/admin creds/CIDRs/generated secrets untouched,
    // which matters: changing them here would make Terraform see a diff against the
    // already-created infra and try to modify/recreate it.
    const tfvarsFile = path.join(existing.work_dir, 'terraform.tfvars.json');
    let tfvars;
    try {
      tfvars = JSON.parse(fs.readFileSync(tfvarsFile, 'utf-8'));
    } catch (err) {
      return res.status(500).json({ success: false, error: `Could not read Stage 1's terraform.tfvars.json (work dir may have been cleaned up) — Stage 1 needs to be redone: ${err.message}` });
    }
    Object.assign(tfvars, {
      domain: trimStrings(formData.domain),
      kong_domain: trimStrings(formData.kong_domain),
      build_storage_account: TF_STATE_ACCOUNT_NAME,
      build_container_name: buildContainerName,
      build_container_sas: buildContainerSas,
      portal_zip_files: portalZipFiles,
      registry_username: process.env.DOCKER_REGISTRY_USERNAME,
      docker_registry_address: process.env.DOCKER_REGISTRY_ADDRESS,
      docker_registry_password: process.env.DOCKER_REGISTRY_PASSWORD
    });
    fs.writeFileSync(tfvarsFile, JSON.stringify(tfvars, null, 2), 'utf-8');

    const jobId = 'deploy-' + Date.now();
    deploymentsDb.markAppStageStarted(existing.id, jobId);

    startTerraformDeployment(
      jobId, 'apply', existing.work_dir, existing.state_key, existing.id, azureArmEnv, streamFullLogs, 'new-env',
      [], 'running'
    );

    return res.json({ success: true, jobId, message: 'Stage 2 (application setup) started' });
  } catch (error) {
    console.error('Error starting new environment deployment:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Feeds the "Edit" flow on the AWS New Environment form — loads an active
// deployment's current Stage 1 config back into the form so it can be resubmitted
// with `edit: true` (see the stage === 'infra' / isEdit branch below). Deliberately
// returns only the fields that flow is allowed to change, plus key_pair_mode/
// existing_key_pair_name for read-only display — never the generated secrets, the
// Mongo replica-set keyfile, portal URLs, or the docker registry password.
app.get('/api/deploy-new-env-aws/config', requireAuth, (req, res) => {
  const clientName = req.query.clientName;
  const env = req.query.env;
  if (!clientName) return res.status(400).json({ success: false, error: 'Missing clientName' });
  if (!env || !['UAT', 'PROD'].includes(env)) {
    return res.status(400).json({ success: false, error: 'Missing or invalid env (must be UAT or PROD)' });
  }

  const existing = deploymentsDb.getActiveDeployment(clientName, 'aws', 'new-env', env);
  if (!existing) {
    return res.status(404).json({ success: false, error: `No active New Environment (${env}) deployment found for ${clientName}` });
  }

  const tfvarsFile = path.join(existing.work_dir, 'terraform.tfvars.json');
  let tfvars;
  try {
    tfvars = JSON.parse(fs.readFileSync(tfvarsFile, 'utf-8'));
  } catch (err) {
    return res.status(500).json({ success: false, error: `Could not read this deployment's terraform.tfvars.json (work dir may have been cleaned up): ${err.message}` });
  }

  const EDITABLE_KEYS = [
    'ssh_username', 'ssh_allowed_ips', 'https_allowed_ips',
    'web_instance_type', 'app_instance_type', 'central_instance_type', 'kong_instance_type', 'db_instance_type',
    'include_kong', 'db_count',
    'create_vpc', 'existing_vpc_id', 'create_subnets', 'existing_web_subnet_id', 'existing_app_subnet_id', 'existing_db_subnet_id',
    'vpc_cidr', 'app_subnet_prefixes', 'web_subnet_prefixes', 'db_subnet_prefixes',
    'custom_tags'
  ];
  const READONLY_DISPLAY_KEYS = ['key_pair_mode', 'existing_key_pair_name'];
  const config = {};
  for (const key of [...EDITABLE_KEYS, ...READONLY_DISPLAY_KEYS]) {
    if (tfvars[key] !== undefined) config[key] = tfvars[key];
  }

  res.json({ success: true, config });
});

// AWS equivalent of /api/deploy-new-env above — same two-stage apply / destroy
// shape and the same deploymentsDb functions (already provider-generic), but a
// fully separate route so the Azure route above is never touched. Terraform side
// lives in aws-new-env/ (see that module's own comments for the AWS-specific
// pieces: VPC/SG/EC2 instead of VNet/NSG/VM, S3 presigned URLs instead of Blob
// SAS, and the generate-vs-existing EC2 key pair choice).
app.post('/api/deploy-new-env-aws', requireAuth, async (req, res) => {
  try {
    const formData = req.body || {};
    const action = formData.action === 'destroy' ? 'destroy' : 'apply';
    const stage = formData.stage === 'app' ? 'app' : 'infra';
    const provider = 'aws';
    const clientName = formData.client_name;
    const streamFullLogs = !!formData.stream_full_logs;

    if (!clientName) {
      return res.status(400).json({ success: false, error: 'Missing client_name' });
    }
    if (!process.env.TF_STATE_CONTAINER_NEW_ENV) {
      return res.status(500).json({ success: false, error: 'Server is missing required config: TF_STATE_CONTAINER_NEW_ENV' });
    }
    // Build artifacts live in the same Azure Storage account TF state does
    // (TF_STATE_CONNECTION_STRING) — no separate AWS-side config needed.

    if (action === 'destroy') {
      // Same three-way env semantics as the Azure route — see getDestroyableDeployment.
      if (formData.env && !['UAT', 'PROD'].includes(formData.env)) {
        return res.status(400).json({ success: false, error: 'Invalid env (must be UAT or PROD, or omitted/null for a legacy pre-env deployment)' });
      }

      const existing = deploymentsDb.getDestroyableDeployment(clientName, provider, 'new-env', formData.env);
      if (!existing) {
        const envLabel = formData.env ? ` (${formData.env})` : '';
        return res.status(404).json({ success: false, error: `No New Environment${envLabel} deployment found for ${clientName} to destroy` });
      }

      let credentials = decryptCredentials(existing.credentials_encrypted);
      if (!credentials) {
        const parsed = parseAwsCredentials(req);
        if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
        credentials = parsed.credentials;
      }
      const awsEnv = {
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        AWS_DEFAULT_REGION: credentials.region
      };

      const workDir = existing.work_dir;
      if (!fs.existsSync(workDir)) {
        ensureWorkDir(workDir, provider, 'new-env');
      }

      const jobId = 'deploy-' + Date.now();
      deploymentsDb.markDestroying(existing.id, req.user.email, jobId, existing.status);
      startTerraformDeployment(jobId, 'destroy', workDir, existing.state_key, existing.id, awsEnv, streamFullLogs, 'new-env');
      return res.json({ success: true, jobId, message: `destroy started on ${provider} (new environment)` });
    }

    // --- action === 'apply' ---

    const env = formData.env;
    if (!env || !['UAT', 'PROD'].includes(env)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid env (must be UAT or PROD)' });
    }

    const existing = deploymentsDb.getActiveDeployment(clientName, provider, 'new-env', env);

    if (stage === 'infra') {
      // Editing an already-provisioned deployment's infra (sizing/Kong/DB count/
      // networking) is the mirror image of creating one: it *requires* `existing`
      // instead of forbidding it, reuses its credentials/work dir/state key/row
      // instead of creating new ones, and never touches key_pair_mode (changing
      // key_name would force-replace every EC2 instance — too destructive for a
      // casual edit, so that field simply isn't part of the edit payload at all).
      const isEdit = formData.edit === true;

      if (isEdit) {
        if (!existing) {
          return res.status(404).json({ success: false, error: `No active New Environment (${env}) deployment found for ${clientName} to edit` });
        }
      } else if (existing) {
        return res.status(409).json({
          success: false,
          error: `A New Environment (${env}) deployment for ${clientName} is already ${existing.status}`
        });
      }

      let credentials;
      if (isEdit) {
        credentials = decryptCredentials(existing.credentials_encrypted);
      }
      if (!credentials) {
        const parsed = parseAwsCredentials(req);
        if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
        credentials = parsed.credentials;
      }
      const awsEnv = {
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        AWS_DEFAULT_REGION: credentials.region
      };

      if (!isEdit) {
        const missingField = ['ssh_username', 'key_pair_mode'].find(key => !formData[key]);
        if (missingField) {
          return res.status(400).json({ success: false, error: `Missing ${missingField}` });
        }
        if (!['generate', 'existing'].includes(formData.key_pair_mode)) {
          return res.status(400).json({ success: false, error: 'Invalid key_pair_mode (must be "generate" or "existing")' });
        }
        if (formData.key_pair_mode === 'existing' && !formData.existing_key_pair_name) {
          return res.status(400).json({ success: false, error: 'Missing existing_key_pair_name (key_pair_mode is "existing")' });
        }
      } else if (!formData.ssh_username) {
        return res.status(400).json({ success: false, error: 'Missing ssh_username' });
      }
      const missingSizingField = ['web_instance_type', 'app_instance_type', 'central_instance_type'].find(key => !formData[key]);
      if (missingSizingField) {
        return res.status(400).json({ success: false, error: `Missing ${missingSizingField}` });
      }
      const includeKong = formData.include_kong !== false; // absent/true both default to including Kong
      if (includeKong && !formData.kong_instance_type) {
        return res.status(400).json({ success: false, error: 'Missing kong_instance_type (or set include_kong to false)' });
      }
      const dbCount = parseInt(formData.db_count, 10);
      if (![1, 3].includes(dbCount)) {
        return res.status(400).json({ success: false, error: 'db_count must be 1 or 3' });
      }
      if (!formData.db_instance_type) {
        return res.status(400).json({ success: false, error: 'Missing db_instance_type' });
      }
      const createVpc = formData.create_vpc !== false; // absent/true both default to creating a new VPC
      if (!createVpc && !formData.existing_vpc_id) {
        return res.status(400).json({ success: false, error: 'Missing existing_vpc_id (create_vpc is false)' });
      }
      const createSubnets = formData.create_subnets !== false; // absent/true both default to creating new subnets
      if (!createSubnets) {
        const missingSubnetId = ['existing_web_subnet_id', 'existing_app_subnet_id', 'existing_db_subnet_id'].find(key => !formData[key]);
        if (missingSubnetId) {
          return res.status(400).json({ success: false, error: `Missing ${missingSubnetId} (create_subnets is false)` });
        }
      }
      if (!Array.isArray(formData.ssh_allowed_ips) || !formData.ssh_allowed_ips.length) {
        return res.status(400).json({ success: false, error: 'Missing ssh_allowed_ips' });
      }
      if (!Array.isArray(formData.https_allowed_ips) || !formData.https_allowed_ips.length) {
        return res.status(400).json({ success: false, error: 'Missing https_allowed_ips' });
      }

      // Custom tags, applied to every resource this module creates (see
      // aws-new-env's custom_tags var) — optional, {} if the user adds none.
      const customTags = {};
      if (formData.custom_tags && typeof formData.custom_tags === 'object') {
        for (const [rawKey, rawValue] of Object.entries(formData.custom_tags)) {
          const key = String(rawKey).trim();
          const value = String(rawValue ?? '').trim();
          if (!key) continue;
          if (/^aws:/i.test(key)) {
            return res.status(400).json({ success: false, error: `Tag key "${key}" is reserved by AWS (the "aws:" prefix can't be used)` });
          }
          if (key.length > 128) {
            return res.status(400).json({ success: false, error: `Tag key "${key}" is longer than AWS's 128-character limit` });
          }
          if (value.length > 256) {
            return res.status(400).json({ success: false, error: `Tag value for "${key}" is longer than AWS's 256-character limit` });
          }
          customTags[key] = value;
        }
        if (Object.keys(customTags).length > 50) {
          return res.status(400).json({ success: false, error: 'AWS allows at most 50 tags per resource' });
        }
      }

      if (isEdit) {
        // Merge just the editable fields into the existing tfvars.json — everything
        // else (client_name/env/key_pair_mode/region/generated secrets/Stage-2
        // values) is left exactly as Stage 1 originally wrote it, same
        // merge-not-replace approach Stage 2 already uses for its own fields below.
        const tfvarsFile = path.join(existing.work_dir, 'terraform.tfvars.json');
        let tfvars;
        try {
          tfvars = JSON.parse(fs.readFileSync(tfvarsFile, 'utf-8'));
        } catch (err) {
          return res.status(500).json({ success: false, error: `Could not read this deployment's terraform.tfvars.json (work dir may have been cleaned up): ${err.message}` });
        }
        Object.assign(tfvars, {
          ssh_username: trimStrings(formData.ssh_username),
          ssh_allowed_ips: trimStrings(formData.ssh_allowed_ips),
          https_allowed_ips: trimStrings(formData.https_allowed_ips),
          web_instance_type: trimStrings(formData.web_instance_type),
          app_instance_type: trimStrings(formData.app_instance_type),
          central_instance_type: trimStrings(formData.central_instance_type),
          kong_instance_type: trimStrings(formData.kong_instance_type || 't3.small'),
          db_instance_type: trimStrings(formData.db_instance_type),
          include_kong: includeKong,
          db_count: dbCount,
          create_vpc: createVpc,
          existing_vpc_id: trimStrings(formData.existing_vpc_id || ''),
          create_subnets: createSubnets,
          existing_web_subnet_id: trimStrings(formData.existing_web_subnet_id || ''),
          existing_app_subnet_id: trimStrings(formData.existing_app_subnet_id || ''),
          existing_db_subnet_id: trimStrings(formData.existing_db_subnet_id || ''),
          custom_tags: customTags
        });
        for (const key of ['vpc_cidr', 'app_subnet_prefixes', 'web_subnet_prefixes', 'db_subnet_prefixes']) {
          if (formData[key] !== undefined && formData[key] !== null) tfvars[key] = trimStrings(formData[key]);
        }
        fs.writeFileSync(tfvarsFile, JSON.stringify(tfvars, null, 2), 'utf-8');

        const jobId = 'deploy-' + Date.now();
        // Never downgrades an already-fully-provisioned deployment back to
        // infra_ready — an edit only touches module.network/security/ec2, Stage 2's
        // work (module.deploymentfilesmovement) is never re-targeted or re-run.
        const onSuccessStatus = existing.status === 'running' ? 'running' : 'infra_ready';
        startTerraformDeployment(
          jobId, 'apply', existing.work_dir, existing.state_key, existing.id, awsEnv, streamFullLogs, 'new-env',
          ['module.network', 'module.security', 'module.ec2'], onSuccessStatus
        );
        return res.json({ success: true, jobId, message: 'Infrastructure update started' });
      }

      const workDir = getWorkDir(clientName, provider, 'new-env', env);
      const stateKey = getStateKey(clientName, provider, env);
      ensureWorkDir(workDir, provider, 'new-env');

      // Same one-time-generated, never-typed-by-hand treatment as the Azure route.
      const genPassword = () => crypto.randomBytes(18).toString('base64url');
      const generatedSecrets = {
        mysqlpassword: genPassword(),
        mysqlRootPswrd: genPassword(),
        mongoadminpass: genPassword(),
        mongolendpassword: genPassword(),
        mongodatasetpassword: genPassword(),
        mongobrepassword: genPassword(),
        mongotemppassword: genPassword(),
        mongosnspassword: genPassword(),
        redispswrd: genPassword(),
        rabbitmqpswd: genPassword(),
        keycloak_admin_password: genPassword()
      };

      const tfvars = {
        region: trimStrings(credentials.region),
        client_name: trimStrings(clientName),
        ssh_username: trimStrings(formData.ssh_username),
        key_pair_mode: formData.key_pair_mode,
        existing_key_pair_name: trimStrings(formData.existing_key_pair_name || ''),
        ssh_allowed_ips: trimStrings(formData.ssh_allowed_ips),
        https_allowed_ips: trimStrings(formData.https_allowed_ips),
        config_repo_path: NEW_ENV_CONFIG_REPO_PATH,
        // Per-role topology — confirmed AWS-only, Azure's New Environment keeps its
        // fixed sizing. db_count > 1 makes aws-new-env set up a real PSS MongoDB
        // replica set instead of a standalone instance (see that module's comments).
        web_instance_type: trimStrings(formData.web_instance_type),
        app_instance_type: trimStrings(formData.app_instance_type),
        central_instance_type: trimStrings(formData.central_instance_type),
        kong_instance_type: trimStrings(formData.kong_instance_type || 't3.small'),
        db_instance_type: trimStrings(formData.db_instance_type),
        include_kong: includeKong,
        db_count: dbCount,
        // Create-vs-existing VPC/subnets — see aws-new-env/modules/network.
        create_vpc: createVpc,
        existing_vpc_id: trimStrings(formData.existing_vpc_id || ''),
        create_subnets: createSubnets,
        existing_web_subnet_id: trimStrings(formData.existing_web_subnet_id || ''),
        existing_app_subnet_id: trimStrings(formData.existing_app_subnet_id || ''),
        existing_db_subnet_id: trimStrings(formData.existing_db_subnet_id || ''),
        custom_tags: customTags,
        ...generatedSecrets,
        // Stage-2-only values — every root variable needs *some* value even for a
        // -target'ed apply that never references it, same reasoning as the Azure route.
        domain: 'pending-stage-2',
        kong_domain: 'pending-stage-2',
        build_storage_account: TF_STATE_ACCOUNT_NAME,
        build_container_name: '',
        portal_zip_files: {},
        portal_zip_urls: {},
        microservice_tags: {},
        registry_username: process.env.DOCKER_REGISTRY_USERNAME || '',
        docker_registry_address: process.env.DOCKER_REGISTRY_ADDRESS || '',
        docker_registry_password: process.env.DOCKER_REGISTRY_PASSWORD || ''
      };
      for (const key of ['vpc_cidr', 'app_subnet_prefixes', 'web_subnet_prefixes', 'db_subnet_prefixes']) {
        if (formData[key] !== undefined && formData[key] !== null) tfvars[key] = trimStrings(formData[key]);
      }

      fs.writeFileSync(path.join(workDir, 'terraform.tfvars.json'), JSON.stringify(tfvars, null, 2), 'utf-8');

      const jobId = 'deploy-' + Date.now();
      const deployment = deploymentsDb.createDeployment({
        clientName,
        provider,
        flow: 'new-env',
        stage: 'infra',
        env,
        workDir,
        stateKey,
        createdBy: req.user.email,
        jobId,
        credentialsEncrypted: encryptCredentials(credentials)
      });

      // Only "generate" produces a new private key worth surfacing — "existing"
      // references a key pair the user already holds the private half of.
      const onApplySuccess = formData.key_pair_mode === 'generate'
        ? (applyWorkDir) => {
            const pem = execFileSync('terraform', ['output', '-raw', 'ssh_private_key_pem'], {
              cwd: applyWorkDir, shell: true, env: { ...terraformEnv(), ...awsEnv }, encoding: 'utf-8'
            });
            const logsDir = path.join(__dirname, 'logs');
            fs.mkdirSync(logsDir, { recursive: true });
            fs.writeFileSync(path.join(logsDir, `${jobId}.secrets.json`), JSON.stringify({ ssh_private_key_pem: pem }), 'utf-8');
          }
        : undefined;

      startTerraformDeployment(
        jobId, 'apply', workDir, stateKey, deployment.id, awsEnv, streamFullLogs, 'new-env',
        ['module.network', 'module.security', 'module.ec2'], 'infra_ready', onApplySuccess
      );

      return res.json({ success: true, jobId, message: 'Stage 1 (infrastructure) started', generatedSecrets });
    }

    // --- stage === 'app' ---

    if (!existing) {
      return res.status(404).json({ success: false, error: `No New Environment deployment found for ${clientName} — run Stage 1 (infrastructure) first` });
    }
    if (existing.status !== 'infra_ready') {
      return res.status(409).json({ success: false, error: `Deployment for ${clientName} is ${existing.status}, not ready for Stage 2` });
    }

    let credentials = decryptCredentials(existing.credentials_encrypted);
    if (!credentials) {
      const parsed = parseAwsCredentials(req);
      if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
      credentials = parsed.credentials;
    }
    const awsEnv = {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_DEFAULT_REGION: credentials.region
    };

    const missingField = ['domain', 'kong_domain'].find(key => !formData[key]);
    if (missingField) {
      return res.status(400).json({ success: false, error: `Missing ${missingField}` });
    }

    const manifestVersions = formData.manifest_versions;
    if (!manifestVersions || typeof manifestVersions !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing manifest_versions — upload a release manifest JSON on the form' });
    }
    const missingManifestKeys = Object.values(KNOWN_PORTALS).filter(key => !manifestVersions[key]);
    if (missingManifestKeys.length) {
      return res.status(400).json({ success: false, error: `Release manifest is missing versions for: ${missingManifestKeys.join(', ')}` });
    }

    // Build artifacts live in the same Azure Storage account Terraform state
    // already lives in — not a separate AWS S3 bucket — so an AWS web instance and
    // an Azure web instance for the same client+env pull from the exact same
    // container. Identical mechanism to the Azure route just above (same
    // listBlobContainers/generateContainerReadSas helpers, same naming convention);
    // only the destination (an EC2 instance instead of an Azure VM) differs, and
    // that's opaque to this logic — it just produces full URLs for `curl`.
    const buildContainerName = `${slugify(clientName)}-${env.toLowerCase()}`;
    try {
      const containers = await listBlobContainers(TF_STATE_ACCOUNT_NAME, TF_STATE_ACCOUNT_KEY);
      if (!containers.includes(buildContainerName)) {
        return res.status(400).json({
          success: false,
          error: `Container "${buildContainerName}" was not found in storage account "${TF_STATE_ACCOUNT_NAME}". Create it (with build zips already uploaded) before provisioning this client.`
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: `Failed to check build container: ${err.message}` });
    }

    const portalZipFiles = {};
    for (const [destFolder, manifestKey] of Object.entries(KNOWN_PORTALS)) {
      const version = manifestVersions[manifestKey];
      const blobShortname = manifestKey.replace(/-ui$/, '');
      portalZipFiles[destFolder] = `${buildContainerName}-${blobShortname}-ui-${version}.zip`;
    }

    // Confirm every blob actually exists before starting a long apply — same
    // fail-fast reasoning as the Azure route's HEAD-check loop.
    const buildContainerSasForCheck = generateContainerReadSas(TF_STATE_ACCOUNT_NAME, TF_STATE_ACCOUNT_KEY, buildContainerName, 1);
    const missingBlobs = [];
    try {
      await Promise.all(Object.entries(portalZipFiles).map(async ([destFolder, filename]) => {
        const url = `https://${TF_STATE_ACCOUNT_NAME}.blob.core.windows.net/${buildContainerName}/${encodeURIComponent(filename)}?${buildContainerSasForCheck}`;
        const headResp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
        if (headResp.status !== 200) missingBlobs.push(filename);
      }));
    } catch (err) {
      return res.status(500).json({ success: false, error: `Failed to verify build zips: ${err.message}` });
    }
    if (missingBlobs.length) {
      return res.status(400).json({
        success: false,
        error: `Build zip(s) not found in container "${buildContainerName}": ${missingBlobs.join(', ')}`
      });
    }

    const requiredEnvKeys = ['DOCKER_REGISTRY_ADDRESS', 'DOCKER_REGISTRY_USERNAME', 'DOCKER_REGISTRY_PASSWORD'];
    const missingEnvKeys = requiredEnvKeys.filter(key => !process.env[key]);
    if (missingEnvKeys.length) {
      return res.status(500).json({ success: false, error: `Server is missing required config: ${missingEnvKeys.join(', ')}` });
    }

    // Read+list-only SAS for the build container, valid for the run — the EC2 web
    // instance fetches portal build zips directly via curl+SAS, exactly like an
    // Azure web VM does. One full URL per portal (var.portal_zip_urls is opaque to
    // the Terraform module either way, so no module changes were needed to switch
    // this from S3 to Blob).
    const buildContainerSas = generateContainerReadSas(TF_STATE_ACCOUNT_NAME, TF_STATE_ACCOUNT_KEY, buildContainerName, 6);
    const portalZipUrls = {};
    for (const [destFolder, filename] of Object.entries(portalZipFiles)) {
      portalZipUrls[destFolder] = `https://${TF_STATE_ACCOUNT_NAME}.blob.core.windows.net/${buildContainerName}/${encodeURIComponent(filename)}?${buildContainerSas}`;
    }

    // Merge into Stage 1's existing tfvars.json — same reasoning as the Azure
    // route: preserves everything Stage 1 already created untouched.
    const tfvarsFile = path.join(existing.work_dir, 'terraform.tfvars.json');
    let tfvars;
    try {
      tfvars = JSON.parse(fs.readFileSync(tfvarsFile, 'utf-8'));
    } catch (err) {
      return res.status(500).json({ success: false, error: `Could not read Stage 1's terraform.tfvars.json (work dir may have been cleaned up) — Stage 1 needs to be redone: ${err.message}` });
    }
    // Manual fallback for microservice name -> Docker image tag — the release
    // manifest above only ever covered web portal versions, never these. Captured
    // and written to the app instance (see deploymentfiles' microservice_tags_file
    // resource) for now; not yet wired into an actual docker-compose pull/run step.
    const microserviceTags = {};
    if (formData.microservice_tags && typeof formData.microservice_tags === 'object') {
      for (const [rawName, rawTag] of Object.entries(formData.microservice_tags)) {
        const name = String(rawName).trim();
        if (name) microserviceTags[name] = String(rawTag ?? '').trim();
      }
    }

    Object.assign(tfvars, {
      domain: trimStrings(formData.domain),
      kong_domain: trimStrings(formData.kong_domain),
      build_storage_account: TF_STATE_ACCOUNT_NAME,
      build_container_name: buildContainerName,
      portal_zip_files: portalZipFiles,
      portal_zip_urls: portalZipUrls,
      microservice_tags: microserviceTags,
      registry_username: process.env.DOCKER_REGISTRY_USERNAME,
      docker_registry_address: process.env.DOCKER_REGISTRY_ADDRESS,
      docker_registry_password: process.env.DOCKER_REGISTRY_PASSWORD
    });
    fs.writeFileSync(tfvarsFile, JSON.stringify(tfvars, null, 2), 'utf-8');

    const jobId = 'deploy-' + Date.now();
    deploymentsDb.markAppStageStarted(existing.id, jobId);

    startTerraformDeployment(
      jobId, 'apply', existing.work_dir, existing.state_key, existing.id, awsEnv, streamFullLogs, 'new-env',
      [], 'running'
    );

    return res.json({ success: true, jobId, message: 'Stage 2 (application setup) started' });
  } catch (error) {
    console.error('Error starting AWS new environment deployment:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Polled by the UI as the source of truth for a job's log + completion state.
// The Socket.IO stream alone isn't reliable enough for this — a dropped
// connection (e.g. a free ngrok tunnel silently closing a long-lived
// WebSocket) means the browser never sees the rest of the output or the
// "finished" event, even though the job completes normally on the backend.
// Reading the log file + deployment row directly instead means the UI can
// always recover the true state no matter what happened to the socket.
app.get('/api/jobs/:jobId/log', requireAuth, (req, res) => {
  const { jobId } = req.params;
  const logPath = path.join(__dirname, 'logs', `${jobId}.ui.log`);
  const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';

  // Every code path in startTerraformDeployment writes one of these exact lines
  // right before closing the log file — checking the log content directly (rather
  // than the deployment row's status) avoids ambiguity like markDestroyFailed
  // reverting status back to 'running', which would otherwise look identical to
  // a real success from this endpoint's point of view.
  const failed = /\[ERROR\] terraform \w+ failed with exit code/.test(content);
  const succeeded = /\n(Plan complete!|Apply complete!|Destroy complete!)\n/.test(content);
  const finished = failed || succeeded;

  // Written only by AWS New Environment's Stage 1 onApplySuccess callback, when
  // key_pair_mode = "generate" — the generated SSH private key only exists once
  // that apply actually finishes, so it can't be part of the initial response the
  // way the server-generated internal-service passwords are.
  let additionalSecrets;
  if (succeeded) {
    const secretsPath = path.join(__dirname, 'logs', `${jobId}.secrets.json`);
    if (fs.existsSync(secretsPath)) {
      try { additionalSecrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8')); } catch { /* ignore */ }
    }
  }

  return res.json({ success: true, content, finished, jobSucceeded: finished ? succeeded : null, additionalSecrets });
});

// Lines the UI actually needs to see. Everything else — mainly the raw
// remote-exec/cloud-init script output streamed while cloud_init_wait waits for
// the blob mount+copy to finish, and per-resource "Refreshing state..." lines —
// still goes to the full log file below, but is far too much for the UI to
// render. The "Still creating/destroying/modifying... [Xs elapsed]" heartbeat is
// kept (one line per ~10s per in-progress resource) specifically so a long-running
// step like the blob copy doesn't look frozen with nothing else printing for
// minutes at a time.
const UI_LOG_PATTERNS = [
  /^\$ terraform/,
  /: Creating\.\.\./,
  /: Creation complete/,
  /: Destroying\.\.\./,
  /: Destruction complete/,
  /: Modifying\.\.\./,
  /: Modifications complete/,
  /: Still (creating|destroying|modifying)\.\.\. \[.*elapsed\]/,
  // Terraform renders errors/warnings as a box drawn with │/╷/╵ characters, with
  // the actual message on a line like "│ Error: ...". Matching only "^Error:"
  // misses that box entirely, so a real failure showed no reason on the UI at
  // all — just the bare "failed with exit code" line below.
  /Error:/i,
  /^[│╷╵]/,
  /^\[ERROR\]/,
  /^Plan:/,
  /^No changes/,
  /^Plan complete!/,
  /^Apply complete!/,
  /^Destroy complete!/,
  /^Provisioning status:/,
  /Provisioning (did not complete|completed successfully)/
];

function shouldShowInUi(line) {
  return UI_LOG_PATTERNS.some(re => re.test(line));
}

// `targets` (module addresses, e.g. "module.vms") restricts an apply to just those —
// used by New Environment's Stage 1 (infra only) so Stage 2's app-setup module is
// left untouched until its own apply. Empty/omitted means a normal full apply.
// `onSuccessStatus` picks which deployments-db transition a successful apply makes:
// 'infra_ready' for Stage 1, 'running' (default, matches every existing call site)
// for a full apply/Stage 2. `onApplySuccess(workDir)` (optional) runs synchronously
// right after a successful apply, before the log files close — used only by AWS New
// Environment's Stage 1 to read the generated-key-pair Terraform output (a value
// that doesn't exist until the apply that creates it actually finishes, unlike the
// server-generated internal-service passwords returned immediately in the response).
function startTerraformDeployment(jobId, action, workDir, stateKey, deploymentId, azureArmEnv, streamFullLogs, flow, targets, onSuccessStatus, onApplySuccess) {
  // Listen for the UI to connect via WebSocket for this specific job
  const namespace = io.of('/' + jobId);

  namespace.on('connection', (socket) => {
    console.log(`UI connected to log stream for job ${jobId}, action: ${action}`);
    socket.on('disconnect', () => console.log(`UI disconnected from job ${jobId}`));
  });

  // The UI only ever gets a minimal filtered subset (see shouldShowInUi) — the
  // complete, unfiltered output still lands here so nothing is actually lost.
  const logsDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = fs.createWriteStream(path.join(logsDir, `${jobId}.log`), { flags: 'a' });
  // Mirrors exactly what the socket sends the UI (filtered or full, depending on
  // streamFullLogs) — GET /api/jobs/:jobId/log reads this one, not the full log
  // above, so polling respects the same choice instead of always dumping the
  // entire raw firehose regardless of what the user picked.
  const uiLogFile = fs.createWriteStream(path.join(logsDir, `${jobId}.ui.log`), { flags: 'a' });

  const env = { ...terraformEnv(), ...azureArmEnv };
  let lastLogLine = '';
  const emitLog = (text) => {
    logFile.write(text);
    // Streaming mode sends everything straight through, unfiltered — the minimal
    // filter (shouldShowInUi) is the default because raw terraform/cloud-init
    // output is enormous across many VMs, but some users want the full firehose.
    if (streamFullLogs) {
      namespace.emit('log', text);
      uiLogFile.write(text);
      return;
    }
    const uiLines = text.split('\n').filter(l => l.trim() && shouldShowInUi(l));
    if (uiLines.length) {
      const uiText = uiLines.join('\n') + '\n';
      namespace.emit('log', uiText);
      uiLogFile.write(uiText);
    }
  };
  const trackLastLine = (chunk) => {
    const lines = chunk.toString().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length) lastLogLine = lines[lines.length - 1];
  };

  // Start deployment immediately, and broadcast logs to the namespace
  // so if the UI disconnects and reconnects, it doesn't trigger a duplicate run!
  emitLog(`\n$ terraform init\n`);

  // Execute terraform init, binding to this client's own state key in the shared backend
  const tfInit = spawn(
    'terraform',
    ['init', '-input=false', '-reconfigure', ...backendConfigArgs(stateKey, flow)],
    { cwd: workDir, shell: true, env }
  );

  tfInit.stdout.on('data', data => { emitLog(data.toString()); trackLastLine(data); });
  tfInit.stderr.on('data', data => { emitLog(data.toString()); trackLastLine(data); });

  tfInit.on('close', (initCode) => {
    if (initCode !== 0) {
      emitLog(`\n[ERROR] terraform init failed with exit code ${initCode}\n`);
      namespace.emit('finished', { success: false });
      logFile.end();
      uiLogFile.end();
      if (deploymentId) deploymentsDb.markFailed(deploymentId, lastLogLine);
      return;
    }

    if (action === 'plan') {
      emitLog(`\n$ terraform plan\n`);
      const tfPlan = spawn('terraform', ['plan', '-input=false'], { cwd: workDir, shell: true, env });

      tfPlan.stdout.on('data', data => { emitLog(data.toString()); trackLastLine(data); });
      tfPlan.stderr.on('data', data => { emitLog(data.toString()); trackLastLine(data); });

      tfPlan.on('close', (planCode) => {
        if (planCode === 0) {
          emitLog(`\nPlan complete!\n`);
          namespace.emit('finished', { success: true });
          if (deploymentId) deploymentsDb.markPlanned(deploymentId);
        } else {
          emitLog(`\n[ERROR] terraform plan failed with exit code ${planCode}\n`);
          namespace.emit('finished', { success: false });
          if (deploymentId) deploymentsDb.markFailed(deploymentId, lastLogLine);
        }
        logFile.end();
      uiLogFile.end();
      });
      return;
    }

    if (action === 'destroy') {
      emitLog(`\n$ terraform destroy -auto-approve\n`);
      const tfDestroy = spawn('terraform', ['destroy', '-auto-approve', '-input=false'], { cwd: workDir, shell: true, env });

      tfDestroy.stdout.on('data', data => { emitLog(data.toString()); trackLastLine(data); });
      tfDestroy.stderr.on('data', data => { emitLog(data.toString()); trackLastLine(data); });

      tfDestroy.on('close', (destroyCode) => {
        if (destroyCode === 0) {
          emitLog(`\nDestroy complete!\n`);
          namespace.emit('finished', { success: true });
          if (deploymentId) deploymentsDb.markDestroyed(deploymentId);
        } else {
          emitLog(`\n[ERROR] terraform destroy failed with exit code ${destroyCode}\n`);
          namespace.emit('finished', { success: false });
          if (deploymentId) deploymentsDb.markDestroyFailed(deploymentId, lastLogLine);
        }
        logFile.end();
      uiLogFile.end();
      });
      return;
    }

    // Default to apply
    const targetArgs = (targets || []).map(t => `-target=${t}`);
    emitLog(`\n$ terraform apply -auto-approve${targetArgs.length ? ' ' + targetArgs.join(' ') : ''}\n`);
    const tfApply = spawn('terraform', ['apply', '-auto-approve', '-input=false', ...targetArgs], { cwd: workDir, shell: true, env });

    tfApply.stdout.on('data', data => { emitLog(data.toString()); trackLastLine(data); });
    tfApply.stderr.on('data', data => { emitLog(data.toString()); trackLastLine(data); });

    tfApply.on('close', (applyCode) => {
      if (applyCode === 0) {
        emitLog(`\nApply complete!\n`);
        if (onApplySuccess) {
          try { onApplySuccess(workDir); } catch (err) { console.error(`onApplySuccess failed for job ${jobId}:`, err.message); }
        }
        namespace.emit('finished', { success: true });
        if (deploymentId) {
          if (onSuccessStatus === 'infra_ready') deploymentsDb.markInfraReady(deploymentId, jobId);
          else deploymentsDb.markReady(deploymentId, jobId);
        }
      } else {
        emitLog(`\n[ERROR] terraform apply failed with exit code ${applyCode}\n`);
        namespace.emit('finished', { success: false });
        if (deploymentId) deploymentsDb.markFailed(deploymentId, lastLogLine);
      }
      logFile.end();
      uiLogFile.end();
    });
  });
}

// Serve the Angular build so this is one deployable process on one port instead
// of the API and the frontend needing to be run/deployed separately behind their
// own reverse proxy. Registered last so it never shadows an /api/* route above —
// an unmatched /api/* request falls through to next() (Express's default 404)
// rather than getting the SPA's index.html.
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist', 'azure-dr-ui', 'browser');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
} else {
  console.warn(`[WARN] Frontend build not found at ${frontendDist} — run "npm run build" in frontend/ first. Serving API only.`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Backend API running on http://localhost:${PORT}`);
});
