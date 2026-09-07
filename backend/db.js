const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT,
    azure_access INTEGER NOT NULL DEFAULT 0,
    aws_access INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function getUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
}

function getOrCreateUser(email, name) {
  const normalizedEmail = (email || '').toLowerCase();
  const existing = getUser(normalizedEmail);
  if (existing) return existing;
  db.prepare('INSERT INTO users (email, name) VALUES (?, ?)').run(normalizedEmail, name || '');
  return getUser(normalizedEmail);
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
}

function setAccess(email, { azure, aws }) {
  const normalizedEmail = (email || '').toLowerCase();
  db.prepare('UPDATE users SET azure_access = ?, aws_access = ? WHERE email = ?')
    .run(azure ? 1 : 0, aws ? 1 : 0, normalizedEmail);
  return getUser(normalizedEmail);
}

module.exports = { getOrCreateUser, getUser, listUsers, setAccess };
