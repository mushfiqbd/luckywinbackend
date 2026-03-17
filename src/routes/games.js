const path = require('path');
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { calculateOutcome, secureRandom } = require('../services/gameOutcome');
const {
  computeOutcome,
  computeRoundOutcome,
  calculatePayout: calculateColorPayout,
  numberToColor: colorNumberToColor,
  numberToColors: colorNumberToColors,
} = require('../services/colorPrediction');
const { runBoxingKingSpin } = require('../services/boxingKingSpin');
const { runSuperAceSpin } = require(path.join(__dirname, '..', 'services', 'superAceSpin.js'));
const { runSharedSlotSpin } = require('../services/sharedSlotSpin');
const { supabaseAdmin } = require('../services/supabase');
const { startLudoMatch, getLudoMatchState, rollLudoDice, moveLudoToken, passLudoTurn, abandonLudoMatch } = require('../services/ludoAiGame');

/**
 * POST /api/games/outcome
 * Body: { bet_amount, game_type?, game_id? }
 * Same as Supabase Edge Function game-outcome. Returns { outcome, maxWinAmount, availablePool, multiplier?, poolUsed? }.
 */
router.post('/outcome', requireAuth, async (req, res) => {
  try {
    const { bet_amount, game_type, game_id, is_free_spin } = req.body || {};
    if (!bet_amount || bet_amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    const userId = req.user.id;
    const result = await calculateOutcome(
      userId,
      bet_amount,
      game_type || 'slot',
      game_id || game_type || 'unknown',
      Boolean(is_free_spin)
    );

    if (game_id === 'lucky-spin' && result.outcome !== 'loss') {
      const WHEEL_MULTIPLIERS = [2, 5, 10, 12, 20];
      const maxAffordable = result.maxWinAmount / bet_amount;
      const affordable = WHEEL_MULTIPLIERS.filter((m) => m <= maxAffordable && m * bet_amount <= result.maxWinAmount);
      if (affordable.length === 0) {
        result.outcome = 'loss';
        result.maxWinAmount = 0;
        result.multiplier = 0;
      } else {
        let picked;
        if (result.outcome === 'mega_win') picked = affordable[affordable.length - 1];
        else if (result.outcome === 'big_win') {
          const topHalf = affordable.slice(Math.floor(affordable.length / 2));
          picked = topHalf[Math.floor(secureRandom() * topHalf.length)];
        } else if (result.outcome === 'medium_win') picked = affordable[Math.floor(affordable.length / 2)];
        else picked = affordable[0];
        result.multiplier = picked;
        result.maxWinAmount = Math.round(bet_amount * picked);
      }
    } else if (game_id === 'lucky-spin' && result.outcome === 'loss') {
      result.multiplier = 0;
    }

    return res.json(result);
  } catch (err) {
    console.error('game-outcome error:', err);
    return res.status(500).json({ outcome: 'loss', maxWinAmount: 0, availablePool: 0 });
  }
});

/**
 * POST /api/games/color-prediction-outcome
 * Body: { bet_amount, bet_type, bet_value, period_id? }
 */
router.post('/color-prediction-outcome', requireAuth, async (req, res) => {
  try {
    const { bet_amount, bet_type, bet_value, period_id } = req.body || {};
    if (!bet_amount || bet_amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    const result = await computeOutcome(req.user.id, bet_amount, bet_type, bet_value, period_id);
    return res.json(result);
  } catch (err) {
    console.error('color-prediction-outcome error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/color-prediction-round', requireAuth, async (req, res) => {
  try {
    const rawBets = Array.isArray(req.body?.bets) ? req.body.bets : [];
    const periodId = req.body?.period_id;

    const normalizedBets = rawBets
      .map((bet) => ({
        type: String(bet.type || ''),
        value: String(bet.value || ''),
        amount: Number(bet.amount || 0),
      }))
      .filter((bet) => bet.type && bet.value && bet.amount > 0);

    const totalBet = normalizedBets.reduce((sum, bet) => sum + bet.amount, 0);

    if (normalizedBets.length === 0 || totalBet <= 0 || !periodId) {
      return res.status(400).json({ error: 'Invalid bets' });
    }

    const userId = req.user.id;

    // Ensure there is a round for this period. First settled round defines the global winning number.
    let roundId;
    let winningNumber;
    let winningColor;
    let winningColors;

    const { data: existingRound, error: roundFetchError } = await supabaseAdmin
      .from('color_rounds')
      .select('id, winning_number, winning_color, winning_colors')
      .eq('period_id', periodId)
      .maybeSingle();

    if (roundFetchError) {
      console.error('color-prediction-round: failed to load round', roundFetchError);
      return res.status(500).json({ error: 'Failed to load round' });
    }

    let engineResult;

    if (existingRound && existingRound.winning_number !== null) {
      // Reuse existing outcome so that all players in same period share the same result
      roundId = existingRound.id;
      winningNumber = existingRound.winning_number;
      winningColors =
        Array.isArray(existingRound.winning_colors) && existingRound.winning_colors.length > 0
          ? existingRound.winning_colors
          : colorNumberToColors(winningNumber);
      winningColor = existingRound.winning_color || colorNumberToColor(winningNumber);

      // SAFETY CHECK: Verify total payout won't exceed house limits for this period
      const periodTotalBet = normalizedBets.reduce((sum, bet) => sum + bet.amount, 0);
      const potentialPayout = normalizedBets.reduce(
        (sum, bet) => sum + calculateColorPayout(bet.type, bet.value, winningNumber, bet.amount),
        0
      );
      
      // If payout exceeds 80% of period bets, apply reduction to protect house
      const maxPayoutRatio = 0.8;
      if (potentialPayout > periodTotalBet * maxPayoutRatio) {
        const reductionFactor = (periodTotalBet * maxPayoutRatio) / potentialPayout;
        normalizedBets.forEach(bet => {
          bet.amount = Math.round(bet.amount * reductionFactor * 100) / 100;
        });
      }

      const payout = normalizedBets.reduce(
        (sum, bet) => sum + calculateColorPayout(bet.type, bet.value, winningNumber, bet.amount),
        0
      );

      engineResult = {
        winning_number: winningNumber,
        winning_color: winningColor,
        winning_colors: winningColors,
        payout,
        is_win: payout > 0,
        period_id: periodId,
        streak_penalty: 0,
      };
    } else {
      // First player to resolve this period: run full engine and persist the outcome as the global result
      engineResult = await computeRoundOutcome(userId, normalizedBets, periodId);
      winningNumber = engineResult.winning_number;
      winningColor = engineResult.winning_color;
      winningColors = engineResult.winning_colors;

      const { data: insertedRound, error: insertError } = await supabaseAdmin
        .from('color_rounds')
        .upsert(
          {
            period_id: periodId,
            timer_mode: Number(req.body?.timer_mode || 1),
            status: 'settled',
            winning_number: winningNumber,
            winning_color: winningColor,
            winning_colors: winningColors,
            closing_at: new Date().toISOString(),
            settled_at: new Date().toISOString(),
          },
          { onConflict: 'period_id' }
        )
        .select('id')
        .single();

      if (insertError) {
        console.error('color-prediction-round: failed to upsert round', insertError);
        return res.status(500).json({ error: 'Failed to persist round outcome' });
      }
      roundId = insertedRound.id;
    }

    // Per-bet payouts (for live feed & detailed logs)
    const betRows = [];
    let totalPayout = 0;

    // Snapshot username once for this request
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('username')
      .eq('user_id', userId)
      .maybeSingle();

    const usernameSnapshot = profile?.username || null;

    for (const bet of normalizedBets) {
      const payout = calculateColorPayout(bet.type, bet.value, winningNumber, bet.amount);
      totalPayout += payout;
      betRows.push({
        round_id: roundId,
        period_id: periodId,
        user_id: userId,
        username_snapshot: usernameSnapshot,
        bet_type: bet.type,
        bet_value: bet.value,
        bet_amount: bet.amount,
        payout,
        is_win: payout > 0,
      });
    }

    if (betRows.length > 0) {
      const { error: betInsertError } = await supabaseAdmin.from('color_bets').insert(betRows);
      if (betInsertError) {
        console.error('color-prediction-round: failed to insert color_bets', betInsertError);
      }
    }

    const finalPayout = totalPayout;
    const multiplier = totalBet > 0 && finalPayout > 0 ? Math.round((finalPayout / totalBet) * 100) / 100 : 0;

    const { data, error } = await supabaseAdmin.rpc('settle_generic_game_round', {
      p_user_id: req.user.id,
      p_game_id: 'color-prediction',
      p_game_name: 'Color Prediction',
      p_game_type: 'color',
      p_bet_amount: totalBet,
      p_total_win: finalPayout,
      p_result: finalPayout > 0 ? 'win' : 'loss',
      p_multiplier: multiplier || null,
    });

    if (error) {
      return res.status(400).json({ error: error.message || 'Failed to settle round' });
    }

    return res.json({
      ...engineResult,
      total_bet: totalBet,
      newBalance: Number(data?.new_balance ?? 0),
      round_id: roundId,
    });
  } catch (err) {
    console.error('color-prediction-round error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /api/games/boxing-king-spin
 * Body: { bet }
 * Full Boxing King slot: profit-margin safe + RNG, wallet deduct/credit, game_sessions, super_ace_spin_logs.
 */
router.post('/boxing-king-spin', requireAuth, async (req, res) => {
  try {
    const { bet } = req.body || {};
    const result = await runBoxingKingSpin(req.user.id, Number(bet));
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error('boxing-king-spin error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/games/super-ace-spin
 * Body: { bet }
 * Full Super Ace slot: profit-margin safe + RNG, wallet, game_sessions, super_ace_spin_logs.
 */
router.post('/super-ace-spin', requireAuth, async (req, res) => {
  try {
    const { bet } = req.body || {};
    const result = await runSuperAceSpin(req.user.id, Number(bet));
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error('super-ace-spin error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/shared-slot-spin', requireAuth, async (req, res) => {
  try {
    const { bet, game_id, game_name } = req.body || {};
    const result = await runSharedSlotSpin(req.user.id, Number(bet), String(game_id || ''), String(game_name || 'Slot Game'));
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error('shared-slot-spin error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/ludo/start', requireAuth, async (req, res) => {
  try {
    const levelIdx = Number(req.body?.levelIdx);
    const result = await startLudoMatch(req.user.id, levelIdx);
    return res.json(result);
  } catch (err) {
    console.error('ludo start error:', err);
    return res.status(400).json({ error: err.message || 'Failed to start Ludo match' });
  }
});

router.post('/ludo/state', requireAuth, async (req, res) => {
  try {
    const matchId = req.body?.matchId || null;
    const result = await getLudoMatchState(req.user.id, matchId);
    return res.json(result);
  } catch (err) {
    console.error('ludo state error:', err);
    return res.status(400).json({ error: err.message || 'Failed to load Ludo match' });
  }
});

router.post('/ludo/roll', requireAuth, async (req, res) => {
  try {
    const matchId = String(req.body?.matchId || '').trim();
    const result = await rollLudoDice(req.user.id, matchId);
    return res.json(result);
  } catch (err) {
    console.error('ludo roll error:', err);
    return res.status(400).json({ error: err.message || 'Failed to roll Ludo dice' });
  }
});

router.post('/ludo/move', requireAuth, async (req, res) => {
  try {
    const matchId = String(req.body?.matchId || '').trim();
    const tokenIdx = Number(req.body?.tokenIdx);
    const result = await moveLudoToken(req.user.id, matchId, tokenIdx);
    return res.json(result);
  } catch (err) {
    console.error('ludo move error:', err);
    return res.status(400).json({ error: err.message || 'Failed to move Ludo token' });
  }
});

router.post('/ludo/pass', requireAuth, async (req, res) => {
  try {
    const matchId = String(req.body?.matchId || '').trim();
    const result = await passLudoTurn(req.user.id, matchId);
    return res.json(result);
  } catch (err) {
    console.error('ludo pass error:', err);
    return res.status(400).json({ error: err.message || 'Failed to pass Ludo turn' });
  }
});

router.post('/ludo/abandon', requireAuth, async (req, res) => {
  try {
    const matchId = String(req.body?.matchId || '').trim();
    const result = await abandonLudoMatch(req.user.id, matchId);
    return res.json(result);
  } catch (err) {
    console.error('ludo abandon error:', err);
    return res.status(400).json({ error: err.message || 'Failed to abandon Ludo match' });
  }
});

module.exports = router;
