const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const LIVE_BET_COLUMNS = [
  'id',
  'game_id',
  'round_id',
  'user_id',
  'username_snapshot',
  'panel_index',
  'bet_amount',
  'auto_cashout',
  'status',
  'cashout_multiplier',
  'win_amount',
  'placed_at',
  'settled_at',
  'updated_at',
].join(', ');

async function loadCrashState(gameId) {
  const { data: round, error: roundError } = await supabaseAdmin.rpc('get_or_create_crash_round', {
    p_game_id: gameId,
  });
  if (roundError) {
    throw new Error(roundError.message);
  }

  const roundId = round?.id;
  const [{ data: historyRows, error: historyError }, { data: liveBets, error: betsError }] = await Promise.all([
    supabaseAdmin
      .from('crash_rounds')
      .select('id, crash_point, created_at')
      .eq('game_id', gameId)
      .order('created_at', { ascending: false })
      .limit(20),
    roundId
      ? supabaseAdmin
          .from('crash_bets')
          .select(LIVE_BET_COLUMNS)
          .eq('game_id', gameId)
          .eq('round_id', roundId)
          .order('placed_at', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (historyError) {
    throw new Error(historyError.message);
  }
  if (betsError) {
    throw new Error(betsError.message);
  }

  // Show crash in history only 1 second after crash (not immediately)
  const COUNTDOWN_MS = 10000;
  const GROWTH_RATE = 0.00006;
  const HISTORY_DELAY_MS = 1000;

  let showCurrentRoundInHistory = false;
  if (round?.phase === 'crashed' && round?.crash_point && round?.server_start_ms != null && round?.server_now_ms != null) {
    const crashPoint = Number(round.crash_point);
    const serverStartMs = Number(round.server_start_ms);
    const serverNowMs = Number(round.server_now_ms);
    const crashDelayMs = Math.max(0, Math.floor(Math.log(Math.max(crashPoint, 1.01)) / GROWTH_RATE));
    const crashTimeMs = serverStartMs + COUNTDOWN_MS + crashDelayMs;
    const timeSinceCrashMs = serverNowMs - crashTimeMs;
    showCurrentRoundInHistory = timeSinceCrashMs >= HISTORY_DELAY_MS;
  }

  const historyFiltered = (historyRows || []).filter((row) =>
    showCurrentRoundInHistory || row.id !== roundId
  );

  return {
    round,
    history: historyFiltered.map((row) => ({
      id: row.id,
      crash_point: Number(row.crash_point),
      created_at: row.created_at,
    })),
    liveBets: (liveBets || []).map((bet) => ({
      ...bet,
      bet_amount: Number(bet.bet_amount),
      auto_cashout: bet.auto_cashout === null ? null : Number(bet.auto_cashout),
      cashout_multiplier: bet.cashout_multiplier === null ? null : Number(bet.cashout_multiplier),
      win_amount: Number(bet.win_amount || 0),
    })),
  };
}

router.post('/state', requireAuth, async (req, res) => {
  const gameId = String(req.body?.game_id || '').trim();
  if (!gameId) {
    return res.status(400).json({ error: 'game_id is required' });
  }

  try {
    const state = await loadCrashState(gameId);
    const round = state.round
      ? {
          ...state.round,
          current_multiplier: Number(state.round.current_multiplier || 1),
          countdown_ms: Number(state.round.countdown_ms || 0),
          elapsed_ms: Number(state.round.elapsed_ms || 0),
          server_start_ms: Number(state.round.server_start_ms || 0),
          server_now_ms: Number(state.round.server_now_ms || 0),
          crash_point: state.round.crash_point === null ? null : Number(state.round.crash_point),
        }
      : null;
    return res.json({ ...state, round });
  } catch (error) {
    console.error('crash state error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load crash state' });
  }
});

router.post('/bet', requireAuth, async (req, res) => {
  const gameId = String(req.body?.game_id || '').trim();
  const roundId = req.body?.round_id;
  const panelIndex = Number(req.body?.panel_index);
  const betAmount = Number(req.body?.bet_amount);
  const autoCashoutRaw = req.body?.auto_cashout;
  const autoCashout = autoCashoutRaw === null || autoCashoutRaw === undefined || autoCashoutRaw === ''
    ? null
    : Number(autoCashoutRaw);

  if (!gameId || !roundId || Number.isNaN(panelIndex) || Number.isNaN(betAmount)) {
    return res.status(400).json({ error: 'game_id, round_id, panel_index, and bet_amount are required' });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('place_crash_bet', {
      p_game_id: gameId,
      p_round_id: roundId,
      p_user_id: req.user.id,
      p_panel_index: panelIndex,
      p_bet_amount: betAmount,
      p_auto_cashout: autoCashout,
    });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (error) {
    console.error('place crash bet error:', error);
    return res.status(500).json({ error: error.message || 'Failed to place crash bet' });
  }
});

router.post('/cancel', requireAuth, async (req, res) => {
  const betId = req.body?.bet_id;
  if (!betId) {
    return res.status(400).json({ error: 'bet_id is required' });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('cancel_crash_bet', {
      p_bet_id: betId,
      p_user_id: req.user.id,
    });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (error) {
    console.error('cancel crash bet error:', error);
    return res.status(500).json({ error: error.message || 'Failed to cancel crash bet' });
  }
});

router.post('/cashout', requireAuth, async (req, res) => {
  const betId = req.body?.bet_id;
  if (!betId) {
    return res.status(400).json({ error: 'bet_id is required' });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('cashout_crash_bet', {
      p_bet_id: betId,
      p_user_id: req.user.id,
    });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (error) {
    console.error('cashout crash bet error:', error);
    return res.status(500).json({ error: error.message || 'Failed to cash out crash bet' });
  }
});

module.exports = router;
