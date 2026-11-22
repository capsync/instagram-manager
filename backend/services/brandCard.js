// Renders the "tweet-style" brand card (avatar, name, verified badge, @handle, text) to a PNG,
// and computes where the card and the video sit on the 1080x1920 canvas.
// Uses @napi-rs/canvas (Skia) so colour emoji, text wrapping and the circular avatar render properly.
const fs = require('fs');
const path = require('path');

let canvasLib = null;
function lib() {
  if (!canvasLib) canvasLib = require('@napi-rs/canvas');
  return canvasLib;
}

// ── Fonts ─────────────────────────────────────────────────────────────────────
const FONT_DIRS = ['/usr/share/fonts/truetype', '/usr/share/fonts/opentype', '/usr/share/fonts'];
function findFont(names) {
  for (const dir of [process.env.CARD_FONT_DIR, ...FONT_DIRS].filter(Boolean)) {
    for (const n of names) {
      const direct = path.join(dir, n);
      if (fs.existsSync(direct)) return direct;
      for (const sub of ['liberation', 'dejavu', 'noto']) {
        const p = path.join(dir, sub, n);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

let fontsReady = false;
let SANS = 'sans-serif';
let INTER = false;
let FIG = false;
function setupFonts() {
  if (fontsReady) return;
  fontsReady = true;
  const { GlobalFonts } = lib();
  const reg = findFont(['LiberationSans-Regular.ttf']);
  const bold = findFont(['LiberationSans-Bold.ttf']);
  if (reg && bold) {
    GlobalFonts.registerFromPath(reg, 'CardSans');
    GlobalFonts.registerFromPath(bold, 'CardSans');
    SANS = 'CardSans';
  } else {
    const dj = findFont(['DejaVuSans.ttf']);
    const djb = findFont(['DejaVuSans-Bold.ttf']);
    if (dj) { GlobalFonts.registerFromPath(dj, 'CardSans'); SANS = 'CardSans'; }
    if (djb) GlobalFonts.registerFromPath(djb, 'CardSans');
  }
  // Inter = clean iPhone/Instagram-style sans (open licence). Comes from the @fontsource/inter package; if missing we fall back to Liberation.
  try {
    for (const w of [400, 600, 700]) {
      const f = require.resolve(`@fontsource/inter/files/inter-latin-${w}-normal.woff`);
      GlobalFonts.registerFromPath(f, 'CardInter');
    }
    INTER = true;
  } catch { INTER = false; }
  // One font name per weight: the tweet/headline pieces need a true 400 (regular) and a true 700 (bold)
  try {
    for (const w of [400, 600, 700]) GlobalFonts.registerFromPath(require.resolve(`@fontsource/inter/files/inter-latin-${w}-normal.woff`), `CardInterW${w}`);
  } catch { /* falls back to the shared family */ }
  try {
    for (const w of [600, 700]) GlobalFonts.registerFromPath(require.resolve(`@fontsource/figtree/files/figtree-latin-${w}-normal.woff`), `CardFigW${w}`);
  } catch { /* falls back */ }
  // Geist = closest free match to the tweet font (name, handle and comment)
  try {
    for (const w of [400, 500, 700]) GlobalFonts.registerFromPath(require.resolve(`@fontsource/geist/files/geist-latin-${w}-normal.woff`), `CardGeistW${w}`);
  } catch { /* falls back to Inter */ }
  // Figtree = clean geometric bold, close to the headline font on theme pages (open licence, @fontsource/figtree)
  try {
    for (const w of [600, 700]) {
      GlobalFonts.registerFromPath(require.resolve(`@fontsource/figtree/files/figtree-latin-${w}-normal.woff`), 'CardFig');
    }
    FIG = true;
  } catch { FIG = false; }
  const emoji = process.env.EMOJI_FONT_PATH || findFont(['NotoColorEmoji.ttf']);
  if (emoji && fs.existsSync(emoji)) GlobalFonts.registerFromPath(emoji, 'CardEmoji');
}
const twStack = (px, weight) => `${px}px "CardGeistW${weight}", "CardInterW${weight}", ${INTER ? '"CardInter", ' : ''}"${SANS}", "CardEmoji", "Noto Color Emoji", sans-serif`;
const headStack = (px, weight = 700) => `${px}px "CardFigW${weight}", ${FIG ? '"CardFig", ' : ''}"CardInterW${weight}", ${INTER ? '"CardInter", ' : ''}"${SANS}", "CardEmoji", "Noto Color Emoji", sans-serif`;
const figStack = (px, weight) => `${weight || 700} ${px}px ${FIG ? '"CardFig", ' : ''}${INTER ? '"CardInter", ' : ''}"${SANS}", "CardEmoji", "Noto Color Emoji", sans-serif`;
// weight: true = 700, false = 400, or a number (600 = the semibold used for the main text)
const fontStack = (px, weight) => `${weight === true ? 700 : (weight || 400)} ${px}px ${INTER ? '"CardInter", ' : ''}"${SANS}", "CardEmoji", "Noto Color Emoji", sans-serif`;

// ── Themes ────────────────────────────────────────────────────────────────────
// Borderless "tweet" look: text sits directly on the canvas colour (black for dark, white for light).
const THEMES = {
  dark:  { canvas: '#000000', name: '#ffffff', handle: '#71767b', text: '#ffffff', avatarBg: '#2f3336' },
  light: { canvas: '#ffffff', name: '#0f1419', handle: '#536471', text: '#0f1419', avatarBg: '#cfd9de' }
};
const BADGE_BLUE = '#1d9bf0';

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const MARGIN = 64;                       // left/right margin shared by the card and the video
const CONTENT_W = CANVAS_W - MARGIN * 2; // 952
const CARD_W = CONTENT_W;

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawVerifiedBadge(ctx, cx, cy, size) {
  const side = size * 0.74;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = BADGE_BLUE;
  for (const rot of [0, Math.PI / 4]) {          // two rounded squares = 8-point seal
    ctx.save();
    ctx.rotate(rot);
    roundRectPath(ctx, -side / 2, -side / 2, side, side, side * 0.3);
    ctx.fill();
    ctx.restore();
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = size * 0.11;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-size * 0.17, size * 0.01);
  ctx.lineTo(-size * 0.04, size * 0.15);
  ctx.lineTo(size * 0.2, -size * 0.14);
  ctx.stroke();
  ctx.restore();
}

// Wrap text to a pixel width. Handles explicit newlines, long words and emoji (grapheme-safe via Array.from).
function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).replace(/\r/g, '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (let word of words) {
      while (ctx.measureText(word).width > maxW) {      // break a single over-long word
        const chars = Array.from(word);
        let cut = chars.length - 1;
        while (cut > 1 && ctx.measureText(chars.slice(0, cut).join('')).width > maxW) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(chars.slice(0, cut).join(''));
        word = chars.slice(cut).join('');
      }
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxW) line = test;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// ── Reuse: the page header (avatar, name, badge, @handle) never changes for a page, so draw it ONCE and keep it.
// Whole finished cards are kept too, so identical text (campaign lines) is not redrawn either.
const crypto = require('crypto');
const headerCache = new Map();
const cardCache = new Map();
const sha = (x) => crypto.createHash('sha1').update(String(x)).digest('hex');
function remember(map, key, val, max) {
  map.set(key, val);
  if (map.size > max) map.delete(map.keys().next().value);
  return val;
}
async function getHeader(o, th, d) {
  const key = sha([o.name, o.handle, o.verified ? 1 : 0, o.avatar || '', o.theme || 'dark', d.k].join('|'));
  if (headerCache.has(key)) return headerCache.get(key);
  const { createCanvas, loadImage } = lib();
  const { AV, GAP, NAME_PX, HANDLE_PX, k } = d;
  const canvas = createCanvas(CARD_W, AV + 8);
  const ctx = canvas.getContext('2d');
  // avatar
ctx.save();
ctx.beginPath(); ctx.arc(AV / 2, AV / 2, AV / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
let drewAvatar = false;
if (o.avatar) {
  try {
    const raw = String(o.avatar).replace(/^data:image\/\w+;base64,/, '');
    const img = await loadImage(Buffer.from(raw, 'base64'));
    const sc = Math.max(AV / img.width, AV / img.height);        // cover-crop
    const w = img.width * sc, h = img.height * sc;
    ctx.drawImage(img, (AV - w) / 2, (AV - h) / 2, w, h);
    drewAvatar = true;
  } catch { /* fall through to initial */ }
}
if (!drewAvatar) {
  ctx.fillStyle = th.avatarBg; ctx.fillRect(0, 0, AV, AV);
  ctx.fillStyle = th.name; ctx.font = fontStack(Math.round(52 * k), true);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText((String(o.name || o.handle || '?').trim()[0] || '?').toUpperCase(), AV / 2, AV / 2 + 3);
}
ctx.restore();

// name + badge + handle (vertically centred next to the avatar)
const tx = AV + GAP;
ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
ctx.font = fontStack(NAME_PX, true);
const badge = Math.round(NAME_PX * 1.0);
const maxNameW = CARD_W - tx - (o.verified ? badge + 16 : 0);
const rawName = String(o.name || '').trim();
let nameStr = rawName;
while (nameStr.length > 1 && ctx.measureText(nameStr).width > maxNameW) nameStr = nameStr.slice(0, -1);
if (nameStr !== rawName) nameStr = nameStr.replace(/\s*\S?$/, '') + '…';
const nameBase = Math.round(AV / 2 - 4 * k);
ctx.fillStyle = th.name;
ctx.fillText(nameStr, tx, nameBase);
if (o.verified) {
  const nw = ctx.measureText(nameStr).width;
  drawVerifiedBadge(ctx, tx + nw + 12 + badge / 2, nameBase - NAME_PX * 0.32, badge);
}
ctx.font = fontStack(HANDLE_PX, false);
ctx.fillStyle = th.handle;
ctx.fillText(`@${String(o.handle || '').replace(/^@+/, '')}`, tx, nameBase + Math.round(HANDLE_PX * 1.35));
  return remember(headerCache, key, canvas, 40);
}

/**
 * @param {{name:string, handle:string, verified?:boolean, avatar?:string, text:string, theme?:'dark'|'light', scale?:number}} o
 *        avatar = base64 data URL or raw base64 of a PNG/JPEG; scale = 0.8–1.5 (card size)
 * @returns {Promise<{buffer:Buffer, width:number, height:number}>}  transparent PNG, 952px wide
 */
async function renderCard(o) {
  const ckey = sha([!!o.plain, !!o.subtitle, o.name, o.handle, o.verified ? 1 : 0, o.avatar || '', o.theme || 'dark', o.scale || 1, o.text || ''].join('|'));
  if (cardCache.has(ckey)) return cardCache.get(ckey);
  const out = await renderCardUncached(o);
  return remember(cardCache, ckey, out, 60);
}

async function renderSubtitle(o) {
  // Cinema-page look: centred bold white text with a dark outline, drawn over the video (transparent PNG).
  setupFonts();
  const { createCanvas } = lib();
  const PX = 46, LINE = 60;
  const probe = createCanvas(10, 10).getContext('2d');
  probe.font = fontStack(PX, 700);
  let lines = wrapText(probe, String(o.text || '').trim(), CARD_W - 40).slice(0, 3);
  const h = lines.length * LINE + 20;
  const canvas = createCanvas(CARD_W, h);
  const ctx = canvas.getContext('2d');
  ctx.font = fontStack(PX, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round'; ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.fillStyle = '#ffffff';
  lines.forEach((ln, i) => { const y = Math.round(PX * 0.95) + 6 + i * LINE; ctx.strokeText(ln, CARD_W / 2, y); ctx.fillText(ln, CARD_W / 2, y); });
  return { buffer: canvas.toBuffer('image/png'), width: CARD_W, height: h, canvasColor: '#000000' };
}

async function renderCardUncached(o) {
  if (o.subtitle && String(o.text || '').trim()) return renderSubtitle(o);
  setupFonts();
  const { createCanvas, loadImage } = lib();
  const th = THEMES[o.theme] || THEMES.dark;
  const plain = !!o.plain;            // text only: no avatar / name / handle
  const k = Math.min(1.5, Math.max(0.8, Number(o.scale) || 1));
  const AV = Math.round(112 * k), GAP = Math.round(22 * k);
  const NAME_PX = Math.round(38 * k), HANDLE_PX = Math.round(29 * k), TEXT_PX = Math.round(46 * k), LINE_H = Math.round(58 * k);
  const MAX_LINES = 8;

  const probe = createCanvas(10, 10).getContext('2d');
  probe.font = fontStack(TEXT_PX, 600);
  let lines = wrapText(probe, (o.text || '').trim(), CARD_W);
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    lines[MAX_LINES - 1] = lines[MAX_LINES - 1].replace(/\s*\S{0,3}$/, '') + '…';
  }
  if (plain && !(o.text || '').trim()) {   // nothing to show: tiny transparent image, zero height
    return { buffer: createCanvas(CARD_W, 2).toBuffer('image/png'), width: CARD_W, height: 0, canvasColor: th.canvas };
  }
  const textTop = plain ? 0 : AV + Math.round(26 * k);
  const height = textTop + lines.length * LINE_H + 6;

  const canvas = createCanvas(CARD_W, height);
  const ctx = canvas.getContext('2d');

  if (!plain) {
    const hdr = await getHeader(o, th, { k, AV, GAP, NAME_PX, HANDLE_PX });
    ctx.drawImage(hdr, 0, 0);
  }

  // text
  ctx.font = fontStack(TEXT_PX, 600);
  ctx.fillStyle = th.text;
  lines.forEach((ln, i) => ctx.fillText(ln, 0, textTop + Math.round(TEXT_PX * 0.95) + i * LINE_H));

  return { buffer: canvas.toBuffer('image/png'), width: CARD_W, height, canvasColor: th.canvas };
}

/**
 * Where everything sits on the 1080x1920 canvas.
 * Card + video are stacked as one group and centred vertically (card upper-middle, video lower-middle).
 * offsetY (px, + = lower) moves the whole group.
 */
function computeLayout({ cardH, srcW, srcH, offsetY = 0 }) {
  const SAFE_TOP = 110, SAFE_BOTTOM = 170, GAP = cardH > 0 ? 24 : 0;
  const availH = CANVAS_H - SAFE_TOP - SAFE_BOTTOM - cardH - GAP;
  const s = Math.min(CONTENT_W / srcW, availH / srcH);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const vidW = even(srcW * s), vidH = even(srcH * s);
  const groupH = cardH + GAP + vidH;
  const centred = Math.round((CANVAS_H - groupH) / 2) + (Number(offsetY) || 0);
  const top = Math.min(Math.max(40, centred), CANVAS_H - groupH - 40);
  return {
    canvasW: CANVAS_W, canvasH: CANVAS_H,
    cardX: MARGIN, cardY: top,
    vidW, vidH, vidX: MARGIN + Math.round((CONTENT_W - vidW) / 2), vidY: top + cardH + GAP
  };
}

// ── "Reaction" layout pieces (exact tweet look) ───────────────────────────────────────────────────────────────
const TW_HEAD_X = 76, TW_HEAD_W = CANVAS_W - 2 * TW_HEAD_X;   // headline: 76px side margins
const TW_CARD_X = 150, TW_CARD_W = 780;                        // tweet card sits inset under the full-width video
const twThemes = {
  light: { name: '#0f1419', handle: '#536471', text: '#0f1419', icon: '#536471' },
  dark:  { name: '#e7e9ea', handle: '#71767b', text: '#e7e9ea', icon: '#71767b' }
};

/** Headline above the video: bold geometric sans, left aligned. */
async function renderHeadlineCard({ text, theme = 'light', scale = 1 }) {
  setupFonts();
  const { createCanvas } = lib();
  const th = THEMES[theme] || THEMES.light;
  const k = Math.min(1.4, Math.max(0.8, Number(scale) || 1));
  const PX = Math.round(44 * k), LINE = Math.round(53 * k);
  const t = String(text || '').trim();
  if (!t) return { buffer: createCanvas(TW_HEAD_W, 2).toBuffer('image/png'), width: TW_HEAD_W, height: 0, canvasColor: th.canvas };
  const probe = createCanvas(10, 10).getContext('2d');
  probe.font = headStack(PX, 700);
  let lines = wrapText(probe, t, TW_HEAD_W);
  if (lines.length > 4) { lines = lines.slice(0, 4); lines[3] = lines[3].replace(/\s*\S{0,3}$/, '') + '…'; }
  const h = lines.length * LINE + 8;
  const canvas = createCanvas(TW_HEAD_W, h);
  const ctx = canvas.getContext('2d');
  ctx.font = headStack(PX, 700); ctx.fillStyle = th.text; ctx.textBaseline = 'alphabetic';
  lines.forEach((ln, i) => ctx.fillText(ln, 0, Math.round(PX * 0.92) + i * LINE));
  return { buffer: canvas.toBuffer('image/png'), width: TW_HEAD_W, height: h, canvasColor: th.canvas };
}

const tweetCardCache = new Map();
/** A real-looking tweet: avatar, name, @handle, the small "no" icon + "…" on the right, then the text (regular weight). */
async function renderTweetCard(o) {
  const key = sha(['tw', o.name, o.handle, o.verified ? 1 : 0, o.avatar || '', o.theme || 'light', o.text || ''].join('|'));
  if (tweetCardCache.has(key)) return tweetCardCache.get(key);
  setupFonts();
  const { createCanvas, loadImage } = lib();
  const th = THEMES[o.theme] || THEMES.light, tt = twThemes[o.theme] || twThemes.light;
  const W = TW_CARD_W, AV = 80, GAP = 18, NAME_PX = 29, HANDLE_PX = 26, TEXT_PX = 32, LINE = 45;

  const probe = createCanvas(10, 10).getContext('2d');
  probe.font = twStack(TEXT_PX, 400);
  let lines = wrapText(probe, String(o.text || '').trim(), W);
  if (lines.length > 5) { lines = lines.slice(0, 5); lines[4] = lines[4].replace(/\s*\S{0,3}$/, '') + '…'; }
  const textTop = AV + 26;
  const height = textTop + lines.length * LINE + 10;
  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext('2d');

  // avatar
  ctx.save();
  ctx.beginPath(); ctx.arc(AV / 2, AV / 2, AV / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
  let drew = false;
  if (o.avatar) {
    try {
      const img = await loadImage(Buffer.from(String(o.avatar).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      const sc = Math.max(AV / img.width, AV / img.height);
      ctx.drawImage(img, (AV - img.width * sc) / 2, (AV - img.height * sc) / 2, img.width * sc, img.height * sc);
      drew = true;
    } catch { /* initial below */ }
  }
  if (!drew) {
    ctx.fillStyle = th.avatarBg; ctx.fillRect(0, 0, AV, AV);
    ctx.fillStyle = tt.name; ctx.font = twStack(36, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((String(o.name || o.handle || '?').trim()[0] || '?').toUpperCase(), AV / 2, AV / 2 + 2);
  }
  ctx.restore();

  // name + handle
  const tx = AV + GAP;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = twStack(NAME_PX, 700); ctx.fillStyle = tt.name;
  let nameStr = String(o.name || '').trim();
  const maxNameW = W - tx - 150 - (o.verified ? 32 : 0);
  while (nameStr.length > 1 && ctx.measureText(nameStr).width > maxNameW) nameStr = nameStr.slice(0, -1);
  ctx.fillText(nameStr, tx, 34);
  if (o.verified) drawVerifiedBadge(ctx, tx + ctx.measureText(nameStr).width + 9 + 15, 34 - 10, 30);
  ctx.font = twStack(HANDLE_PX, 400); ctx.fillStyle = tt.handle;
  ctx.fillText(`@${String(o.handle || '').replace(/^@+/, '')}`, tx, 68);

  // right side icons: "no" circle + three dots
  const cy = 25;
  ctx.strokeStyle = tt.icon; ctx.lineWidth = 2.8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(W - 106, cy, 10.5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W - 106 - 16, cy + 16); ctx.lineTo(W - 106 + 16, cy - 16); ctx.stroke();
  ctx.fillStyle = tt.icon;
  for (const dx of [52, 40, 28]) { ctx.beginPath(); ctx.arc(W - dx, cy, 3, 0, Math.PI * 2); ctx.fill(); }

  // text: regular weight, like a real tweet
  ctx.font = twStack(TEXT_PX, 400); ctx.fillStyle = tt.text;
  lines.forEach((ln, i) => ctx.fillText(ln, 0, textTop + Math.round(TEXT_PX * 0.92) + i * LINE));

  const out = { buffer: canvas.toBuffer('image/png'), width: W, height, canvasColor: th.canvas };
  return remember(tweetCardCache, key, out, 60);
}

/**
 * "Reaction" layout: headline on top, FULL-WIDTH video in the middle, tweet card under it (all left-aligned like the
 * theme pages). Centred vertically as a group; offsetY (px, + = lower) moves it. Zero height = that part is absent.
 */
function computeLayoutTweet({ headH = 0, cardH = 0, srcW, srcH, offsetY = 0 }) {
  const SAFE_TOP = 110, SAFE_BOTTOM = 170, GH = 16, GC = 22;
  const gH = headH > 0 ? GH : 0, gC = cardH > 0 ? GC : 0;
  const availH = CANVAS_H - SAFE_TOP - SAFE_BOTTOM - headH - cardH - gH - gC;
  const s = Math.min(CANVAS_W / srcW, availH / srcH);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const vidW = even(srcW * s), vidH = even(srcH * s);
  const groupH = headH + gH + vidH + gC + cardH;
  const centred = Math.round((CANVAS_H - groupH) / 2) + (Number(offsetY) || 0);
  const top = Math.min(Math.max(40, centred), CANVAS_H - groupH - 40);
  const vidY = top + headH + gH;
  return {
    canvasW: CANVAS_W, canvasH: CANVAS_H,
    headX: TW_HEAD_X, headY: top,
    vidW, vidH, vidX: Math.round((CANVAS_W - vidW) / 2), vidY,
    cardX: TW_CARD_X, cardY: vidY + vidH + gC
  };
}

function canvasColorFor(theme) { return (THEMES[theme] || THEMES.dark).canvas; }

module.exports = { renderCard, renderHeadlineCard, renderTweetCard, computeLayout, computeLayoutTweet, canvasColorFor, CANVAS_W, CANVAS_H, CARD_W, MARGIN };
