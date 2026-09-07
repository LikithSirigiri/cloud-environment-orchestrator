const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ISSUER: FALLBACK_ISSUER, verifyFallbackToken } = require('./fallback-auth');

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
let cachedKeys = null;
let cachedAt = 0;
let jwksInFlight = null;

function fetchJwks() {
  if (jwksInFlight) return jwksInFlight;

  const uri = `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/discovery/v2.0/keys`;
  console.log('[auth] fetching JWKS from', uri);

  jwksInFlight = new Promise((resolve, reject) => {
    const req = https.get(uri, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          const keys = JSON.parse(body).keys || [];
          console.log('[auth] JWKS fetched,', keys.length, 'keys');
          resolve(keys);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('JWKS request timed out')));
  }).finally(() => {
    jwksInFlight = null;
  });

  return jwksInFlight;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getSigningKey(kid) {
  const isStale = !cachedKeys || Date.now() - cachedAt > JWKS_CACHE_TTL_MS;
  if (isStale) {
    cachedKeys = await fetchJwks();
    cachedAt = Date.now();
  }

  let jwk = cachedKeys.find(k => k.kid === kid);
  if (!jwk) {
    // Key rotated on Microsoft's side — force one refresh before giving up.
    cachedKeys = await fetchJwks();
    cachedAt = Date.now();
    jwk = cachedKeys.find(k => k.kid === kid);
  }
  if (!jwk) throw new Error(`No signing key found for kid ${kid}`);

  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function isAdmin(email) {
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes((email || '').toLowerCase());
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Missing bearer token' });

  console.log('[auth]', req.method, req.originalUrl, '- verifying token');

  try {
    const unverified = jwt.decode(token, { complete: true });
    if (!unverified) return res.status(401).json({ success: false, error: 'Malformed token' });

    // Fallback (break-glass) tokens are HS256, self-issued, and carry a
    // distinct issuer -- verify those against the local secret instead of
    // Microsoft's JWKS.
    if (unverified.payload && unverified.payload.iss === FALLBACK_ISSUER) {
      const decoded = verifyFallbackToken(token);
      if (!decoded) return res.status(401).json({ success: false, error: 'Invalid or expired token' });

      console.log('[auth] verified as fallback admin', decoded.sub);
      req.user = { email: decoded.sub, name: decoded.name || 'Fallback Admin', isFallbackAdmin: true };
      return next();
    }

    const key = await withTimeout(
      getSigningKey(unverified.header.kid),
      10000,
      'Signing key lookup timed out'
    );
    console.log('[auth] signing key resolved');

    const decoded = jwt.verify(token, key, {
      audience: process.env.AZURE_AD_CLIENT_ID,
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0`
    });

    const email = (decoded.preferred_username || decoded.email || decoded.upn || '').toLowerCase();
    if (!email) return res.status(401).json({ success: false, error: 'Token missing email claim' });

    console.log('[auth] verified as', email);
    req.user = { email, name: decoded.name || '' };
    next();
  } catch (err) {
    console.error('[auth] verification failed:', err.message);
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.isFallbackAdmin && !isAdmin(req.user.email)) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

module.exports = { isAdmin, requireAuth, requireAdmin };
