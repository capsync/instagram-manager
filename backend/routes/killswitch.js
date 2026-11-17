const express = require('express');
const ks = require('../services/killSwitch');
const router = express.Router();

// POST /api/kill/stop    → stop everything for the signed-in user
// POST /api/kill/resume  → allow work again and un-pause the pages that STOP ALL paused
// GET  /api/kill/status  → { stopped, since }
router.post('/stop', async (req, res, next) => {
  try { res.json({ ...ks.status(req.headers['x-user-id']), ...(await ks.stopAll(req.headers['x-user-id'])), stopped: true }); }
  catch (err) { next(err); }
});
router.post('/resume', async (req, res, next) => {
  try { res.json(await ks.resume(req.headers['x-user-id'])); } catch (err) { next(err); }
});
router.get('/status', (req, res) => res.json(ks.status(req.headers['x-user-id'])));

module.exports = router;
