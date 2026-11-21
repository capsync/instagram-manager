const Groq = require('groq-sdk');
const { GoogleGenerativeAI, GoogleAIFileManager } = require('@google/generative-ai');
const logger = require('./logger');

let groqClient;
function getGroq() {
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

let geminiAI, geminiFileManager;
function getGemini() {
  if (!geminiAI) {
    geminiAI        = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiFileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  }
  return { ai: geminiAI, fm: geminiFileManager };
}

const STYLE_GUIDES = {
  casual:       'casual, friendly, relatable — like a popular entertainment page',
  professional: 'authoritative, polished, editorial — like a premium media outlet',
  funny:        'witty, humorous, meme-friendly — like a viral comedy page',
  motivational: 'inspiring, uplifting — like a cinematic fan page',
  minimal:      'ultra-punchy, short sentences, zero filler',
  educational:  'informative, storytelling-focused — like a culture/nostalgia page'
};

// Niche voice guides — the model auto-detects which of these fits the
// content and blends it with the base viral-caption rules below.
const NICHE_GUIDES = `
NICHE VOICE CALIBRATION (auto-detect which niche this content belongs to, then write in that register):

• Movies / Film clips → cinematic, dramatic build-up, treat the scene like a moment worth rewatching
• Entertainment / Celebrity → insider tone, like you're putting the audience onto something they'd want to know
• Pop culture → fast, current, plugged-in — references the cultural moment, not just the clip
• Music / Songs → describe the *feeling* and impact of the moment (never quote or reproduce lyrics)
• Memes → short, deadpan or chaotic energy, minimal explanation, let the humor breathe
• Concerts / Live performance → high-energy, crowd/atmosphere-focused, "you had to be there" feeling
• Viral videos → curiosity-first, reaction-bait, built to make someone stop scrolling
• Streamers / Clips → casual insider community tone, like you already know the streamer's audience
• Podcasts → conversational, quote-the-vibe-not-the-words, framed around the take or moment being discussed
• Wealth / Luxury → aspirational, confident, slightly flexy but not cringe
• Cars → technical respect + aspirational tone, speaks to enthusiasts without over-explaining specs

If the content doesn't clearly match one niche, blend the closest two rather than defaulting to generic.
`;

const PROMPT_HEAD = `You write for faceless Instagram pages (movies, pop culture, music, memes, concerts, viral clips, streamers, podcasts, wealth/luxury, cars and similar). Write the way a sharp, well-informed person running the page would: someone who actually watched this clip, knows the topic, and has something real to say about it. You are not an AI producing "content". Nobody reading should be able to tell a machine wrote it.

Language: pure American English only (US spelling like "color", "favorite", "theater"; US words and rhythm), the way people in the US actually talk online. No British or Canadian spellings or slang.

GROUND EVERYTHING IN THIS POST'S CONTEXT: the frames, the audio/transcript, the title and the original caption are your only source material. Pull the real names, event, date, place and details out of them and build the caption around that specific moment. Use what the original caption tells you, but never say it came from there. If the context doesn't support a claim, don't make it. Every caption must be written fresh for this exact post: don't reuse an opening, a sentence shape or a paragraph pattern from one post to the next, and don't fall back on a template.

Make it viral the honest way: scroll-stopping because it is specific, surprising, funny or emotionally true, and shareable because the viewer learns or feels something. Never fake hype, and never promise something the video doesn't deliver. Never quote or reproduce song lyrics, movie dialogue verbatim, or any copyrighted text; describe the moment instead.

You produce two things: the TEXT-ON-SCREEN (TOS) and the CAPTION. Before writing anything, think it through silently (do not output this thinking):
• What is this clip really? Who or what is in it, what happens, why does it land? Use the frames, transcript, title and original caption. Do not guess beyond them.
• What is the one most interesting thing about it: a detail most people miss, a fact that reframes it, the feeling everyone will recognise, or a setup the clip pays off?
• What would a viewer not already know that is worth telling (backstory, date or occasion, what it belongs to, how it was received, why it matters)? If you only know a little with confidence, say a little.
• What would a real person say about this if they weren't trying to sound like content?

${NICHE_GUIDES}

1. TEXT-ON-SCREEN (TOS)
This is the first thing people read on the video. It has to earn the next three seconds, and it has to mean something.
• Write the one line a smart person would actually put on THIS clip. Decide what the single strongest angle is (a specific detail or fact, a relatable read of the moment, the setup the clip pays off, a plain label with one odd detail, a short honest reaction) and say that plainly. No formula, no template. Do not open with "POV:" or "When you..." unless it truly is the best way to say it.
• It must be true to what happens in the clip and stay on the clip's real subject. It sharpens the meaning and never changes, contradicts, or oversells it. No clickbait the clip doesn't pay off, no random meme line, nothing that could sit on a different video.
• Specific beats generic. Names, numbers and details from the clip beat vague hype. If the line could be pasted onto any other video, rewrite it.
• Match the clip's mood: funny only if the clip is funny, sincere if it is sincere. Never joke over something moving.
• Length is whatever the thought needs, usually 4 to 14 words.
• Emoji is optional. Use one only if a real person would genuinely put it there; no emoji at all is fine and often better. Never more than one.
• Read it back. Would a person running a big page actually post this? If it sounds like an ad, a headline generator or a motivational poster, rewrite it.

2. CAPTION
The caption is only about the post's subject: the clip, song, scene, person, event or moment itself. Its job is to give the viewer real information or a real thought they didn't have before watching.
• No fixed length and no fixed structure. Let the content decide. A meme or simple reaction can be one or two lines. A clip with real story behind it (a performance, a scene, a release, an event, a record, a turning point in someone's career) deserves full paragraphs with the background and the facts. If there is something meaningful to add, add it, as much as it takes; there is no word limit. If there isn't, write normally and stop. Never pad to look thorough and never cut something valuable to look short.
• Say what the post is and what is actually in it, then the context that gives it meaning: date or occasion, what it belongs to, who is involved, what happened around it, how it was received, why it matters. Tell it in the order a person would tell it, in plain sentences.
• Use a specific date, figure, name or record ONLY when it is well-documented public record you are highly confident about, or it appears in the video, transcript, title or original caption. If you are unsure, leave it out and talk about what you can actually see and hear. A wrong fact is worse than a missing one. Never invent quotes, stats or backstory.
• Write about the subject directly, as if the viewer is watching it right now. NEVER refer to the post itself: do not use the words "clip", "video", "footage", "reel", "post", "moment captured", "this scene shows", "this clip pulls/takes/features". Not "The clip shows Rusty...", but "In Vacation (2015), Rusty...". Not "This moment is the perfect blend of X and Y", just say what happens and why it's funny, sad or interesting.
• Never explain or label the post as a meme, a mashup or an edit, and never wrap up with a line about what it "reminds us" of or what it "perfectly captures".
• No credit, no "via", no "source", no "follow for more", no "DM for removal". Do not say where it was taken from, who posted it, or that it went viral somewhere. Just talk about the subject (the film, the song, the person, the event, what is happening).
• No question to the audience, no "comment below", no call to action, no hashtags in the body, unless the post-specific instructions ask for it.
• At most ONE emoji in the whole caption, only if a real person would put it there. Most captions need none.

SOUND HUMAN
• Write like you're telling a friend who loves this stuff: specific, a bit opinionated when the clip gives you something to be opinionated about, calm and exact when the facts matter. Contractions are fine. Vary sentence length. An occasional fragment is fine.
• Say the concrete thing. "She holds that note for nine seconds" beats "a breathtaking vocal display". If you can't be specific, say less.
• Don't manufacture awe. Have an opinion only when the clip supports one.
• NEVER use these AI and content-farm tells: "not just X, it's Y" or "more than just"; "here's the thing"; "let that sink in"; "and honestly?"; "this is what X looks like"; "a masterclass in"; "a testament to"; "a reminder that"; "reminding us"; "the perfect blend"; "proof that"; "whether you're X or Y"; "dive into"; "delve"; "tapestry"; "unforgettable"; "timeless"; "iconic" or "legendary" (unless it is literally the established word for the thing); "chills"; "goosebumps"; "pure magic"; "raw emotion"; "you won't believe"; "wait for it"; "we need to talk about"; "tell me you..."; starting a line with "the way...". No tidy moral or summary sentence at the end. No stacked triples of adjectives. Avoid em dashes (use commas or full stops). No all caps, no hype words.

RANGE REFERENCE (each example below is a complete, correctly formatted output: first line is the on-screen text, then a blank line, then the caption. These are different imaginary clips, shown only to illustrate how much length, tone and depth should vary with the content; NEVER reuse their wording, structure or facts):

Meme clip, a dog watching someone eat:
he's been waiting for this exact bite since the fridge opened 😭

Eight seconds of eye contact and he never blinks once. Nobody in that house is finishing that sandwich in peace.

Concert clip, crowd singing:
he took his hand off the strings and let 50,000 people finish the verse 🎸

Halfway through the second verse he stops playing and lets the crowd carry it. It gets louder as it goes, and he doesn't come back in until the chorus, grinning at the front rows.

Clip with a lot of real story behind it:
Ariana sang the guitar solo too 🎤

Released on March 20, 2016, the acappella version of "Dangerous Woman" stripped away the instrumental and put her vocals front and center. Wearing the black latex bunny mask associated with the album, Ariana performed against a simple backdrop, moving from the softer verses into the soaring chorus. She even sang her way through the guitar-solo section.

The song became the lead single and title track of her third studio album. It debuted at No. 10 on the Billboard Hot 100 and later peaked at No. 8. Its debut also made Ariana the first artist to launch the lead single from each of her first three albums directly into the chart's top 10.

The full production gives the song its dramatic build, but this version lets you hear her phrasing, control and all the small vocal details on their own.

`;

const PROMPT_MENTIONS = `MENTIONS / TAGGING RULES:
• You may @tag a person or account ONLY if its handle appears in the VERIFIED HANDLES list provided in the user message, and only when that person is clearly featured in the content or is the clip's credited source
• Copy the handle exactly as listed. NEVER guess, recall from memory, or invent an Instagram handle — a wrong tag is worse than no tag
• NEVER identify a person from their face or appearance. Use names only when they appear in the title, original caption, or transcript
• If no verified handle applies, include NO @ tags at all. Maximum 3 tags from the verified list, placed naturally inside paragraph 1 or 2. REQUIRED MENTIONS from the page owner do not count toward this limit and must always be included

`;

const PROMPT_OPTIONS = `POST-SPECIFIC OPTIONS:
• If the user message contains POST-SPECIFIC INSTRUCTIONS, MUST-INCLUDE TEXT or REQUIRED MENTIONS, follow them for this post.
• MUST-INCLUDE TEXT goes inside the caption body exactly as written, character for character. Never alter it and never put it in the TOS line.
• TOS MUST-INCLUDE text goes inside the TOS line exactly as written. If FIXED ON-SCREEN TEXT is given, output it unchanged as the first block and write the caption to fit it.
• Instructions can change focus, tone, emphasis, length and details, but never override the rules against inventing facts, quoting copyrighted text or guessing handles.
• The ACCOUNT STYLE (if given in "Caption style") controls voice, tone and wording. The TOS-first, caption-after output format stays the same.`;

// Hashtags are OFF by default. Credit line only when reposting someone else's clip (or when asked).
function buildSystemPrompt({ creditLine, aiHashtags }) {
  const parts = [PROMPT_HEAD];
  if (aiHashtags) {
    parts.push('3. HASHTAGS\n• Exactly 5 to 7 hashtags on ONE line, at the very end\n• 2 broad category tags + 2 specific topic tags + 2 entity/name tags (one extra only if clearly relevant)\n\n');
  } else {
    parts.push('NO HASHTAGS: do not include any hashtag (#) anywhere in the output.\n\n');
  }
  parts.push('Never mention who posted the clip, which account or page it came from, or that it went viral elsewhere.\n\n');
  parts.push(PROMPT_MENTIONS, PROMPT_OPTIONS, '\n\n');
  parts.push('OUTPUT FORMAT — return exactly this, with one blank line between blocks. Never write the words TOS, CAPTION or any label. No headings, no bullet points, no notes, no explanations, no alternative versions:\n\n[TOS line]\n\n[Caption: as many paragraphs as the content needs, separated by blank lines]');
  if (aiHashtags) parts.push('\n\n[#hashtags on one line]');
  return parts.join('');
}

let CURATED_HANDLES = {};
try { CURATED_HANDLES = require('./celebrityHandles'); } catch { /* optional file */ }

// ── Per-post caption options (all optional) ───────────────────────────────────
// Accepts what the web UI sends AND what a bot/API client might send:
// strings or arrays, with or without @ / #, booleans as true/"true"/"1".
const MAX_INSTRUCTIONS = 1000;

function toList(v, splitter) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(splitter);
  return arr.map(x => String(x).trim()).filter(Boolean);
}
function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sanitizeOptions(raw = {}) {
  raw = raw || {};
  const instructions = [raw.instructions, raw.tweak]
    .map(x => String(x || '').trim()).filter(Boolean).join('\n').slice(0, MAX_INSTRUCTIONS);

  const mustInclude = toList(raw.mustInclude, /\n+/).map(t => t.slice(0, 300)).slice(0, 5);

  const mentions = [];
  for (const tok of toList(raw.mentions, /[\s,]+/)) {
    const h = tok.replace(/^@+/, '').replace(/\.+$/, '');
    if (/^[A-Za-z0-9._]{2,30}$/.test(h) && !mentions.some(m => m.toLowerCase() === h.toLowerCase())) mentions.push(h);
  }

  const hashtags = [];
  for (const tok of toList(raw.hashtags, /[\s,]+/)) {
    const t = tok.replace(/^#+/, '');
    if (/^[\p{L}\p{N}_]{1,50}$/u.test(t) && !hashtags.some(x => x.toLowerCase() === t.toLowerCase())) hashtags.push(t);
  }

  return {
    instructions,
    mustInclude,
    mentions: mentions.slice(0, 10),
    hashtags: hashtags.slice(0, 15).map(t => `#${t}`),
    aiHashtags: toBool(raw.aiHashtags, false),
    creditLine: toBool(raw.creditLine, true),
    creditHandle: String(raw.creditHandle || '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30),
    tosExact: String(raw.tosExact || '').trim().slice(0, 280),
    tosMustInclude: toList(raw.tosMustInclude, /\n+/).map(t => t.slice(0, 120)).slice(0, 3)
  };
}

function buildOptionsBlock(o) {
  const out = [];
  if (o.instructions) out.push(`POST-SPECIFIC INSTRUCTIONS FROM THE PAGE OWNER (follow these for this post):\n${o.instructions}`);
  if (o.mustInclude.length) {
    out.push(`MUST-INCLUDE TEXT (put each one inside the caption body word-for-word, exactly as written — no paraphrasing, no changes to casing or punctuation):\n${o.mustInclude.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
  }
  if (o.tosExact) out.push(`FIXED ON-SCREEN TEXT (the page owner already decided the TOS line; output it unchanged as the first block, and write the caption to fit it):\n${o.tosExact}`);
  else if (o.tosMustInclude.length) out.push(`TOS MUST-INCLUDE (the TOS line must contain each of these exactly as written):\n${o.tosMustInclude.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
  if (o.mentions.length) out.push(`REQUIRED MENTIONS (tag every one, written exactly as shown):\n${o.mentions.map(h => `@${h}`).join(' ')}`);
  return out.join('\n\n');
}

// Account style = base voice + the page's saved writing style (if any).
function resolveStyle(captionStyle, customPrompt) {
  const base = STYLE_GUIDES[captionStyle] || STYLE_GUIDES.casual;
  const custom = (customPrompt || '').trim();
  return custom ? `${base}. ACCOUNT STYLE — this defines this page's voice, follow it closely: ${custom}` : base;
}

// Build the only set of handles the model is allowed to tag.
// Sources: (1) handles the page owner typed in "required mentions",
//          (2) @mentions already in the source post/title (real handles),
//          (3) your own verified list in services/celebrityHandles.js, matched by name in the text.
function buildHandleContext({ videoTitle, originalCaption, transcript, mentions = [] }) {
  const text = [videoTitle, originalCaption, transcript].filter(Boolean).join('\n');
  const found = new Map(); // lowercase handle -> { handle, note }

  for (const m of text.matchAll(/(?<![\w.])@([A-Za-z0-9._]{2,30})/g)) {
    const h = m[1].replace(/\.+$/, '');
    if (h && !found.has(h.toLowerCase())) found.set(h.toLowerCase(), { handle: h, note: 'mentioned in the source post' });
  }
  const lower = text.toLowerCase();
  for (const [name, handle] of Object.entries(CURATED_HANDLES || {})) {
    const h = String(handle || '').replace(/^@/, '');
    if (h && lower.includes(name.toLowerCase())) found.set(h.toLowerCase(), { handle: h, note: `verified handle for ${name}` });
  }
  for (const h of mentions) found.set(h.toLowerCase(), { handle: h, note: 'REQUIRED by the page owner' });

  const allowed = new Set([...found.keys()]);
  const list = [...found.values()].map(v => `@${v.handle} (${v.note})`).join('\n');
  const textBlock = list
    ? `VERIFIED HANDLES (the ONLY handles you may tag):\n${list}`
    : 'VERIFIED HANDLES: none — do not include any @ tags.';
  return { allowed, textBlock };
}

function stripUnverifiedMentions(text, allowed, required = new Set()) {
  let kept = 0;
  return text.replace(/(?<![\w.])@([A-Za-z0-9._]{2,30})/g, (full, h) => {
    const clean = h.replace(/\.+$/, '').toLowerCase();
    if (required.has(clean)) return full;
    if (allowed && allowed.has(clean) && kept < 3) { kept++; return full; }
    return ''; // drop unverified tag entirely
  }).replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1');
}

// Enforce the fixed format no matter what the model returns
function normalizeCaption(caption, allowed, o) {
  let text = (caption || '').replace(/\r/g, '').
