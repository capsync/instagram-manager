// Makes sure the Reaction-profile columns exist on `accounts`, even if the database was not migrated yet.
// Safe to call any time: it runs once per server start and ignores "already exists" errors (Postgres and SQLite).
const { getDB } = require('../models/db');
const logger = require('./logger');

const COLUMNS = [
  ['react_name', 'TEXT'],
  ['react_handle', 'TEXT'],
  ['react_verified', 'INTEGER DEFAULT 0'],
  ['react_avatar', 'TEXT']
];
let done = null;

function ensureReactColumns() {
  if (done) return done;
  done = (async () => {
    const db = getDB();
    for (const [name, type] of COLUMNS) {
      try { await db.run(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`); logger.info(`Added accounts.${name}`); }
      catch { /* already there */ }
    }
  })().catch(() => { done = null; });
  return done;
}

module.exports = { ensureReactColumns };
