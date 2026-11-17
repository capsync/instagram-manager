// STOP ALL: one switch that halts everything a user has running on the server.
//
//  • kills any ffmpeg / yt-dlp / ffprobe process started for that user (downloads, renders, transcribing)
//  • cancels waiting jobs, so they never start
//  • pauses every Autopilot page of that user and sends the item that was being made to "failed: Stopped by you"
//  • turns scheduled posts back into drafts so nothing fires later
//  • blocks new work (download / render / publish) until the user presses Resume
//
// IMPORTANT: this file must be required FIRST in server.js, because it wraps child_process.execFile
// before the other files grab it.
//
// Limit: a post that Instagram has ALREADY accepted for publishing cannot be recalled from here. If one still
// goes live, delete it in the Instagram app.
const cp = require('child_process');
const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const logger = require('./logger');

const als = new AsyncLocalStorage();
const key = (u) => (u ? String(u) : '_');
const children = new Set();           // { child, user }
const stoppedAt = new Map();          // user key -> ISO time

// ── track child processes per user ───────────────────────────────────────────
const origExecFile = cp.execFile;
if (!origExecFile.__tracked) {
  const wrapped = function (...args) {
    const child = origExecFile.apply(this, args);
    try {
      const rec = { child, user: key(als.getStore()?.user) };
      children.add(rec);
      const done = () => children.delete(rec);
      child.once('close', done); child.once('error', done);
    } catch { /* tracking is best effort */ }
    return child;
  };
  if (origExecFile[util.promisify.custom]) wrapped[util.promisify.custom] = origExecFile[util.promisify.custom];
  wrapped.__tracked = true;
  cp.execFile = wrapped;
}

/** Runs fn with the user attached, so every process it starts can be found again. */
const runAs = (userId, fn) => als.run({ user: userId || null }, fn);

const isStopped = (userId) => stoppedAt.has(key(userId));

class StoppedError extends Error {
  constructor() { super('Stopped by you. Press Resume to continue.'); this.stopped = true; this.code = 'stopped'; }
}
/** Throws if this user pressed STOP ALL. Call it between steps of long jobs. */
const check = (userId) => { if (isStopped(userId)) throw new StoppedError(); };

// New heavy work is refused while stopped (reading, listing and changing settings still work).
const BLOCKED = [
  /^\/content\/(process-url|process-file|enhance\/|regenerate\/)/,
  /^\/posts\/[^/]+\/(publish|schedule)$/,
  /^\/autopilot\/[^/]+\/run$/
];
function middleware(req, res, next) {
  const user = req.headers['x-user-id'] || null;
  if (req.method === 'POST' && isStopped(user) && BLOCKED.some(re => re.test(req.path))) {
    return res.status(423).json({ error: 'Everything is stopped. Press Resume to continue.', code: 'stopped' });
  }
  runAs(user, next);
}

// ── the switch ───────────────────────────────────────────────────────────────
function ownedAccountsSql(userId) {
  return userId
    ? { sql: `SELECT id FROM accounts WHERE user_id=$1`, params: [String(userId)] }
    : { sql: `SELECT id FROM accounts WHERE user_id IS NULL OR user_id=''`, params: [] };
}

async function stopAll(userId) {
  const k = key(userId);
  stoppedAt.set(k, new Date().toISOString());

  let killed = 0;
  for (const rec of [...children]) {
    if (rec.user !== k) continue;
    try { rec.child.kill('SIGKILL'); killed++; } catch { /* already gone */ }
    children.delete(rec);
  }

  const out = { killed, queueStopped: 0, scheduledCancelled: 0, publishingMarked: 0, pagesPaused: 0 };
  try {
    const { getDB } = require('../models/db');
    const db = getDB();
    const own = ownedAccountsSql(userId);
    const ids = (await db.all(own.sql, own.params)).map(r => r.id);
    const now = new Date().toISOString();
    for (const id of ids) {
      const q = await db.run(`UPDATE autopilot_queue SET status='failed', error='Stopped by you', finished_at=$1 WHERE account_id=$2 AND status='processing'`, [now, id]);
      out.queueStopped += Number(q?.changes ?? q?.rowCount ?? 0);
      const sc = await db.run(`UPDATE posts SET status='draft', error_message='Schedule cancelled by STOP ALL' WHERE account_id=$1 AND status='scheduled'`, [id]);
      out.scheduledCancelled += Number(sc?.changes ?? sc?.rowCount ?? 0);
      const pb = await db.run(`UPDATE posts SET status='failed', error_message='Stopped by you' WHERE account_id=$1 AND status='publishing'`, [id]);
      out.publishingMarked += Number(pb?.changes ?? pb?.rowCount ?? 0);
      await db.run(`UPDATE accounts SET ap_paused_reason=$1 WHERE id=$2`, ['Stopped by you (STOP ALL). Press Resume.', id]);
      out.pagesPaused++;
    }
  } catch (err) {
    logger.warn('STOP ALL: database cleanup failed: ' + err.message);
    out.warning = 'Processes were stopped, but the database cleanup failed: ' + err.message;
  }
  logger.warn(`STOP ALL pressed by ${k}: ${JSON.stringify(out)}`);
  return out;
}

async function resume(userId) {
  stoppedAt.delete(key(userId));
  try {
    const { getDB } = require('../models/db');
    const db = getDB();
    const own = ownedAccountsSql(userId);
    for (const r of await db.all(own.sql, own.params)) {
      await db.run(`UPDATE accounts SET ap_paused_reason=NULL, ap_fail_streak=0 WHERE id=$1 AND ap_paused_reason LIKE 'Stopped by you%'`, [r.id]);
    }
  } catch (err) { logger.warn('Resume: could not clear page pauses: ' + err.message); }
  logger.info(`Resumed for ${key(userId)}`);
  return { stopped: false };
}

const status = (userId) => ({ stopped: isStopped(userId), since: stoppedAt.get(key(userId)) || null });

module.exports = { runAs, middleware, isStopped, check, stopAll, resume, status, StoppedError };
