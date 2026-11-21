const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../models/db');
const { downloadVideo, getVideoMetadata } = require('../services/downloader');
const { transcribeVideo, segmentsToSRT } = require('../services/transcription');
const { generateContent, generateSubtitleLines, generateReaction } = require('../services/captionGenerator');
const { enhanceVideo, renderFramed, renderTweet, detectContentRect } = require('../services/videoProcessor');
const remoteRender = require('../services/remoteRender');
const { renderCard, renderHeadlineCard, renderTweetCard } = require('../services/brandCard');
const { assessClip, extractCredit } = require('../services/contentGuard');
const logger = require('../services/logger');

const router = express.Router();

// Reads the optional caption fields from JSON bodies (bots/API) or multipart form fields (file upload).
// Every field is optional. Accepts snake_case or camelCase.
function readCaptionOptions(body = {}, isRepost = false) {
  const credit = body.credit_line ?? body.creditLine;
  return {
    brief:        body.brief,           // the one free-text note; split into the fields below by the caption writer
    instructions: body.instructions,
    mustInclude:  body.must_include ?? body.mustInclude,
    mentions:     body.mentions,
    hashtags:     body.hashtags,
    tosExact:       body.tos_exact ?? body.tosExact,
    tosMustInclude: body.tos_must_include ?? body.tosMustInclude,
    aiHashtags:   body.ai_hashtags ?? body.aiHashtags,
    // Credit line defaults ON for reposted links, OFF for your own uploaded clips
    creditLine:   (credit === undefined || credit === '') ? isRepost : credit
  };
}

// Instagram sometimes returns its login/generic page text instead of the real post caption.
function cleanMetaText(t = '') {
  const s = String(t || '').trim();
  if (!s) return '';
  if (/log in to instagram|create an account or log in|instagram photos and videos|^instagram$|^login/i.test(s) && s.length < 220) return '';
  return s;
}

// ── Background jobs + only one heavy job at a time ───────────────────────────
// Long steps (download, caption, render) would otherwise hold a web request open for minutes, which is fragile
// on a free server and on phones. With the header `x-async: 1` the route answers at once with a jobId and the
// work continues in the background; poll GET /api/content/job/:id. Without the header it behaves as before.
// Heavy jobs run one after another so two devices don't starve each other (and the server doesn't run out of memory).
const killSwitch = require('../services/killSwitch');
const jobs = new Map();   // id -> { status: queued|running|done|error, queuedAt, startedAt, finishedAt, code, body }
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) if ((j.finishedAt || j.queuedAt) < cutoff) jobs.delete(id);
}, 5 * 60 * 1000).unref();

// Two lanes so a download never waits behind a video render:
//  • download lane (link fetch, upload, transcribe, caption): up to DOWNLOAD_PARALLEL at once (default = AUTOPILOT_PARALLEL, min 1)
//  • render lane (rendering on THIS server): one at a time. Renders sent to a free worker skip this lane.
function makeLane(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < limit() && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return { run: (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); }), waiting: () => queue.length };
}
const downloadLane = makeLane(() => Math.max(1, Math.min(4, Number(process.env.DOWNLOAD_PARALLEL || process.env.AUTOPILOT_PARALLEL) || 1)));
const renderLane = makeLane(() => 1);
const heavyWaiting = () => downloadLane.waiting() + renderLane.waiting();
const runHeavyLocal = (fn) => renderLane.run(fn);

// Card/framed renders can go to a free render worker (see remoteRender.js). Those jobs skip the local render lane
// so several videos render at once; if no worker is free they wait in the local render lane like before.
function heavy(handler, opts = {}) {
  const lane = opts.lane === 'download' ? downloadLane : renderLane;
  return (req, res, next) => {
    const w = opts.remote && req.body && req.body.brandCard && req.body.brandCard.enabled ? remoteRender.reserve() : null;
    req.renderWorker = w;
    const uid = req.headers['x-user-id'] || null;
    // a job that was waiting in line when STOP ALL was pressed never starts; running ones are killed by the switch
    const guarded = (fn) => () => killSwitch.runAs(uid, () => { killSwitch.check(uid); return fn(); });
    const runHeavy = w ? (fn) => guarded(fn)().finally(() => remoteRender.release(w)) : (fn) => lane.run(guarded(fn));
    if (req.headers['x-async'] !== '1') return runHeavy(() => handler(req, res, next)).catch(next);
    const id = uuidv4();
    const job = { status: 'queued', queuedAt: Date.now(), userId: req.headers['x-user-id'] || null };
    jobs.set(id, job);
    const fail = (err) => { job.finishedAt = Date.now(); job.status = 'error'; job.code = 500; job.body = { error: err?.message || 'Failed' }; };
    const fakeRes = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { job.finishedAt = Date.now(); job.code = this.statusCode; job.body = b; job.status = this.statusCode >= 400 ? 'error' : 'done'; return this; }
    };
    runHeavy(async () => { job.status = 'running'; job.startedAt = Date.now(); await handler(req, fakeRes, fail); })
      .catch(fail)
      .finally(() => { if (job.status === 'running') fail(new Error('Finished without a result')); });
    res.status(202).json({ jobId: id, waiting_behind: Math.max(0, heavyWaiting() - 1) });
  };
}

router.get('/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (j && j.userId && j.userId !== req.headers['x-user-id']) return res.status(404).json({ error: 'That job is gone (the server may have restarted). Please try again.' });
  if (!j) return res.status(404).json({ error: 'That job is gone (the server may have restarted). Please try again.' });
  const base = {
    status: j.status,
    elapsed_s: Math.round(((j.finishedAt || Date.now()) - (j.startedAt || j.queuedAt)) / 1000),
    waiting_behind: j.status === 'queued' ? heavyWaiting() : 0
  };
  if (j.status === 'done') return res.json({ ...base, result: j.body });
  if (j.status === 'error') return res.json({ ...base, error: j.body?.error || 'Failed' });
  res.json(base);
});

function srtToText(srt = '') {
  return String(srt || '').split(/\r?\n/)
    .filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l)).join(' ');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.resolve(process.env.UPLOAD_DIR || './uploads')),
  filename:    (req, file, cb) => cb(null, `upload_${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) return cb(null, true);
    cb(new Error('Only video files are accepted'));
  }
});

async function processVideo(videoPath, videoUrl, accountId, meta = {}, options = {}) {
  const account = accountId
    ? await getDB().get('SELECT * FROM accounts WHERE id=$1', [accountId])
    : null;

  // Skip transcription when there is no local video file
  const tPrep = Date.now();
  const [{ text: transcript, segments }, autoCrop] = await Promise.all([
    videoPath ? transcribeVideo(videoPath) : Promise.resolve({ text: '', segments: [] }),
    videoPath ? detectContentRect(videoPath).catch(() => null) : Promise.resolve(null)
  ]);
  logger.info(`[timing] transcribe + bar detection: ${Math.round((Date.now() - tPrep) / 1000)}s`);
  const srtContent = segmentsToSRT(segments);

  // Nothing to write from (no video, no transcript, no real post text): don't let the AI make something up.
  const hasSource = !!videoPath || !!(meta.description || '').trim() || !!(meta.title || '').trim() || !!(transcript || '').trim();
  if (!hasSource) {
    return { transcript, segments, srtContent, caption: '', hookText: '', onScreenSuggestions: [], captionSkipped: true, autoCrop };
  }

  // Reposts: find the source credit, and run the safety check while the caption is being written
  const isRepost = !!videoUrl;
  const credit = isRepost ? extractCredit(meta, videoUrl) : null;
  const guardP = assessClip({ videoPath, meta, url: videoUrl || '', isRepost, credit, transcript });

  const { caption, onScreenText } = await generateContent({
    videoPath,
    transcript,
    originalCaption: meta.description || '',
    videoTitle:      meta.title || '',
    captionStyle: account?.caption_style || 'casual',
    customPrompt: account?.caption_prompt,
    options: { ...options, creditHandle: credit?.handle }
  });

  const guard = await guardP;

  return { transcript, segments, srtContent, caption, hookText: onScreenText, onScreenSuggestions: [], autoCrop, guard };
}

router.post('/process-url', heavy(async (req, res, next) => {
  try {
    const { url, account_id } = req.body;
    if (!url || !url.trim()) return res.status(400).json({ error: 'url is required' });

    const isInstagram = /instagram\.com/.test(url);
    const meta = await getVideoMetadata(url).catch(() => ({ title: '', description: '' }));
    meta.title = cleanMetaText(meta.title);
    meta.description = cleanMetaText(meta.description);

    // Always try to download the video; for Instagram, a failed download is non-fatal
    let videoFile = null;
    let downloadError = null;
    try {
      videoFile = await downloadVideo(url);
    } catch (downloadErr) {
      if (!isInstagram) throw downloadErr; // non-Instagram: download failure is a hard error
      downloadError = downloadErr.message;
      logger.warn('Instagram video download failed, continuing with caption only:', downloadErr.message);
    }

    const videoPath = videoFile ? videoFile.path : null;

    const { transcript, segments, srtContent, caption, hookText, onScreenSuggestions, captionSkipped, autoCrop, guard } =
      await processVideo(videoPath, url, account_id, meta, readCaptionOptions(req.body, true));

    const postId = uuidv4();
    await getDB().run(
      `INSERT INTO posts (id, account_id, video_url, local_video_path, original_caption, generated_caption, hook_text, subtitles_srt, status, guard_level, guard_reasons, credit_handle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11)`,
      [postId, account_id || null, url, videoPath, meta.description || '', caption, hookText, srtContent,
       guard?.level || null, guard ? JSON.stringify(guard.reasons || []) : null, guard?.credit?.handle || null]
    );

    res.json({
      postId,
      videoUrl: videoFile ? videoFile.url : null,
      metadata: meta,
      transcript: (transcript || '').substring(0, 600),
      segments: segments || [],
      generatedCaption: caption,
      hookText,
      srtContent,
      onScreenSuggestions,
      instagramUrl: isInstagram && !videoFile ? url : null,
      downloadError: isInstagram && !videoFile ? downloadError : null,
      captionSkipped: !!captionSkipped,
      autoCrop: autoCrop || null,
      guard: guard || null,
    });
  } catch (err) { next(err); }
}, { lane: 'download' }));

router.post('/process-file', upload.single('video'), heavy(async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });
    const { account_id } = req.body;
    const videoPath = req.file.path;
    const videoUrl = `/uploads/${req.file.filename}`;

    const { transcript, segments, srtContent, caption, hookText, onScreenSuggestions, autoCrop, guard } =
      await processVideo(videoPath, null, account_id, {}, readCaptionOptions(req.body, false));

    const postId = uuidv4();
    await getDB().run(
      `INSERT INTO posts (id, account_id, local_video_path, generated_caption, hook_text, subtitles_srt, status, guard_level, guard_reasons)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)`,
      [postId, account_id || null, videoPath, caption, hookText, srtContent, guard?.level || null, guard ? JSON.stringify(guard.reasons || []) : null]
    );

    res.json({ postId, videoUrl, transcript: transcript.substring(0, 600), generatedCaption: caption, hookText, srtContent, onScreenSuggestions, autoCrop: autoCrop || null, guard: guard || null });
  } catch (err) { next(err); }
}, { lane: 'download' }));

// Renders the page card to a temp PNG. Returns { brand } or { error, status }.
async function buildBrandCard(req, accountId, text, dir, frame, mode, quality, themeOverride) {
  const plain = mode === 'text';   // text only: same layout without the page branding
  const account = accountId ? await getDB().get('SELECT * FROM accounts WHERE id=$1', [accountId]) : null;
  if (!account && !plain) return { status: 400, error: 'Pick a page first to use the card layout.' };
  const userId = req.headers['x-user-id'];
  if (account && userId && account.user_id && account.user_id !== userId) return { status: 403, error: 'Not your page.' };
  const t = String(text || '').trim();
  if (!t && !plain) return { status: 400, error: 'Add on-screen text first — it goes inside the card.' };
  const card = await renderCard({
    plain,
    name: account?.brand_name || account?.name,
    handle: account?.brand_handle || account?.username,
    verified: !!account?.brand_verified,
    avatar: account?.brand_avatar,
    text: t,
    theme: (themeOverride === 'light' || themeOverride === 'dark') ? themeOverride : (account?.brand_theme || 'dark'),
    scale: frame?.cardScale
  });
  // Same card = same file on disk, written once and reused by every video (no re-draw, no re-write).
  const cardPath = path.join(dir, `card_${require('crypto').createHash('sha1').update(card.buffer).digest('hex').slice(0, 20)}.png`);
  if (!fs.existsSync(cardPath)) fs.writeFileSync(cardPath, card.buffer);
  return { brand: { cardPath, keepCard: true, cardH: card.height, frame: frame || null, canvasColor: card.canvasColor, quality }, card };
}

// Live preview of the card (PNG as a data URL) for the review screen
router.post('/card-preview', async (req, res, next) => {
  try {
    const { account_id, text, scale, mode, theme } = req.body || {};
    const plain = mode === 'text';
    const account = account_id ? await getDB().get('SELECT * FROM accounts WHERE id=$1', [account_id]) : null;
    if (!account && !plain) return res.status(400).json({ error: 'Pick a page first.' });
    const userId = req.headers['x-user-id'];
    if (account && userId && account.user_id && account.user_id !== userId) return res.status(403).json({ error: 'Not your page.' });
    const card = await renderCard({
      plain,
      name: account?.brand_name || account?.name,
      handle: account?.brand_handle || account?.username,
      verified: !!account?.brand_verified,
      avatar: account?.brand_avatar,
      text: String(text || '').trim() || (plain ? '' : 'Your on-screen text appears here'),
      theme: (theme === 'light' || theme === 'dark') ? theme : (account?.brand_theme || 'dark'),
      scale
    });
    res.json({ image: `data:image/png;base64,${card.buffer.toString('base64')}`, width: card.width, height: card.height, canvasColor: card.canvasColor });
  } catch (err) { next(err); }
});

router.post('/enhance/:postId', heavy(async (req, res, next) => {
  try {
    const { burnSubtitles = false, enhance = false, textOverlays = [], trim, adjustments, speed, cropRatio, subtitleStyle = 'standard', segments, brandCard, account_id } = req.body;
    const post = await getDB().get('SELECT * FROM posts WHERE id=$1', [req.params.postId]);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const inputPath = post.local_video_path;
    if (!inputPath) return res.status(400).json({ error: 'No local video to enhance' });
    const fs = require('fs');
    if (!fs.existsSync(inputPath)) return res.status(410).json({ error: 'Video file no longer on server — please process the URL again.' });

    const hasTrim = trim?.end > 0 || trim?.start > 0;
    const hasAdj  = adjustments && (adjustments.brightness !== 0 || adjustments.contrast !== 1 || adjustments.saturation !== 1);
    const hasSpeed = speed && speed !== 1;
    const wantsCard = !!brandCard?.enabled;
    if (!burnSubtitles && !enhance && textOverlays.length === 0 && !hasTrim && !hasAdj && !hasSpeed && !wantsCard)
      return res.status(400).json({ error: 'Select at least one editing or enhancement option' });

    // Page card layout (card on top, video below). Name/handle fall back to the connected account's own.
    // 'clean' / 'cinema' = direct 3:4 or 4:3 video (no page card). Cinema puts subtitle-style text over the video.
    const framedMode = wantsCard && ['clean', 'cinema'].includes(brandCard.mode);
    // 'tweet' = Reaction layout: headline on top, video, tweet card (page profile + reaction comment) under it.
    const tweetMode = wantsCard && brandCard.mode === 'tweet';
    let tweetHead = null, tweetCard = null, tweetCanvas = '#ffffff';
    if (tweetMode) {
      const reaction = String(brandCard.text || '').trim();
      if (!reaction) return res.status(400).json({ error: 'Write the reaction comment first. It goes in the tweet card under the video.' });
      const acct = (account_id || post.account_id) ? await getDB().get('SELECT * FROM accounts WHERE id=$1', [account_id || post.account_id]) : null;
      if (!acct) return res.status(400).json({ error: 'Pick a page first. Its reaction profile is used on the tweet card.' });
      const uid = req.headers['x-user-id'];
      if (uid && acct.user_id && acct.user_id !== uid) return res.status(403).json({ error: 'Not your page.' });
      if (!String(acct.react_name || '').trim() || !String(acct.react_handle || '').trim())
        return res.status(400).json({ error: 'This page has no reaction profile yet. Open Accounts, edit the page and fill in "Reaction profile (fictional)".' });
      const theme = (brandCard.theme === 'dark' || brandCard.theme === 'light') ? brandCard.theme : 'light';
      const cardImg = await renderTweetCard({ name: acct.react_name, handle: acct.react_handle, verified: !!acct.react_verified, avatar: acct.react_avatar, text: reaction, theme });
      const sha1 = (buf) => require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 20);
      const cp = path.join(path.dirname(inputPath), `tweet_${sha1(cardImg.buffer)}.png`);
      if (!fs.existsSync(cp)) fs.writeFileSync(cp, cardImg.buffer);
      tweetCard = { cardPath: cp, width: cardImg.width, height: cardImg.height };
      tweetCanvas = cardImg.canvasColor;
      const headline = String(brandCard.headline || '').trim();
      if (headline) {
        const h = await renderHeadlineCard({ text: headline, theme });
        const hp = path.join(path.dirname(inputPath), `head_${sha1(h.buffer)}.png`);
        if (!fs.existsSync(hp)) fs.writeFileSync(hp, h.buffer);
        tweetHead = { cardPath: hp, width: h.width, height: h.height };
      }
    }
    let brand = null, framedCard = null;
    if (wantsCard && !framedMode && !tweetMode) {
      const built = await buildBrandCard(req, account_id || post.account_id, brandCard.text, path.dirname(inputPath), brandCard.frame, brandCard.mode, brandCard.quality, brandCard.theme);
      if (built.error) return res.status(built.status).json({ error: built.error });
      brand = built.brand;
    }
    if (framedMode && brandCard.mode === 'cinema' && String(brandCard.text || '').trim()) {
      const c = await renderCard({ plain: true, subtitle: true, text: String(brandCard.text).trim() });
      const cp = path.join(p
