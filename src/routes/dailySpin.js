const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/daily-spin/status
 * Returns { canSpin, lastSpinAt, nextSpinAt } for the current user.
 * Uses server time for 24h cooldown consistency.
 */
router.get('/status', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { data: vip, error } = await supabaseAdmin
    .from('user_vip_data')
    .select('last_spin_at')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ error: error.message });
  }

  const lastSpinAt = vip?.last_spin_at ? new Date(vip.last_spin_at) : null;
  const now = new Date();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  const canSpin = !lastSpinAt || (now.getTime() - lastSpinAt.getTime() >= twentyFourHoursMs);
  const nextSpinAt = lastSpinAt
    ? new Date(lastSpinAt.getTime() + twentyFourHoursMs).toISOString()
    : null;

  return res.json({
    canSpin,
    lastSpinAt: lastSpinAt?.toISOString() ?? null,
    nextSpinAt,
  });
});

module.exports = router;
