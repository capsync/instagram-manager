const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { computeLayout, computeLayoutTweet } = require('./brandCard');

const THREADS = String(process.env.FFMPEG_THREADS || '1');

function getUploadDir() {
  return path.resolve(process.env.UPLOAD_DIR || './uploads');
}

// Run heavy ffmpeg work at low CPU priority (when `nice` exists) so the web app stays responsive while rendering.
const NICE = fs.existsSync('/usr/bin/nice') ? '/usr/bin/nice' : null;
// x264 speed for 'best' renders. Keep 'veryfast' on a 512MB server: slower presets use more memory and crashed it. Set RENDER_PRESET=faster only on a bigger instance.
const BEST_PRESET = ['ultrafast','superfast','veryfast','faster','fast','medium'].includes(process.env.RENDER_PRESET) ? process.env.RENDER_PRESET : 'veryfast';

// ── High-quality file size: "best" renders target a bitrate that lands the file around RENDER_TARGET_MB (default 50 MB),
// never below RENDER_MIN_MBPS (12) or above RENDER_MAX_MBPS (30) Mbps. Short clips hit the cap, long clips the floor.
// (Instagram re-encodes every upload anyway; a richer source just loses less.)
const TARGET_MB = Number(process.env.RENDER_TARGET_MB) || 50;
const MIN_MBPS  = Number(process.env.RENDER_MIN_MBPS) || 12;
const MAX_MBPS  = Number(process.env.RENDER_MAX_MBPS) || 30;
function bestRate(durationSec) {
  const d = Math.max(1, Number(durationSec) || 20);
  const total = Math.min(MAX_MBPS, Math.max(MIN_MBPS, (TARGET_MB * 8) / d));
  const v = Math.max(4, total - 0.2);   // leave room for the 192k audio
  return ['-b:v', `${v.toFixed(1)}M`, '-maxrate', `${(v * 1.4).toFixed(1)}M`, '-bufsize', `${(v * 2.5).toFixed(1)}M`];
}
async function effectiveDuration(inputPath, trim, speed) {
  const full = await getVideoDuration(inputPath);
  const ts = Number(trim?.start) || 0, te = Number(trim?.end) || 0;
  const len = (te > ts && te > 0 ? te : full) - ts;
  return Math.max(1, len / (Number(speed) > 0 ? Number(speed) : 1));
}
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS) || 15 * 60 * 1000;   // slow CPUs need more than 5 minutes

function runFFmpeg(args, label) {
  return new Promise((resolve, reject) => {
    logger.info(`ffmpeg [${label}] starting`);
    const [cmd, cmdArgs] = NICE ? [NICE, ['-n', '10', 'ffmpeg', ...args]] : ['ffmpeg', args];
    execFile(cmd, cmdArgs, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err) => {
      if (err) {
        logger.error(`ffmpeg [${label}] failed: ${err.message}`);
        return reject(new Error(`ffmpeg ${label} failed: ${err.message}`));
      }
      logger.info(`ffmpeg [${label}] complete`);
      resolve();
    });
  });
}

function writeSRTFile(srtContent, videoPath) {
  const srtPath = videoPath.replace(/\.[^/.]+$/, '.srt');
  fs.writeFileSync(srtPath, srtContent, 'utf8');
  return srtPath;
}

// Turns the frame editor's fractions (left/right/top/bottom of the original frame + zoom) into ffmpeg crop filters.
function frameCrop(W, H, fr) {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const left = clamp(Number(fr.left) || 0, 0, 0.9);
  const right = clamp(fr.right === undefined ? 1 : Number(fr.right), left + 0.05, 1);
  const top = clamp(Number(fr.top) || 0, 0, 0.9);
  const bottom = clamp(fr.bottom === undefined ? 1 : Number(fr.bottom), top + 0.05, 1);
  const cw = even((right - left) * W), ch = even((bottom - top) * H);
  let cx = Math.min(Math.round(left * W), W - cw), cy = Math.min(Math.round(top * H), H - ch);
  cx = Math.max(0, cx - (cx % 2)); cy = Math.max(0, cy - (cy % 2));   // even offsets keep chroma aligned
  const filters = [];
  if (cw !== W || ch !== H) filters.push(`crop=${cw}:${ch}:${cx}:${cy}`);
  let w = cw, h = ch;
  const z = clamp(Number(fr.zoom) || 1, 1, 3);
  if (z > 1.001) { w = even(cw / z); h = even(ch / z); filters.push(`crop=${w}:${h}`); }   // centred zoom
  return { filters, w, h };
}

// Finds the real picture inside black bars (letterbox/pillarbox). Returns fractions of the frame, or null.
async function detectBarsRect(videoPath) {
  const dims = await getVideoDimensions(videoPath);
  const stderr = await new Promise((resolve) => {
    const cmdArgs = ['-hide_banner', '-ss', '0.3', '-t', '3', '-i', videoPath, '-vf', 'fps=2,scale=trunc(iw/4)*2:trunc(ih/4)*2,cropdetect=limit=24:round=2:reset=0', '-an', '-f', 'null', '-'];
    const [cmd, a] = NICE ? [NICE, ['-n', '10', 'ffmpeg', ...cmdArgs]] : ['ffmpeg', cmdArgs];
    execFile(cmd, a, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => resolve(String(se || '')));
  });
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!all.length) return null;
  const [w, h, x, y] = all[all.length - 1].slice(1).map(Number);
  const W = Math.trunc(dims.width / 4) * 2, H = Math.trunc(dims.height / 4) * 2;   // detection ran on a quarter-size picture; fractions stay valid
  if (!w || !h || w < 0.2 * W || h < 0.08 * H || w * h < 0.06 * W * H) return null;   // implausibly small (very dark video) — ignore
  if (w >= W * 0.98 && h >= H * 0.98) return null;                  // no bars
  // tiny trims are noise: snap to the full frame
  const full = (v, total) => v >= 0.97 * total;
  const nx = full(w, W) ? 0 : x, nw = full(w, W) ? W : w;
  const ny = full(h, H) ? 0 : y, nh = full(h, H) ? H : h;
  return { x: nx / W, y: ny / H, w: nw / W, h: nh / H };
}

// Up to `count` small JPEG frames spread through the video. Only key frames are decoded, so this is quick even on a slow CPU.
async function extractFramesRaw(videoPath, count = 6) {
  const dir = fs.mkdtempSync(path.join(getUploadDir(), 'frames_'));
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-skip_frame', 'nokey', '-i', videoPath,
      '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,2.5)',scale=640:-2", '-vsync', 'vfr', '-frames:v', String(count), '-q:v', '5', path.join(dir, 'f_%02d.jpg')];
    const [cmd, a] = NICE ? [NICE, ['-n', '10', 'ffmpeg', ...args]] : ['ffmpeg', args];
    await new Promise((resolve, reject) => execFile(cmd, a, { timeout: 60000 }, (err) => (err ? reject(err) : resolve())));
    return fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort().map(f => fs.readFileSync(path.join(dir, f)).toString('base64'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Same clip + same count within a few minutes = one ffmpeg run (the caption writer and the safety check ask at the same time)
const frameCache = new Map();
function extractFrames(videoPath, count = 6) {
  let key = `${videoPath}|${count}`;
  try { const st = fs.statSync(videoPath); key += `|${st.size}|${Math.floor(st.mtimeMs)}`; } catch { /* let ffmpeg report it */ }
  if (!frameCache.has(key)) {
    const p = extractFramesRaw(videoPath, count);
    frameCache.set(key, p);
    p.catch(() => frameCache.delete(key));
    const t = setTimeout(() => frameCache.delete(key), 3 * 60 * 1000); if (t.unref) t.unref();
  }
  return frameCache.get(key);
}

// ── Find the real video inside a "template" reel ─────────────────────────────────────────────
// Many clips are a video in the middle of a black or white screen with static text above/below.
// Static things (background, text, avatars) never change between frames; the real video does.
// So: look at a few small frames, find where pixels change, and take that block.
const GRID_W = 270;   // analysis width (4 px per cell on a 1080 px frame)

function grabGrayFrames(videoPath, args, w, h) {
  return new Promise((resolve) => {
    const full = ['-hide_banner', '-loglevel', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
    const [cmd, a] = NICE ? [NICE, ['-n', '10', 'ffmpeg', ...full]] : ['ffmpeg', full];
    execFile(cmd, a, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
      if (err || !stdout || !stdout.length) return resolve([]);
      const size = w * h, n = Math.floor(stdout.length / size), frames = [];
      for (let i = 0; i < n; i++) frames.push(stdout.subarray(i * size, (i + 1) * size));
      resolve(frames);
    });
  });
}

// Largest run of "on" entries, allowing small gaps. `weight[i]` decides which run wins.
function bestRun(on, weight, maxGap) {
  let best = null, start = -1, last = -1, sum = 0;
  const close = () => { if (start >= 0 && (!best || sum > best.sum)) best = { start, end: last, sum }; };
  for (let i = 0; i < on.length; i++) {
    if (!on[i]) continue;
    if (start >= 0 && i - last - 1 <= maxGap) { last = i; sum += weight[i]; }
    else { close(); start = i; last = i; sum = weight[i]; }
  }
  close();
  return best;
}

function dynamicBox(frames, w, h) {
  const n = frames.length, px = w * h;
  const mean = new Float32Array(px), dev = new Float32Array(px);
  for (const f of frames) for (let i = 0; i < px; i++) mean[i] += f[i];
  for (let i = 0; i < px; i++) mean[i] /= n;
  for (const f of frames) for (let i = 0; i < px; i++) dev[i] += Math.abs(f[i] - mean[i]);
  const T = 4 * n;                                   // average change of ~4 grey levels = "moving"
  const rowCnt = new Float32Array(h);
  for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x++) if (dev[y * w + x] > T) c++; rowCnt[y] = c; }
  const rowOn = Array.from(rowCnt, c => c >= 0.10 * w);
  const rows = bestRun(rowOn, rowCnt, 3);
  if (!rows) return null;
  const bandH = rows.end - rows.start + 1;
  const colCnt = new Float32Array(w);
  for (let x = 0; x < w; x++) { let c = 0; for (let y = rows.start; y <= rows.end; y++) if (dev[y * w + x] > T) c++; colCnt[x] = c; }
  const cols = bestRun(Array.from(colCnt, c => c >= 0.15 * bandH), colCnt, 3);
  if (!cols) return null;
  return { x0: cols.start, x1: cols.end, y0: rows.start, y1: rows.end };
}

async function detectMainVideoRect(videoPath) {
  const dims = await getVideoDimensions(videoPath);
  const w = GRID_W, h = Math.max(2, Math.round((w * dims.height) / dims.width / 2) * 2);
  const scale = `scale=${w}:-2`;
  // 1) key frames only (cheap to decode, and a second or more apart so real video differs between them)
  let frames = await grabGrayFrames(videoPath, ['-skip_frame', 'nokey', '-i', videoPath, '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t,1)',${scale}`, '-vsync', 'vfr', '-frames:v', '8'], w, h);
  // 2) too few key frames (short clip): decode a couple of seconds instead
  if (frames.length < 3) frames = await grabGrayFrames(videoPath, ['-ss', '0.3', '-t', '2.5', '-i', videoPath, '-vf', `fps=2,${scale}`, '-frames:v', '5'], w, h);
  if (frames.length < 2) return null;
  const box = dynamicBox(frames, w, h);
  if (!box) return null;
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  if (bw < 0.2 * w || bh < 0.08 * h || bw * bh < 0.06 * w * h) return null;   // implausibly small
  if (bw >= 0.97 * w && bh >= 0.97 * h) return null;                           // already the whole frame
  const full = (v, total) => v >= 0.97 * total;
  return {
    x: full(bw, w) ? 0 : box.x0 / w, w: full(bw, w) ? 1 : bw / w,
    y: full(bh, h) ? 0 : box.y0 / h, h: full(bh, h) ? 1 : bh / h
  };
}

// Best guess at the real video: moving block first, plain black-bar trimming as a fallback.
async function detectContentRect(videoPath) {
  try {
    const r = await detectMainVideoRect(videoPath);
    if (r) return r;
  } catch (e) { logger.warn('Motion-based crop detection failed: ' + e.message); }
  return detectBarsRect(videoPath);
}

const dimsCache = new Map();
function getVideoDimensions(videoPath) {
  if (dimsCache.has(videoPath)) return dimsCache.get(videoPath);
  const p = getVideoDimensionsRaw(videoPath);
  dimsCache.set(videoPath, p);
  const t = setTimeout(() => dimsCache.delete(videoPath), 10 * 60 * 1000); if (t.unref) t.unref();
  return p;
}
function getVideoDimensionsRaw(videoPath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', videoPath], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve({ width: 1280, height: 720 });
      try {
        const stream = JSON.parse(stdout).streams[0];
        let w = stream.width || 1280, h = stream.height || 720;
        const rotRaw = stream.tags?.rotate ?? (stream.side_data_list || []).find(d => d.rotation !== undefined)?.rotation ?? 0;
        if (Math.abs(Number(rotRaw)) % 180 === 90) [w, h] = [h, w];   // ffmpeg auto-rotates, so use the displayed size
        resolve({ width: w, height: h });
      } catch { resolve({ width: 1280, height: 720 }); }
    });
  });
}

async function computeCropFilter(inputPath, cropRatio) {
  if (!cropRatio || cropRatio === 'none') return null;
  const parts = cropRatio.split('/').map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  const [tw, th] = parts;

  const { width, height } = await getVideoDimensions(inputPath);
  const targetAspect = tw / th;
  const currentAspect = width / height;

  let cropW, cropH, cropX, cropY;
  if (currentAspect > targetAspect) {
    cropH = height;
    cropW = Math.round(height * targetAspect);
    cropW -= cropW % 2;
    cropX = Math.round((width - cropW) / 2);
    cropY = 0;
  } else {
    cropW = width;
    cropH = Math.round(width / targetAspect);
    cropH -= cropH % 2;
    cropX = 0;
    cropY = Math.round((height - cropH) / 2);
  }

  if (cropW === width && cropH === height) return null;
  return `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
}

// Prefer an explicit bold font; fall back to fontconfig name so the OS can
// provide emoji fallback glyphs (Noto Color Emoji etc.) when available.
const FONT_FILE = (() => {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
})();
const FONT_ATTR = FONT_FILE ? `fontfile='${FONT_FILE}'` : `font='DejaVu Sans Bold'`;

const NAMED_POSITIONS = {
  'top-left':    { x: '20',            y: '20' },
  'top-center':  { x: '(w-text_w)/2', y: '20' },
  'top-right':   { x: 'w-text_w-20',  y: '20' },
  'mid-left':    { x: '20',            y: '(h-text_h)/2' },
  'mid-center':  { x: '(w-text_w)/2', y: '(h-text_h)/2' },
  'mid-right':   { x: 'w-text_w-20',  y: '(h-text_h)/2' },
  'bot-left':    { x: '20',            y: 'h-text_h-60' },
  'bot-center':  { x: '(w-text_w)/2', y: 'h-text_h-60' },
  'bot-right':   { x: 'w-text_w-20',  y: 'h-text_h-60' },
};

const SIZES = { small: 20, medium: 30, large: 44, xl: 60 };

function buildCoverBox(overlay) {
  const color = { white: 'white@1.0', light: 'white@0.82', dark: 'black@0.78', black: 'black@1.0', yellow: 'yellow@1.0' }[overlay.bg] || 'black@0.78';

  // Use exact pixel dimensions from the browser canvas (passed as vidW/vidH)
  const refW = overlay.vidW || null;
  const refH = overlay.vidH || null;

  let xExpr, yExpr, wExpr, hExpr;

  const hasBgSize = (overlay.bgW !== undefined && overlay.bgW !== null) ||
                    (overlay.coverWidthPct !== undefined);
  if (hasBgSize) {
    const bgWpct = overlay.bgW ?? overlay.coverWidthPct ?? 40;
    const bgHpct = overlay.bgH ?? overlay.coverHeightPct ?? 12;

    if (refW && refH) {
      // Absolute pixel values — exact 1:1 match with canvas
      const bw = Math.round(bgWpct / 100 * refW);
      const bh = Math.round(bgHpct / 100 * refH);
      const bx = Math.round(overlay.xPct / 100 * refW - bw / 2);
      const by = Math.round(overlay.yPct / 100 * refH - bh / 2);
      wExpr = bw; hExpr = bh; xExpr = bx; yExpr = by;
    } else {
      const xc   = (overlay.xPct / 100).toFixed(6);
      const yc   = (overlay.yPct / 100).toFixed(6);
      const wPct = (bgWpct / 100).toFixed(6);
      const hPct = (bgHpct / 100).toFixed(6);
      wExpr = `iw*${wPct}`;
      hExpr = `ih*${hPct}`;
      xExpr = `iw*${xc}-(${wExpr})/2`;
      yExpr = `ih*${yc}-(${hExpr})/2`;
    }
  } else {
    const size = overlay.fontSize || SIZES[overlay.size] || 44;
    const numSpaces = Math.max((overlay.text || '').length, 1);
    const boxW = Math.round(numSpaces * size * 0.5) + 20;
    const boxH = Math.round(size * 1.6);
    if (refW && refH) {
      xExpr = Math.round(overlay.xPct / 100 * refW - boxW / 2);
      yExpr = Math.round(overlay.yPct / 100 * refH - boxH / 2);
    } else if (overlay.xPct !== undefined && overlay.yPct !== undefined) {
      const xc = (overlay.xPct / 100).toFixed(6);
      const yc = (overlay.yPct / 100).toFixed(6);
      xExpr = `iw*${xc}-${Math.floor(boxW / 2)}`;
      yExpr = `ih*${yc}-${Math.floor(boxH / 2)}`;
    } else {
      const pos = NAMED_POSITIONS[overlay.position] || NAMED_POSITIONS['bot-center'];
      xExpr = pos.x;
      yExpr = pos.y;
    }
    wExpr = boxW;
    hExpr = boxH;
  }

  let filter = `drawbox=x=${xExpr}:y=${yExpr}:w=${wExpr}:h=${hExpr}:color=${color}:t=fill`;
  if (overlay.startTime > 0 || overlay.endTime > 0) {
    filter += `:enable='between(t,${overlay.startTime || 0},${overlay.endTime || 999})'`;
  }
  return filter;
}

function buildSingleLine(overlay, yOffsetExpr) {
  const size = overlay.fontSize || SIZES[overlay.size] || 44;
  const escaped = overlay.text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

  // Use exact pixel dimensions from the browser canvas (passed as vidW/vidH)
  const refW = overlay.vidW || null;
  const refH = overlay.vidH || null;
  const fontSizePct = overlay.fontSizePct || (size / 1080);

  let xExpr, yExpr;
  if (overlay.xPct !== undefined && overlay.yPct !== undefined) {
    if (refW && refH) {
      // Absolute pixel positions — exact 1:1 match with canvas preview
      const px = Math.round(overlay.xPct / 100 * refW);
      const py = Math.round(overlay.yPct / 100 * refH);
      xExpr = `${px}-(text_w/2)`;
      if (!yOffsetExpr || yOffsetExpr === 0) {
        yExpr = `${py}-(text_h/2)`;
      } else {
        // yOffsetExpr is like "0.5*w*0.096" — evaluate using refW
        const offsetPx = Math.round(eval(yOffsetExpr.replace(/w/g, refW)));
        yExpr = `${py + offsetPx}-(text_h/2)`;
      }
    } else {
      const xp = (Number(overlay.xPct) / 100).toFixed(6);
      const yp = (Number(overlay.yPct) / 100).toFixed(6);
      xExpr = `(w*${xp})-(text_w/2)`;
      const yBase = `(h*${yp})`;
      yExpr = (!yOffsetExpr || yOffsetExpr === 0)
        ? `${yBase}-(text_h/2)`
        : `${yBase}+(${yOffsetExpr})-(text_h/2)`;
    }
  } else {
    const pos = NAMED_POSITIONS[overlay.position] || NAMED_POSITIONS['bot-center'];
    xExpr = pos.x;
    yExpr = (!yOffsetExpr || yOffsetExpr === 0) ? pos.y : `(${pos.y})+(${yOffsetExpr})`;
  }

  let fontcolor, boxPart;
  if (overlay.bg === 'black') {
    fontcolor = 'white';
    boxPart = ':box=1:boxcolor=black:boxborderw=10';
  } else if (overlay.bg === 'white') {
    fontcolor = '#111111';
    boxPart = ':box=1:boxcolor=white:boxborderw=10';
  } else {
    const rawColor = overlay.textColor || overlay.colorHex || overlay.color;
    fontcolor = rawColor ? rawColor.replace('#', '0x') : 'white';
    boxPart = '';
  }

  // Use absolute font size in px if refW available — matches canvas exactly
  const fontSizeExpr = refW
    ? Math.round(fontSizePct * refW)
    : `w*${fontSizePct.toFixed(6)}`;

  let filter = `drawtext=${FONT_ATTR}:text='${escaped}':fontsize=${fontSizeExpr}:fontcolor=${fontcolor}${boxPart}:x=${xExpr}:y=${yExpr}`;
  if (overlay.startTime > 0 || overlay.endTime > 0) {
    filter += `:enable='between(t,${overlay.startTime || 0},${overlay.endTime || 999})'`;
  }
  return filter;
}

function buildDrawtext(overlay) {
  if (overlay.bg !== 'none' && (!overlay.text || overlay.text.trim() === '')) {
    return buildCoverBox(overlay);
  }
  if (!overlay.text || !overlay.text.trim()) return null;
  if (overlay.text.trim() === 'Tap to type') return n
