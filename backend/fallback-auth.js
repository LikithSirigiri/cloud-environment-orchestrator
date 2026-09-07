const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Break-glass admin login, independent of Azure AD. Tokens minted here are
// HS256 and carry this issuer so authz.js can tell them apart from a real
// Microsoft-issued RS256 id token and skip the JWKS verification path.
const ISSUER = 'dr-orchestrator-fallback';
const AUDIENCE = 'dr-orchestrator-fallback-admin';
const TOKEN_TTL = '12h';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attemptsByIp = new Map();

function isRateLimited(ip) {
  const entry = attemptsByIp.get(ip);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const entry = attemptsByIp.get(ip);
  if (!entry || Date.now() > entry.resetAt) {
    attemptsByIp.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailures(ip) {
  attemptsByIp.delete(ip);
}

// Constant-time-ish username compare -- still runs a timingSafeEqual on a
// length mismatch (against a zeroed buffer) so a wrong-length guess doesn't
// return measurably faster than a right-length one.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// The bcrypt hash is stored base64-encoded in .env (FALLBACK_ADMIN_PASSWORD_HASH_B64),
// not as the raw "$2a$12$..." string — a real bcrypt hash always contains a "$"
// immediately followed by a letter (the salt), which docker-compose's env_file
// loading interpolates as a "${VARNAME}" reference and silently replaces with an
// empty string when no such variable exists (confirmed directly against a running
// container: "$2a$12$Jy16O..." came out the other side as "$2a$12/FA8n...", the
// entire "$Jy16O3wfkcOntY5knV0pbOGy0" segment silently deleted). Plain `dotenv`
// (used for local non-Docker runs) has no such interpolation, so the exact same
// literal value can't survive both loading paths — base64 has no "$" at all,
// sidestepping the conflict entirely instead of picking one path to keep working.
function decodeHash(b64) {
  try {
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function isConfigured() {
  return !!(process.env.FALLBACK_ADMIN_USERNAME && process.env.FALLBACK_ADMIN_PASSWORD_HASH_B64 && process.env.FALLBACK_JWT_SECRET);
}

async function verifyFallbackLogin(username, password) {
  if (!isConfigured()) return null;

  const expectedUsername = process.env.FALLBACK_ADMIN_USERNAME;
  if (!safeEqual(username || '', expectedUsername)) return null;

  const expectedHash = decodeHash(process.env.FALLBACK_ADMIN_PASSWORD_HASH_B64);
  const passwordMatches = await bcrypt.compare(password || '', expectedHash);
  if (!passwordMatches) return null;

  return jwt.sign(
    { name: 'Fallback Admin', fallback: true },
    process.env.FALLBACK_JWT_SECRET,
    { subject: expectedUsername, issuer: ISSUER, audience: AUDIENCE, expiresIn: TOKEN_TTL }
  );
}

function verifyFallbackToken(token) {
  if (!process.env.FALLBACK_JWT_SECRET) return null;
  try {
    return jwt.verify(token, process.env.FALLBACK_JWT_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256']
    });
  } catch {
    return null;
  }
}

module.exports = {
  ISSUER,
  isConfigured,
  verifyFallbackLogin,
  verifyFallbackToken,
  isRateLimited,
  recordFailure,
  clearFailures
};
