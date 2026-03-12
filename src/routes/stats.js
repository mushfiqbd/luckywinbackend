const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/**
 * POST /api/stats/sync-game-stats
 * Recalculates total_bets, total_wins from game_sessions and updates game_stats_summary.
 * Admin or cron.
 */
router.post('/sync-game-stats', requireAuth, requireAdmin, async (req, res) => {
  const { data, error: fetchError } = await supabaseAdmin
    .from('game_sessions')
    .select('bet_amount, win_amount');

  if (fetchError) {
    return res.status(500).json({ error: fetchError.message });
  }

  const totalBets = (data || []).reduce((sum, r) => sum + Number(r.bet_amount || 0), 0);
  const totalWins = (data || []).reduce((sum, r) => sum + Number(r.win_amount || 0), 0);

  const { error: updateError } = await supabaseAdmin
    .from('game_stats_summary')
    .update({
      total_bets: totalBets,
      total_wins: totalWins,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  return res.json({ success: true, total_bets: totalBets, total_wins: totalWins });
});

module.exports = router;
