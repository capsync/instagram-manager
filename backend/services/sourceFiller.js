// Keeps each page's Autopilot queue topped up from its source accounts.
// Every 30 min: for pages with Autopilot ON and a queue below the target, scan sources (each at most every 3 h),
// take the newest videos not seen before, and add them to the queue. Free-server friendly: one scan at a time.
const logger = require('./logger');
const { getDB } = require('../models/db');
const { createStore } = require('./autopilotStore');
const { createSourceStore } = require('./sourceStore');
const { findLinks } = require('./linkFinder');
const { normalizeUrl } = require('./autopilot');

const MAX_QUEUED = 200;
const TARGET = Math.min(150, Math.max(5, Number(process.env.SOURCE_QUEUE_TARGET) || 20));   // keep about this many queued
const MIN_RESCAN_MS = 3 * 3600 * 1000;
const MIN_RESCAN_IG_MS = 8 * 3600 * 1000;   // Instagram sources are scanned less often
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCAN_DEPTH = 15;   // newest videos looked at per source per scan
let running = false;

const isBusy = () => running;

async function refill(accountId, { force = false } = {}) {
  if (running) return { ok: false, reason: 'busy' };
  running = true;
  try {
    const s = createStore(getDB()), src = createSourceStore(getDB());
    await src.ensure();
    const counts = await s.queueCounts(accountId);
    const room = Math.min(TARGET, MAX_QUEUED) - (counts.queued || 0);
    if (room <= 0) return { ok: true, added: 0, reason: 'queue already full enough' };

    const now = Date.now();
    const due = (await src.list(accountId)).filter(x => force || !x.last_scan_at || now - new Date(x.last_scan_at).getTime() >= (x.platform === 'instagram' ? MIN_RESCAN_IG_MS : MIN_RESCAN_MS));
    if (!due.length) return { ok: true, added: 0, reason: 'scanned recently' };

    const lists = [];
    for (const x of due) {
      let r;
      if (x.platform === 'instagram' && lists.some(l => l.x.platform === 'instagram')) await sleep(8000 + Math.random() * 7000);   // pause between Instagram scans
      try { [r] = await findLinks([x.url], { platform: x.platform, perAccount: SCAN_DEPTH }); }
      catch (e) { r = { links: [], error: e.message }; }
      lists.push({ x, urls: (r.links || []).map(l => normalizeUrl(l.url)).filter(Boolean), error: r.error || null, added: 0 });
    }

    // take turns between sources so one busy account doesn't fill the whole queue
    const order = [];
    for (let i = 0; ; i++) {
      let any = false;
      for (const l of lists) if (i < l.urls.length) { order.push({ l, url: l.urls[i] }); any = true; }
      if (!any) break;
    }
    let added = 0; const taken = new Set();
    for (const { l, url } of order) {
      if (added >= room) break;
      if (taken.has(url)) continue; taken.add(url);
      if (await src.isSeen(accountId, url)) continue;
      const r = await s.addItem(accountId, url, null, new Date().toISOString());
      await src.markSeen(accountId, url);
      if (!r.duplicate) { added++; l.added++; }
    }
    for (const l of lists) await src.markScan(l.x.id, { error: l.error, found: l.urls.length, added: l.added });
    logger.info(`Sources: page ${accountId} +${added} queued from ${lists.length} source(s)`);
    return { ok: true, added, errors: lists.filter(l => l.error).length };
  } catch (e) {
    logger.warn('Source refill failed: ' + e.message);
    return { ok: false, reason: e.message };
  } finally { running = false; }
}

async function sweep() {
  try {
    const s = createStore(getDB()), src = createSourceStore(getDB());
    const withSources = new Set(await src.pagesWithSources());
    if (!withSources.size) return;
    const pages = await s.listPages(null, { enabledOnly: true });
    for (const p of pages) {
      if (p.ap_paused_reason || !withSources.has(p.id)) continue;
      await refill(p.id);
    }
  } catch (e) { logger.warn('Source sweep failed: ' + e.message); }
}

function startSourceFiller() {
  const cron = require('node-cron');
  cron.schedule('*/30 * * * *', sweep);
  setTimeout(sweep, 3 * 60 * 1000);
  logger.info(`Source auto-fill ready (checks every 30 min, queue target ${TARGET})`);
}

module.exports = { refill, sweep, isBusy, startSourceFiller };
