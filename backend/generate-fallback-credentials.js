// Run once to generate the values for FALLBACK_ADMIN_USERNAME,
// FALLBACK_ADMIN_PASSWORD_HASH_B64 and FALLBACK_JWT_SECRET (paste the printed
// block into .env). Never commit the resulting .env values.
//
// The hash is printed base64-encoded, not the raw "$2a$12$..." bcrypt string --
// docker-compose's env_file loading interpolates "$" + letter sequences as
// "${VAR}" references and silently blanks them out when undefined, corrupting a
// raw bcrypt hash (confirmed directly: "$2a$12$Jy16O3w..." came out the other
// side as "$2a$12/FA8n...", losing the whole "$Jy16O3w..." segment). Plain
// `dotenv` (used for local non-Docker runs) has no such interpolation, so the
// same literal value can't survive both loading paths -- base64 has no "$" to
// trip either one.
//
// Usage: node generate-fallback-credentials.js <username> <password>
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: node generate-fallback-credentials.js <username> <password>');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const hashB64 = Buffer.from(hash, 'utf-8').toString('base64');
const secret = crypto.randomBytes(48).toString('hex');

console.log('\nAdd these to .env (repo root):\n');
console.log(`FALLBACK_ADMIN_USERNAME=${username}`);
console.log(`FALLBACK_ADMIN_PASSWORD_HASH_B64=${hashB64}`);
console.log(`FALLBACK_JWT_SECRET=${secret}\n`);
