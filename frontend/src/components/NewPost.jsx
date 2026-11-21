import React, { useState, useEffect, useRef } from 'react';
import { api, mediaUrl } from '../services/api';
import TextOverlayEditor from './TextOverlayEditor';
import CaptionOptions, { RegenerateBar } from './CaptionOptions';
import FrameEditor from './FrameEditor';

const STEPS = { INPUT: 'input', PROCESSING: 'processing', REVIEW: 'review' };

const SPEEDS = [
  { label: '0.5×',  value: 0.5 },
  { label: '0.75×', value: 0.75 },
  { label: '1×',    value: 1 },
  { label: '1.5×',  value: 1.5 },
  { label: '2×',    value: 2 },
];

const CROP_RATIOS = [
  { label: 'Original', value: 'none' },
  { label: '9:16',     value: '9/16', desc: 'Reels / Stories' },
  { label: '4:5',      value: '4/5',  desc: 'Feed Portrait' },
  { label: '1:1',      value: '1/1',  desc: 'Square' },
  { label: '16:9',     value: '16/9', desc: 'Landscape' },
];

function getBackgroundFill(bg) {
  if (bg === 'black') return '#000000';
  if (bg === 'white') return '#ffffff';
  if (bg === 'dark')  return 'rgba(0,0,0,0.78)';
  if (bg === 'light') return 'rgba(255,255,255,0.82)';
  return 'transparent';
}

function getBoxTextColor(box) {
  if (box.bg === 'black' || box.bg === 'dark') return '#fff';
  if (box.bg === 'white' || box.bg === 'light') return '#111';
  return box.colorHex || '#fff';
}

// Main component ────────────────────────────────────────────────────────────
const FULL_FRAME = { top: 0, bottom: 1, left: 0, right: 1, zoom: 1, offsetY: 0, cardScale: 1 };

// downloadOnly = the Export tab: same upload, caption and render settings, but nothing is posted. You download the video + caption.
export default function NewPost({ downloadOnly = false } = {}) {
  const [accounts, setAccounts]         = useState([]);
  const [accountId, setAccountId]       = useState('');
  const [url, setUrl]                   = useState('');
  const [file, setFile]                 = useState(null);
  const [step, setStep]                 = useState(STEPS.INPUT);
  const [result, setResult]             = useState(null);
  const [caption, setCaption]           = useState('');
  const [onScreenText, setOnScreenText] = useState('');
  const [textBoxes, setTextBoxes]       = useState([]);
  const [enhancedUrl, setEnhancedUrl]   = useState(null);
  const [showTextEditor, setShowTextEditor] = useState(false);
  const [segments, setSegments]         = useState([]);
  const [subtitleStyle, setSubtitleStyle] = useState('standard');
  const [burnSubs, setBurnSubs]         = useState(false);
  const [enhance, setEnhance]           = useState(false);
  const [enhancing, setEnhancing]       = useState(false);
  const [trimStart, setTrimStart]   = useState('');
  const [trimEnd, setTrimEnd]       = useState('');
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast]     = useState(1);
  const [saturation, setSaturation] = useState(1);
  const [speed, setSpeed]           = useState(1);
  const [cropRatio, setCropRatio]   = useState('none');
  const [scheduling, setScheduling]     = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [posting, setPosting]           = useState(false);
  const [exporting, setExporting]         = useState(false);
  const [reaction, setReaction]           = useState('');   // the tweet-card comment (Reaction layout)
  const [reactionBusy, setReactionBusy]   = useState(false);
  const [exported, setExported]           = useState(null);   // { url } once the processed video is ready to download
  const [error, setError]               = useState('');
  const [success, setSuccess]           = useState('');
  const [popup, setPopup]               = useState(null);
  const [capOpts, setCapOpts]             = useState({});
  const [badPreview, setBadPreview]       = useState('');
  const [captionBusy, setCaptionBusy]     = useState(false);
  const [layout, setLayoutState]         = useState(() => { try { return (v => (['text', 'clean', 'cinema', 'tweet'].includes(v) ? v : 'card'))(localStorage.getItem('im_layout')); } catch { return 'card'; } });
  const setLayout = (v) => { setLayoutState(v); try { localStorage.setItem('im_layout', v); } catch { /* ignore */ } };
  // Card background: 'auto' = the page's own theme, or force black / white for this post
  const [theme, setThemeState]            = useState(() => { try { const t = localStorage.getItem('im_theme'); return t === 'dark' || t === 'light' ? t : 'auto'; } catch { return 'auto'; } });
  const setTheme = (v) => { setThemeState(v); try { localStorage.setItem('im_theme', v); } catch { /* ignore */ } };
  const [cardImg, setCardImg]             = useState('');
  const [cardH, setCardH]               = useState(null);
  const [canvasColor, setCanvasColor]     = useState('#000000');
  const [frame, setFrame]                 = useState(FULL_FRAME);
  const [autoFrame, setAutoFrame]         = useState(null);
  const [showAdv, setShowAdv]             = useState(false);
  const [jobInfo, setJobInfo]             = useState(null);
  const [quality, setQualityState]        = useState(() => { try { return localStorage.getItem('im_quality') === 'fast' ? 'fast' : 'best'; } catch { return 'best'; } });
  const setQuality = (v) => { setQualityState(v); try { localStorage.setItem('im_quality', v); } catch { /* ignore */ } };
  const fileRef = useRef();
  const PUBLISH_STATUS_POLL_MS = 3000;
  const PUBLISH_STATUS_TIMEOUT_MS = 90000;

  function showPopup(type, detail) { setPopup({ type, detail }); }
  function closePopup() { setPopup(null); reset(); }

  useEffect(() => { api.getAccounts().then(setAccounts).catch(() => {}); }, []);

  function reset() {
    setStep(STEPS.INPUT); setResult(null); setCaption('');
    setOnScreenText(''); setTextBoxes([]); setEnhancedUrl(null);
    setBurnSubs(false); setEnhance(false);
    setTrimStart(''); setTrimEnd('');
    setBrightness(0); setContrast(1); setSaturation(1); setSpeed(1);
    setCropRatio('none');
    setScheduling(false); setScheduleTime('');
    setError(''); setSuccess(''); setUrl(''); setFile(null); setCapOpts({}); setExported(null); setReaction('');
  }

  // One tap: read the copied link from the clipboard, fill the box, and start processing.
  async function handlePasteAndProcess() {
    setError('');
    let text = '';
    try {
      if (!navigator.clipboard?.readText) throw new Error('unsupported');
      text = await navigator.clipboard.readText();
    } catch {
      return setError('Could not read the clipboard. Allow clipboard access for this site, or paste the link into the box below.');
    }
    const match = (text || '').match(/https?:\/\/[^\s]+/i);
    if (!match) return setError("No link found in your clipboard. Copy the video link first, then tap again.");
    const link = match[0].replace(/[)\].,;]+$/, '');
    setFile(null); setUrl(link);
    await handleProcess(link);
  }

  async function handleProcess(linkOverride) {
    setJobInfo(null);
    const link = (typeof linkOverride === 'string' ? linkOverride : url).trim();
    if (!link && !file) return setError('Enter a video URL or upload a file');
    setError(''); setStep(STEPS.PROCESSING);
    try {
      const data = file
        ? await api.processFile(file, accountId || null, capOpts, onProcessJob)
        : await api.processUrl(link, accountId || null, capOpts, onProcessJob);
      setResult(data);
      setCaption(data.generatedCaption || '');
      setOnScreenText(data.hookText || '');
      setSegments(data.segments || []);
      setStep(STEPS.REVIEW);
    } catch (err) {
      setError(err.message);
      setStep(STEPS.INPUT);
    }
  }

  // Auto-called when boost quality is toggled
  async function handleEnhanceAuto(shouldEnhance) {
    if (!result?.postId) return;
    setEnhancing(true);
    setError('');
    try {
      const realText = textBoxes.filter(b => b.text && b.text.trim() && b.text !== 'Tap to type');
      const res = await enhanceJob(result.postId, {
        enhance:      shouldEnhance,
        burnSubs,
        textOverlays: realText,
        trim:         { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
        adjustments:  { brightness, contrast, saturation },
        subtitleStyle,
        segments,
        ...cardOpts(),
      });
      setEnhancedUrl(shouldEnhance || cardOn ? res.enhancedVideoUrl : null);
    } catch (err) {
      setError(err.message || 'Boost failed');
      setEnhance(false);
    } finally {
      setEnhancing(false);
    }
  }

  async function handleEnhance() {
    if (tweet && !cardOn) return setError(TWEET_MSG);
    const hasText  = textBoxes.some(b => b.text);
    const hasTrim  = Number(trimStart) > 0 || Number(trimEnd) > 0;
    const hasAdj   = brightness !== 0 || contrast !== 1 || saturation !== 1;
    const hasSpeed = speed !== 1;
    const hasCrop  = cropRatio !== 'none';
    if (!burnSubs && !enhance && !hasText && !hasTrim && !hasAdj && !hasSpeed && !hasCrop && !cardOn)
      return setError('Make at least one edit or enable an enhancement');
    setError(''); setEnhancing(true);
    try {
      await api.updateCaption(result.postId, { caption, hookText: '' });
      const res = await enhanceJob(result.postId, {
        burnSubtitles: burnSubs,
        subtitleStyle,
        segments,
        enhance,
        textOverlays:  textBoxes.filter(b => b.text || b.bg !== 'none'),
        trim:          { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
        adjustments:   { brightness, contrast, saturation },
        speed,
        cropRatio,
        ...cardOpts()
      });
      setEnhancedUrl(res.enhancedVideoUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnhancing(false);
    }
  }

  // ── Export tab: render with the current settings, then download (nothing is posted) ──
  async function handleExport() {
    if (tweet && !cardOn) return setError(TWEET_MSG);
    setError(''); setSuccess(''); setExporting(true);
    try {
      await api.updateCaption(result.postId, { caption, hookText: '' });
      const realText = textBoxes.filter(b => b.text && b.text.trim() && b.text !== 'Tap to type');
      const hasTrim  = Number(trimStart) > 0 || Number(trimEnd) > 0;
      const hasAdj   = brightness !== 0 || contrast !== 1 || saturation !== 1;
      const needsRender = realText.length > 0 || hasTrim || hasAdj || burnSubs || enhance || speed !== 1 || cropRatio !== 'none' || cardOn;
      let finalUrl = enhancedUrl || result.videoUrl;
      if (needsRender) {
        setSuccess('Processing video… this can take a few minutes. Keep this page open.');
        const res = await enhanceJob(result.postId, {
          burnSubtitles: burnSubs, subtitleStyle, segments, enhance,
          textOverlays: realText,
          trim:         { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
          adjustments:  { brightness, contrast, saturation },
          speed, cropRatio,
          ...cardOpts()
        });
        setEnhancedUrl(res.enhancedVideoUrl);
        finalUrl = res.enhancedVideoUrl;
      }
      setExported({ url: finalUrl });
      setSuccess('Ready. Download the video and the caption below.');
    } catch (err) {
      setSuccess('');
      setError(err.message || 'Processing failed');
    } finally {
      setExporting(false);
    }
  }

  async function saveVideo() {
    const src = mediaUrl(exported?.url);
    if (!src) return;
    const name = `video-${result?.postId || Date.now()}.mp4`;
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error('bad status');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch {
      window.open(src, '_blank');   // fallback: opens the video, then use "Download" from the player menu
    }
  }

  async function writeReaction() {
    if (!result?.postId) return;
    setReactionBusy(true); setError('');
    try {
      const r = await api.generateReaction(result.postId, { headline: onScreenText, caption });
      setReaction(r.reaction || '');
    } catch (err) {
      setError(err.message || 'Could not write the reaction. Try again.');
    } finally {
      setReactionBusy(false);
    }
  }

  async function copyCaption() {
    try { await navigator.clipboard.writeText(caption); setSuccess('Caption copied.'); }
    catch {
      const t = document.createElement('textarea'); t.value = caption; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); setSuccess('Caption copied.'); } catch { setError('Could not copy. Select the caption text and copy it.'); }
      t.remove();
    }
  }

  function saveCaptionFile() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([caption], { type: 'text/plain;charset=utf-8' }));
    a.download = `caption-${result?.postId || Date.now()}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // Safety gate: risky clips are never posted
  function guardOk() {
    const g = result?.guard;
    if (!g || g.level === 'clear') return true;
    const list = (g.reasons || []).map(r => '• ' + r).join('\n');
    setError('Not posted — safety check:\n' + list);
    return false;
  }

  async function handlePublish() {
    if (!accountId) return setError('Select an Instagram account first');
    if (tweet && !cardOn) return setError(TWEET_MSG);
    if (!guardOk()) return;
    setPosting(true); setError(''); setSuccess('');
    try {
      await api.updateCaption(result.postId, { caption, hookText: '' });
      const realText = textBoxes.filter(b => b.text && b.text.trim() && b.text !== 'Tap to type');
      const hasTrim  = Number(trimStart) > 0 || Number(trimEnd) > 0;
      const hasAdj   = brightness !== 0 || contrast !== 1 || saturation !== 1;
      const needsRender = realText.length > 0 || hasTrim || hasAdj || burnSubs || enhance || cardOn;
      if (needsRender) {
        setSuccess('Processing video…');
        try {
          const res = await enhanceJob(result.postId, {
            enhance, burnSubs,
            textOverlays:  realText,
            trim:          { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
            adjustments:   { brightness, contrast, saturation },
            subtitleStyle, segments,
            ...cardOpts(),
          });
          setEnhancedUrl(res.enhancedVideoUrl);
        } catch (renderErr) {
          setError('Failed to process video: ' + (renderErr.message || 'Unknown error'));
          setPosting(false);
          return;
        }
      }
      setSuccess('Publishing to Instagram…');
      await api.publishPost(result.postId, { account_id: accountId, caption });
      setSuccess('Publishing to Instagram. Waiting for final status…');

      const startedAt = Date.now();
      while (Date.now() - startedAt < PUBLISH_STATUS_TIMEOUT_MS) {
        await new Promise(resolve => setTimeout(resolve, PUBLISH_STATUS_POLL_MS));
        const posts = await api.getPosts().catch(() => []);
        const latest = posts.find(p => p.id === result.postId);

        if (!latest) continue;
        if (latest.status === 'failed') {
          setSuccess('');
          setError(latest.error_message || 'Instagram publishing failed.');
          setPosting(false);
          return;
        }
        if (latest.status === 'posted') {
          setSuccess('');
          showPopup('posted');
          return;
        }
      }

      setSuccess('');
      showPopup('posted', 'Your reel is still processing. If Instagram rejects it, the exact reason will appear in Posts.');
    } catch (err) {
      setError(err.message);
    } finally {
      setPosting(false);
    }
  }

  async function handleSchedule() {
    if (!accountId) return setError('Select an Instagram account first');
    if (!scheduleTime) return setError('Pick a date and time');
    if (!guardOk()) return;
    setPosting(true); setError('');
    try {
      await api.updateCaption(result.postId, { caption, hookText: '' });
      const realText = textBoxes.filter(b => b.text && b.text.trim() && b.text !== 'Tap to type');
      const hasTrim  = Number(trimStart) > 0 || Number(trimEnd) > 0;
      const hasAdj   = brightness !== 0 || contrast !== 1 || saturation !== 1;
      const needsRender = realText.length > 0 || hasTrim || hasAdj || burnSubs || enhance || cardOn;
      if (needsRender) {
        setSuccess('Processing video…');
        try {
          const res = await enhanceJob(result.postId, {
            enhance, burnSubs,
            textOverlays:  realText,
            trim:          { start: Number(trimStart) || 0, end: Number(trimEnd) || 0 },
            adjustments:   { brightness, contrast, saturation },
            subtitleStyle, segments,
            ...cardOpts(),
          });
          setEnhancedUrl(res.enhancedVideoUrl);
        } catch (renderErr) {
          setError('Failed to process video: ' + (renderErr.message || 'Unknown error'));
          setPosting(false);
          return;
        }
      }
      await api.schedulePost(result.postId, {
        scheduled_at: new Date(scheduleTime).toISOString(),
        account_id: accountId, caption
      });
      showPopup('scheduled', new Date(scheduleTime).toLocaleString());
    } catch (err) {
      setError(err.message);
      setPosting(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) { setFile(f); setUrl(''); }
  }

  const minTime      = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 16);
  const previewUrl   = mediaUrl(enhancedUrl || result?.videoUrl);
  // Card layout: page card on top, video below. Needs a page selected; text comes from the on-screen text box.
  // Layout choice: 'card' = page branding + text, 'text' = same layout with just the text line (no branding)
  // live progress from the server's background jobs
  const onProcessJob = (j) => setJobInfo(j);
  const onRenderJob  = (j) => setSuccess(j.status === 'queued' ? 'Rendering video… waiting for another job to finish' : `Rendering video… ${j.elapsed_s || 0}s`);
  const enhanceJob   = (id, opts) => api.enhanceVideo(id, opts, onRenderJob);
  const framed    = layout === 'clean' || layout === 'cinema';                  // direct 3:4 / 4:3 video, no page card
  const tweet     = layout === 'tweet';                                         // headline on top, video, tweet card (page profile + reaction) under it
  const frameMode = !framed && !tweet && (layout === 'text' || !!accountId);                // show the frame editor (crop + live preview)
  const tweetReady = tweet && !!accountId && !!reaction.trim();
  const cardOn    = framed || tweetReady || (frameMode && (layout === 'text' || !!onScreenText.trim()));   // render the 1080x1920 layout when posting
  const TWEET_MSG = 'The Reaction layout needs a page (its saved profile goes on the tweet card) and a reaction comment. Pick a page and tap "Write it", or choose another layout.';
  const srcUrl    = mediaUrl(result?.videoUrl);
  const cardOpts = () => (cardOn ? { ...(accountId ? { account_id: accountId } : {}), brandCard: { enabled: true, mode: layout, text: tweet ? reaction : onScreenText, ...(tweet ? { headline: onScreenText } : {}), frame, quality, ...(theme !== 'auto' ? { theme } : {}) } } : {});
  useEffect(() => {
    if (!frameMode || !result) { setCardImg(''); return; }
    const t = setTimeout(() => {
      api.cardPreview(accountId || null, onScreenText, frame.cardScale, layout, theme !== 'auto' ? theme : undefined)
        .then(r => { setCardImg(r.image); setCardH(r.height); setCanvasColor(r.canvasColor || '#000000'); })
        .catch(() => setCardImg(''));
    }, 400);
    return () => clearTimeout(t);
  }, [frameMode, layout, theme, accountId, onScreenText, frame.cardScale, result?.postI
