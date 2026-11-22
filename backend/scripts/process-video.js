// Standalone runner for GitHub Actions: downloads VIDEO_URL, renders it, saves to UPLOAD_DIR.
const fs = require('fs');
const path = require('path');
const { renderFramed } = require('../services/videoProcessor');

(async () => {
  const url = process.env.VIDEO_URL;
  if (!url) throw new Error('VIDEO_URL is not set (needs a direct .mp4 link)');

  const downloadDir = path.resolve(process.env.DOWNLOAD_DIR || './downloads');
  const outDir = path.resolve(process.env.UPLOAD_DIR || './output');
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const inputPath = path.join(downloadDir, 'input.mp4');
  console.log('Downloading video...');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.writeFileSync(inputPath, Buffer.from(await res.arrayBuffer()));
  console.log(`Downloaded ${(fs.statSync(inputPath).size / 1024 / 1024).toFixed(1)} MB`);

  const result = await renderFramed({
    inputPath,
    quality: process.env.RENDER_QUALITY || 'best',
  });
  console.log('Done:', result.path);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
