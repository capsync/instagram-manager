const crypto = require('crypto');

// Source accounts per page (public Instagram / YouTube / TikTok accounts to pull videos from).
// Tables are created on first use, so db.js does not need to change. Works on Postgres and the SQLite fallback.
function createSourceStore(db) {
  let ready = null;
  const ensure = () => ready || (ready = (async () => {
    await db.run(`CREATE TABLE IF NOT EXISTS autopilot_sources (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, platform TEXT NOT NULL, handle TEXT NOT NULL, url TEXT NOT NULL,
      created_at TEXT, last_scan_at TEXT, last_error TEXT, last_found INTEGER DEFAULT 0, added_total INTEGER DEFAULT 0)`);
    await db.run(`CREATE TABLE IF NOT EXISTS autopilot_seen (account_id TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (account_id, url))`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_ap_sources_account ON autopilot_sources (account_id)`).catch(() => {});
  })().catch(e => { ready = null; throw e; }));

  return {
    ensure,
    async list(accountId) { await ensure(); return db.all(`SELECT * FROM autopilot_sources WHERE account_id=$1 ORDER BY created_at ASC`, [accountId]); },
    async get(id) { await ensure(); return db.get(`SELECT * FROM autopilot_sources WHERE id=$1`, [id]); },
    async count(accountId) { await ensure(); const r = await db.get(`SELECT COUNT(*) AS n FROM autopilot_sources WHERE account_id=$1`, [accountId]); return Number(r?.n || 0); },
    async add(accountId, s) {
      await ensure();
      const dup = await db.get(`SELECT id FROM autopilot_sources WHERE account_id=$1 AND platform=$2 AND LOWER(handle)=$3`, [accountId, s.platform, s.handle.toLowerCase()]);
      if (dup) return { duplicate: true };
      const id = crypto.randomUUID();
      await db.run(`INSERT INTO autopilot_sources (id, account_id, platform, handle, url, created_at, added_total) VALUES ($1,$2,$3,$4,$5,$6,0)`,
        [id, accountId, s.platform, s.handle, s.url, new Date().toISOString()]);
      return { id };
    },
    async remove(id) { await ensure(); await db.run(`DELETE FROM autopilot_sources WHERE id=$1`, [id]); },
    async markScan(id, { error, found, added }) {
      await ensure();
      await db.run(`UPDATE autopilot_sources SET last_scan_at=$1, last_error=$2, last_found=$3, added_total=COALESCE(added_total,0)+$4 WHERE id=$5`,
        [new Date().toISOString(), error || null, found || 0, added || 0, id]);
    },
    async isSeen(accountId, url) { await ensure(); return !!(await db.get(`SELECT 1 AS x FROM autopilot_seen WHERE account_id=$1 AND url=$2`, [accountId, url])); },
    async markSeen(accountId, url) { await ensure(); await db.run(`INSERT INTO autopilot_seen (account_id, url) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [accountId, url]); },
    async pagesWithSources() { await ensure(); return (await db.all(`SELECT DISTINCT account_id FROM autopilot_sources`)).map(r => r.account_id); }
  };
}

module.exports = { createSourceStore };
