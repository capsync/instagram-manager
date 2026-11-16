// Finds the newest public video links of an Instagram / YouTube / TikTok account (via yt-dlp).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Instagram scanning uses ONLY its own throwaway account (env INSTAGRAM_SCAN_COOKIES_CONTENT).
// It never touches your page accounts' cookies. Set INSTAGRAM_SCAN=off to disable Instagram scanning completely.
const SCAN_COOKIE_FILE = path.join(require('os').tmpdir(), 'ig_scan_cookies.txt');
function scanCookieArgs() {
  const content = process.env.INSTAGRAM_SCAN_COOKIES_CONTENT;
  if (!content || !content.trim()) return null;
  try { fs.writeFileSync(SCAN_COOKIE_FILE, content.replace(/\\n/g, '\n'), { mode: 0o600 }); return ['--cookies', SCAN_COOKIE_FILE]; }
  catch { return null; }
}
const igScanOff = () => String(process.env.INSTAGRAM_SCAN || '').toLowerCase() === 'off';

const MAX_PER_ACCOUNT = 50;

/** "@name", "name", or a profile link  ->  { platform, handle, url } | null */
function parseAccount(raw, defaultPlatform) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t) || /^(www\.|m\.)?(instagram|youtube|tiktok)\.com\//i.test(t)) {
    let u; try { u = new URL(/^https?:/i.test(t) ? t : 'https://' + t); } catch { return null; }
    const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean);
    if (host === 'instagram.com' && seg[0] && !['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(seg[0]))
      return { platform: 'instagram', handle: seg[0], url: `https://www.instagram.com/${seg[0]}/` };
    if (host === 'tiktok.com' && seg[0] && seg[0].startsWith('@'))
      return { platform: 'tiktok', handle: seg[0].slice(1), url: `https://www.tiktok.com/${seg[0]}` };
    if (host === 'youtube.com') {
      const i = seg.findIndex(s => s.startsWith('@') || ['channel', 'c', 'user'].includes(s));
      if (i === -1) return null;
      const base = seg[i].startsWith('@') ? seg.slice(i, i + 1) : seg.slice(i, i + 2);
      const tab = seg.find(s => ['shorts', 'videos', 'streams'].includes(s)) || 'shorts';
      return { platform: 'youtube', handle: base.join('/'), url: `https://www.youtube.com/${base.join('/')}/${tab}` };
    }
    return null;
  }
  const handle = t.replace(/^@/, '').replace(/[^\w.\-]/g, '');
  if (!handle) return null;
  if (defaultPlatform === 'tiktok') return { platform: 'tiktok', handle, url: `https://www.tiktok.com/@${handle}` };
  if (defaultPlatform === 'youtube') return { platform: 'youtube', handle: '@' + handle, url: `https://www.youtube.com/@${handle}/shorts` };
  return { platform: 'instagram', handle, url: `https://www.instagram.com/${handle}/` };
}

function runYtDlp(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((stderr || err.message || 'yt-dlp failed').split('\n').filter(Boolean).pop().slice(0, 200)));
      resolve(stdout);
    });
  });
}

function entryUrl(e, platform) {
  let u = e.webpage_url || e.url || '';
  if (!/^https?:/.test(u) && e.id) {
    if (platform === 'youtube') u = `https://www.youtube.com/shorts/${e.id}`;
    else if (platform === 'instagram') u = `https://www.instagram.com/reel/${e.id}/`;
  }
  return /^https?:/.test(u) ? u : null;
}

async function findForAccount(acc, limit) {
  const base = ['--flat-playlist', '--dump-single-json', '--no-warnings', '--playlist-end', String(limit)];
  let sets = [[]];
  if (acc.platform === 'instagram') {
    if (igScanOff()) return { ...acc, links: [], error: 'Instagram scanning is turned off (INSTAGRAM_SCAN=off).' };
    const c = scanCookieArgs();
    if (!c) return { ...acc, links: [], error: 'Instagram scanning needs a separate scan account: set INSTAGRAM_SCAN_COOKIES_CONTENT on the server.' };
    sets = [c];
  }
  let lastErr = null;
  for (const cookies of sets) {
    try {
      const data = JSON.parse(await runYtDlp([...base, ...cookies, acc.url], 90000));
      let links = (data.entries || []).filter(Boolean)
        .map(e => ({ url: entryUrl(e, acc.platform), title: String(e.title || '').slice(0, 90), views: e.view_count ?? null }))
        .filter(x => x.url);
      if (acc.platform === 'instagram') links = links.filter(x => /\/(reel|p|tv)\//.test(x.url));
      if (links.length) return { ...acc, links: links.slice(0, limit), error: null };
      lastErr = new Error('No videos found (private account, wrong name, or Instagram blocked the server).');
    } catch (e) { lastErr = e; }
  }
  return { ...acc, links: [], error: lastErr ? lastErr.message : 'Nothing found.' };
}

/** rawAccounts: handles or profile links. Returns [{platform, handle, url, links:[{url,title,views}], error}] */
async function findLinks(rawAccounts, { platform = 'instagram', perAccount = 10 } = {}) {
  const limit = Math.max(1, Math.min(MAX_PER_ACCOUNT, Number(perAccount) || 10));
  const out = [];
  for (const r of rawAccounts) {
    const a = parseAccount(r, platform);
    out.push(a ? await findForAccount(a, limit) : { platform, handle: String(r).trim(), links: [], error: 'Not a valid account or link.' });
  }
  return out;
}

module.exports = { findLinks, parseAccount };
