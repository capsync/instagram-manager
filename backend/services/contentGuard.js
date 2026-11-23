// Pre-publish safety gate.
//
// Scores a clip for "likely to be flagged as unoriginal / copyrighted" risk BEFORE it can be published.
//   level 'clear'   → can publish (manual or autopilot)
//   level 'review'  → held: manual posts need an explicit confirm, autopilot/scheduler never post it
//   level 'blocked' → never publishes
//
// This reduces risk, it cannot guarantee safety: Content ID / Rights Manager claims are not visible to us.
// Signals used: source metadata (title, caption, uploader, track, license), ffprobe file tags,
// a blocklist of broadcasters / leagues / labels / events, and a Gemini look at a few frames.
const { execFile } = require('child_process');
const logger = require('./logger');

// GUARD_MODE (env): 'coachella' (default) = ONLY Coachella clips are blocked, everything else passes.
//                   'full' = the old strict checks (labels, broadcasters, leagues, studios, official uploads, ...).
const GUARD_MODE = String(process.env.GUARD_MODE || 'coachella').toLowerCase() === 'full' ? 'full' : 'coachella';
const COACHELLA_RE = /coachella/i;   // also catches #coachella and coachella2025

const BLOCK_AT = 30;   // 30+ = risky = never posts (no review tier)
const REVIEW_AT = 30;

// Edit these lists freely. Matched as whole words, case-insensitive.
const HARD_TERMS = [
  // sports leagues + broadcasters
  'nba', 'nfl', 'mlb', 'nhl', 'ufc', 'wwe', 'fifa', 'premier league', 'champions league', 'espn', 'sky sports', 'bein sports', 'dazn',
  // full-length / official uploads
  'official music video', 'vevo', 'full movie', 'full episode', 'full match', 'full concert', 'full set', 'official trailer'
];
const MEDIUM_TERMS = [
  // festivals / awards / big live events
  'coachella', 'glastonbury', 'tomorrowland', 'lollapalooza', 'met gala', 'grammys', 'oscars', 'emmys', 'vmas', 'super bowl', 'halftime show', 'billboard music awards',
  // studios / networks / streamers
  'netflix', 'hbo', 'disney', 'marvel', 'warner bros', 'universal pictures', 'paramount', 'sony pictures', 'prime video', 'apple tv', 'nickelodeon', 'cartoon network', 'mtv', 'bbc', 'cnn',
  // labels
  'sony music'
];
// Universal Music Group + Warner Music Group: never processed. Any mention in the source text blocks the clip.
// Edit freely. Whole-word, case-insensitive. (Labels only; artist names are handled by the label lookup below.)
const LABEL_TERMS = [
  // Universal Music Group
  'universal music', 'universal music group', 'umg', 'republic records', 'interscope', 'def jam', 'capitol records', 'capitol music group',
  'island records', 'motown', 'geffen', 'polydor', 'virgin records', 'virgin music', 'emi records', 'emi music', 'decca records', 'mercury records',
  'verve records', 'deutsche grammophon', 'abkco', 'spinefarm', 'umgi',
  // Warner Music Group
  'warner music', 'warner music group', 'wmg', 'warner records', 'atlantic records', 'elektra records', 'parlophone', 'rhino records',
  'sire records', 'reprise records', 'warner chappell', 'warner chappell music', '300 entertainment', 'nonesuch', 'fueled by ramen', 'roadrunner records', 'east west records', 'big beat records'
];

// When a festival/event name appears together with one of these it is the official stream, not a fan clip.
const OFFICIAL_STREAM = /\b(live ?stream|livestream|official|full set|broadcast|presented by)\b/i;
const OTHER_APP_TAGS = /\b(tiktok|douyin|snapchat|likee|kuaishou|capcut|vm\.tiktok)\b/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (t) => new RegExp(`(^|[^a-z0-9])${esc(t).replace(/\s+/g, '\\s+')}([^a-z0-9]|$)`, 'i');
const HARD_RE = HARD_TERMS.map(t => [t, termRe(t)]);
const MED_RE = MEDIUM_TERMS.map(t => [t, termRe(t)]);
const LABEL_RE = LABEL_TERMS.map(t => [t, termRe(t)]);

function levelFor(score) { return score >= BLOCK_AT ? 'blocked' : 'clear'; }

// ── credit detection ─────────────────────────────────────────────────────────
// Credit is added ONLY when the source caption itself credits someone ("📹 @x", "credit: @x", "via @x", "video by @x"...).
// The account the clip was taken from is never used as a credit.
const CREDIT_RE = /(?:^|[\s(\[|•·\-–—])(?:credits?|cr|via|source|video by|clip by|filmed by|footage by|courtesy of|dc|📹|🎥|🎬|©)\s*[:\-–—]?\s*@([A-Za-z0-9._]{2,30})/i;

/** The handle credited inside the source caption, or null. */
function extractCredit(meta = {}) {
  const text = [meta.description, meta.title].filter(Boolean).join('\n');
  const c = text.match(CREDIT_RE);
  return c ? { handle: c[1].replace(/\.+$/, ''), via: 'caption' } : null;
}

// ── metadata signals ─────────────────────────────────────────────────────────
function probeTags(videoPath) {
  return new Promise((resolve) => {
    if (!videoPath) return resolve('');
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve('');
      try {
        const j = JSON.parse(out);
        const vals = [];
        const grab = (tags) => Object.values(tags || {}).forEach(v => vals.push(String(v)));
        grab(j.format?.tags);
        (j.streams || []).forEach(s => grab(s.tags));
        resolve(vals.join(' | '));
      } catch { resolve(''); }
    });
  });
}

function metadataSignals(meta = {}, fileTags = '') {
  const hits = [];
  const text = [meta.title, meta.description, meta.uploader, meta.channel, meta.track, meta.artist, (meta.tags || []).join(' '), fileTags].filter(Boolean).join('\n');
  if (text) {
    for (const [t, re] of LABEL_RE) if (re.test(text)) hits.push({ points: 70, why: `Major-label music (Universal / Warner): “${t}”` });
    for (const [t, re] of HARD_RE) if (re.test(text)) hits.push({ points: 70, why: `Source mentions “${t}” (broadcast / official content)` });
    for (const [t, re] of MED_RE) {
      if (!re.test(text)) continue;
      hits.push(OFFICIAL_STREAM.test(text)
        ? { points: 70, why: `Looks like an official stream of “${t}”` }
        : { points: 35, why: `Source mentions “${t}” (rights-holder content)` });
    }
  }
  if (OTHER_APP_TAGS.test(fileTags) || OTHER_APP_TAGS.test(meta.uploader || '')) hits.push({ points: 30, why: 'File or source carries another app’s watermark/tag' });
  if (meta.track || meta.artist) hits.push({ points: 20, why: `Licensed music detected (${[meta.artist, meta.track].filter(Boolean).join(' – ')})` });
  if (meta.license && !/creative commons|cc[- ]by/i.test(meta.license)) hits.push({ points: 10, why: `Source license: ${meta.license}` });
  if (Number(meta.duration) > 180) hits.push({ points: 20, why: 'Long clip (over 3 minutes) — likely a full upload' });
  return hits;
}

// ── vision signals (Gemini, a few frames) ────────────────────────────────────
async function visionSignals(videoPath) {
  if (!videoPath || !process.env.GEMINI_API_KEY) return [];
  try {
    const { extractFrames } = require('./videoProcessor');
    const all = await extractFrames(videoPath, 6);   // shared with the caption writer (one ffmpeg run)
    const frames = all.length > 4 ? [0, 1, 3, 5].map(i => all[i]).filter(Boolean) : all;
    if (!frames.length) return [];
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
    const r = await model.generateContent([
      ...frames.map(data => ({ inlineData: { mimeType: 'image/jpeg', data } })),
      { text: 'These are frames from one video. Report ONLY what is clearly visible. Do not identify people by face. Return ONLY JSON: {"watermark_or_logo":"name or empty","broadcast_graphics":false,"sports_footage":false,"tv_or_movie_footage":false,"named_live_event":"name or empty","other_app_watermark":"tiktok|snapchat|other|empty","concert_or_performance":false}' }
    ]);
    const m = r.response.text().replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) return [];
    const v = JSON.parse(m[0]);
    const out = [];
    if (v.broadcast_graphics) out.push({ points: 40, why: 'Broadcast graphics visible (scorebug / channel overlay)' });
    if (v.sports_footage) out.push({ points: 45, why: 'Sports broadcast footage' });
    if (v.tv_or_movie_footage) out.push({ points: 25, why: 'Looks like TV or movie footage' });
    if (v.named_live_event) out.push({ points: 30, why: `Live event visible: ${String(v.named_live_event).slice(0, 60)}` });
    if (v.watermark_or_logo) out.push({ points: 30, why: `Watermark/logo visible: ${String(v.watermark_or_logo).slice(0, 60)}` });
    if (v.other_app_watermark) out.push({ points: 30, why: `${String(v.other_app_watermark).slice(0, 30)} watermark visible` });
    if (v.concert_or_performance) out.push({ points: 15, why: 'Live music performance (audio is likely licensed)' });
    return out;
  } catch (e) {
    logger.warn('Guard vision check skipped: ' + e.message);
    return [];
  }
}

// ── label lookup (text only) ─────────────────────────────────────────────────
// Asks Gemini which label group owns the song named in the source text / transcript.
// It cannot hear the audio, so a song that is not named anywhere in the text is not caught here.
async function labelSignals(meta = {}, transcript = '') {
  if (!process.env.GEMINI_API_KEY) return [];
  const text = [meta.artist && `Artist: ${meta.artist}`, meta.track && `Track: ${meta.track}`, meta.title && `Title: ${meta.title}`,
    meta.description && `Caption: ${String(meta.description).slice(0, 1200)}`, (meta.tags || []).length && `Tags: ${meta.tags.join(', ')}`,
    transcript && `Words heard in the audio: ${String(transcript).slice(0, 1500)}`].filter(Boolean).join('\n');
  if (text.length < 8) return [];
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
    const r = await model.generateContent({ contents: [{ role: 'user', parts: [{ text:
      'Below is the text that came with a short video. If it names a specific song or recording that is probably playing in the video (or the words heard are clearly the lyrics of a known song), identify the recording and say which record company group owns the master recording today. ' +
      'Use only what you are reasonably sure of. Do not guess from the artist alone if the artist has moved labels or is independent.\n\n' + text +
      '\n\nReturn ONLY JSON: {"song_identified":false,"artist":"","track":"","label_group":"UMG|WMG|SONY|other|unknown","confidence":"high|medium|low"}' }] }] });
    const m = r.response.text().replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) return [];
    const v = JSON.parse(m[0]);
    const g = String(v.label_group || '').toUpperCase();
    if (v.song_identified && (g === 'UMG' || g === 'WMG') && /high|medium/i.test(v.confidence || '')) {
      const name = [v.artist, v.track].filter(Boolean).join(' – ').slice(0, 80) || 'a known song';
      return [{ points: 70, why: `Music looks like ${name} (${g === 'UMG' ? 'Universal Music Group' : 'Warner Music Group'})` }];
    }
    return [];
  } catch (e) {
    logger.warn('Guard label check skipped: ' + e.message);
    return [];
  }
}

function build(hits, credit) {
  // Strongest signals first; sum is capped so one thing can't exceed 100
  const sorted = [...hits].sort((a, b) => b.points - a.points);
  const seen = new Set();
  const reasons = [];
  let score = 0;
  for (const h of sorted) { if (seen.has(h.why)) continue; seen.add(h.why); reasons.push(h.why); score += h.points; }
  score = Math.min(100, score);
  return { level: levelFor(score), score, reasons, credit: credit || null };
}

// Coachella-only check: source text, link and words heard in the audio, plus a quick look at a few frames for Coachella branding.
async function coachellaVision(videoPath) {
  if (!videoPath || !process.env.GEMINI_API_KEY) return [];
  try {
    const { extractFrames } = require('./videoProcessor');
    const all = await extractFrames(videoPath, 6);
    const frames = all.length > 4 ? [0, 1, 3, 5].map(i => all[i]).filter(Boolean) : all;
    if (!frames.length) return [];
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
    const r = await model.generateContent([
      ...frames.map(data => ({ inlineData: { mimeType: 'image/jpeg', data } })),
      { text: 'These are frames from one video. Is the Coachella festival clearly identifiable (a Coachella logo, stage signage, banner, or on-screen text that reads Coachella)? Report ONLY what is clearly visible. Return ONLY JSON: {"coachella_visible":false}' }
    ]);
    const m = r.response.text().replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (m && JSON.parse(m[0]).coachella_visible === true) return [{ points: 100, why: 'Coachella branding visible in the video', coachella: true }];
  } catch (e) { logger.warn('Coachella vision check skipped: ' + e.message); }
  return [];
}

function coachellaTextHits(meta = {}, fileTags = '', url = '', transcript = '') {
  const text = [meta.title, meta.description, meta.uploader, meta.channel, meta.track, meta.artist, (meta.tags || []).join(' '), fileTags, url, transcript].filter(Boolean).join('\n');
  return COACHELLA_RE.test(text) ? [{ points: 100, why: 'Coachella content', coachella: true }] : [];
}

/** Main entry. Never throws: a failed check returns 'clear' with a note rather than stopping posts. */
async function assessClip({ videoPath, meta = {}, url = '', isRepost = false, credit = null, transcript = '' }) {
  try {
    if (GUARD_MODE === 'coachella') {
      const fileTags = await probeTags(videoPath);
      const textHits = coachellaTextHits(meta, fileTags, url, transcript);
      const hits = textHits.length ? textHits : await coachellaVision(videoPath);   // skip the frame check when the text already says Coachella
      return build(hits, credit);
    }
    const [fileTags, vision, label] = await Promise.all([probeTags(videoPath), visionSignals(videoPath), labelSignals(meta, transcript)]);
    const hits = [...metadataSignals(meta, fileTags), ...vision, ...label];
    return build(hits, credit);
  } catch (e) {
    logger.warn('Guard check failed, not blocking: ' + e.message);
    return { level: 'clear', score: 0, reasons: [], credit: credit || null };
  }
}

/** Add one more reason to an existing result (e.g. the on-screen text check) and re-level it. */
function addReason(guard, why, points) {
  if (!guard) return guard;
  const reasons = [...(guard.reasons || [])];
  if (!reasons.includes(why)) reasons.push(why);
  const score = Math.min(100, (guard.score || 0) + points);
  return { ...guard, reasons, score, level: levelFor(score) };
}

function parseReasons(row) {
  try { const r = JSON.parse(row?.guard_reasons || '[]'); return Array.isArray(r) ? r : []; } catch { return []; }
}

/** For publish/schedule routes and the scheduler. Returns null when allowed. */
function gateDecision(row, body = {}) {
  const level = row?.guard_level;
  if (!level || level === 'clear') return null;
  // Coachella-only mode: older posts that were held for other reasons (labels, broadcasters, ...) are allowed now
  if (GUARD_MODE === 'coachella' && !parseReasons(row).some(r => COACHELLA_RE.test(r))) return null;
  const why = parseReasons(row).join('; ') || 'risk detected';
  return { status: 422, error: `Blocked by the safety check: ${why}` };   // any non-clear result (incl. old 'review' rows) does not post
}

module.exports = { GUARD_MODE, assessClip, labelSignals, LABEL_TERMS, extractCredit, addReason, gateDecision, metadataSignals, build, levelFor, HARD_TERMS, MEDIUM_TERMS, BLOCK_AT, REVIEW_AT };
