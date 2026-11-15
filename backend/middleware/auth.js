// Verifies the login token and makes sure each request acts as the REAL signed-in user.
//
// How it works:
//  - The frontend sends  Authorization: Bearer <token>  (the same token the auth service already issues).
//  - If the token is valid, its user id REPLACES the x-user-id header, so every existing route
//    automatically uses the verified id (a spoofed x-user-id is ignored).
//  - If the token is bad or expired -> 401 { code: 'session_expired' }.
//  - Transition mode: requests with NO token still work through x-user-id (old logins, bots), until you set
//    REQUIRE_JWT=1 on Render. Then every request must carry a valid token.
//  - JWT_SECRET must be the SAME value the auth service signs with. If it is not set, nothing is verified
//    (old behaviour) and a warning is logged once.
const crypto = require('crypto');
const logger = require('../services/logger');

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  } catch { return null; }
  if (!header || header.alg !== 'HS256') return null;           // never accept "none" or other algorithms
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = b64urlToBuf(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return { expired: true };
  return payload;
}

let warned = false;
const OPEN_PATHS = new Set(['/health', '/autopilot/tick']);       // mounted under /api

function attachUser(req, res, next) {
  if (OPEN_PATHS.has(req.path)) return next();
  const secret = process.env.JWT_SECRET;
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';

  if (!token) {
    if (process.env.REQUIRE_JWT === '1') return res.status(401).json({ error: 'Please sign in again.', code: 'session_expired' });
    return next();                                               // transition mode: x-user-id as before
  }
  if (!secret) {
    if (!warned) { warned = true; logger.warn('JWT_SECRET not set - tokens are NOT being verified'); }
    return next();
  }
  const payload = verifyJwt(token, secret);
  if (!payload || payload.expired || !payload.id) {
    return res.status(401).json({ error: 'Your session expired. Please sign in again.', code: 'session_expired' });
  }
  req.headers['x-user-id'] = String(payload.id);
  next();
}

// ── Ownership helpers (used by the routes) ───────────────────────────────────
// Pages that were created before user ids existed (user_id is empty) stay usable, exactly as before.
const mine = (ownerId, userId) => !ownerId || String(ownerId) === String(userId);

async function checkAccountAccess(db, accountId, userId) {
  if (!userId) return { status: 401, error: 'Not signed in.' };
  const a = await db.get('SELECT id, user_id FROM accounts WHERE id=$1', [accountId]);
  if (!a) return { status: 404, error: 'Account not found' };
  if (!mine(a.user_id, userId)) return { status: 403, error: 'Not your account.' };
  return null;
}

// Checks the post's current page, and (when given) the page it is being moved to.
async function checkPostAccess(db, postId, userId, newAccountId) {
  if (!userId) return { status: 401, error: 'Not signed in.' };
  const row = await db.get('SELECT p.id, p.account_id, a.user_id AS owner FROM posts p LEFT JOIN accounts a ON a.id=p.account_id WHERE p.id=$1', [postId]);
  if (!row) return { status: 404, error: 'Post not found' };
  if (row.account_id && !mine(row.owner, userId)) return { status: 403, error: 'Not your post.' };
  if (newAccountId) {
    const bad = await checkAccountAccess(db, newAccountId, userId);
    if (bad) return bad;
  }
  return null;
}

module.exports = { attachUser, checkAccountAccess, checkPostAccess, verifyJwt };
