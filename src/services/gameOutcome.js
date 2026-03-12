/**
 * Slot/casino outcome: RNG + reward pools + admin-controlled win tiers.
 * Design: frequent small wins, less medium, less big, rare mega — house profit safe (1 or 100k users).
 * All values are admin-editable per game in game_profit_settings.
 */
const { supabaseAdmin } = require('./supabase');

function secureRandom() {
  const arr = new Uint32Array(1);
  require('crypto').randomFillSync(arr);
  return arr[0] / (0xffffffff + 1);
}

/** Default slot distribution: small often, medium/big less, mega rare. Sum of win_pct + loss_rate = 100. */
const DEFAULT_SETTINGS = {
  profit_margin: 22,
  max_win_multiplier: 25,
  loss_rate: 48,
  small_win_pool_pct: 32,
  medium_win_pool_pct: 22,
  big_win_pool_pct: 10,
  jackpot_pool_pct: 6,
  max_win_cap: 200,
  jackpot_cooldown_hours: 48,
  big_win_cooldown_hours: 24,
  small_win_pct: 36,
  medium_win_pct: 12,
  big_win_pct: 3,
  jackpot_win_pct: 0.8,
};

async function getGameProfitSettings(gameId) {
  const { data } = await supabaseAdmin
    .from('game_profit_settings')
    .select('*')
    .eq('game_id', gameId)
    .single();
  if (data) {
    return {
      profit_margin: Math.max(15, Math.min(40, Number(data.profit_margin))),
      max_win_multiplier: Number(data.max_win_multiplier || 25),
      loss_rate: Math.max(40, Math.min(90, Number(data.loss_rate ?? 60))),
      small_win_pool_pct: Number(data.small_win_pool_pct ?? 30),
      medium_win_pool_pct: Number(data.medium_win_pool_pct ?? 20),
      big_win_pool_pct: Number(data.big_win_pool_pct ?? 10),
      jackpot_pool_pct: Number(data.jackpot_pool_pct ?? 5),
      max_win_cap: Number(data.max_win_cap ?? 200),
      jackpot_cooldown_hours: Number(data.jackpot_cooldown_hours ?? 48),
      big_win_cooldown_hours: Number(data.big_win_cooldown_hours ?? 24),
      small_win_pct: Number(data.small_win_pct ?? 25),
      medium_win_pct: Number(data.medium_win_pct ?? 10),
      big_win_pct: Number(data.big_win_pct ?? 4),
      jackpot_win_pct: Number(data.jackpot_win_pct ?? 1),
    };
  }
  return DEFAULT_SETTINGS;
}

async function getPoolBalances(gameId) {
  const { data } = await supabaseAdmin
    .from('reward_pools')
    .select('pool_type, balance')
    .eq('game_id', gameId || 'global');
  const pools = { small_win: 0, medium_win: 0, big_win: 0, jackpot: 0 };
  if (data) {
    data.forEach((p) => {
      if (p.pool_type in pools) pools[p.pool_type] = Number(p.balance);
    });
  }
  return pools;
}

async function checkUserCooldown(userId, winType, cooldownHours, currentPoolBalance) {
  const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from('user_win_cooldowns')
    .select('id, win_amount')
    .eq('user_id', userId)
    .eq('win_type', winType)
    .gte('last_win_at', cutoff)
    .order('last_win_at', { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return false;
  const lastWinAmount = Number(data[0].win_amount) || 0;
  if (currentPoolBalance >= lastWinAmount) return false;
  return true;
}

async function recordUserWin(userId, winType, winAmount, gameId) {
  await supabaseAdmin.from('user_win_cooldowns').insert({
    user_id: userId,
    win_type: winType,
    win_amount: winAmount,
    game_id: gameId,
    last_win_at: new Date().toISOString(),
  });
}

/** Lucky 777: win must be expressible as digit × multiplier. Frontend: bet<5 → digit 1–99, bet≥5 → 1–999. Mults: bet≤5 → 1–50, else 1–500. */
function roundToDisplayableLucky777(maxWin, bet) {
  if (!maxWin || maxWin < 1) return 0;
  const mults = bet <= 5 ? [1, 2, 3, 5, 10, 25, 50] : [1, 2, 3, 5, 10, 25, 50, 100, 200, 500];
  const maxDigit = bet >= 5 ? 999 : 99;
  let best = 0;
  for (const mult of mults) {
    const digit = Math.floor(maxWin / mult);
    if (digit >= 1 && digit <= maxDigit) {
      const displayable = digit * mult;
      if (displayable <= maxWin && displayable > best) best = displayable;
    }
  }
  return best || Math.min(1, maxWin);
}

async function calculateOutcome(userId, betAmount, gameType, gameId, isFreeSpin = false) {
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const [profileRes, globalStatsRes, profitSettings, pools, todayGameRes] = await Promise.all([
    supabaseAdmin.from('profiles').select('forced_result').eq('user_id', userId).single(),
    supabaseAdmin.rpc('get_total_bets_and_wins'),
    getGameProfitSettings(gameId),
    getPoolBalances(gameId),
    supabaseAdmin
      .from('game_sessions')
      .select('bet_amount, win_amount')
      .eq('game_id', gameId)
      .gte('created_at', todayStart),
  ]);

  const configMarginRatio = profitSettings.profit_margin / 100;
  const maxWinCap = profitSettings.max_win_cap;

  const forcedResult = profileRes.data?.forced_result ?? null;
  if (forcedResult === 'loss') return { outcome: 'loss', maxWinAmount: 0, availablePool: 0 };
  if (forcedResult === 'big_win') return { outcome: 'big_win', maxWinAmount: Math.round(betAmount * 15), availablePool: 999999 };
  if (forcedResult === 'mega_win') return { outcome: 'mega_win', maxWinAmount: Math.round(betAmount * Math.min(maxWinCap, 100)), availablePool: 999999 };
  if (forcedResult === 'small_win') return { outcome: 'small_win', maxWinAmount: Math.round(betAmount * 1.5), availablePool: 999999 };

  const oneTimeResults = {
    one_big_win: { outcome: 'big_win', maxWinAmount: Math.round(betAmount * 15), availablePool: 999999 },
    one_mega_win: { outcome: 'mega_win', maxWinAmount: Math.round(betAmount * Math.min(maxWinCap, 100)), availablePool: 999999 },
    one_small_win: { outcome: 'small_win', maxWinAmount: Math.round(betAmount * 1.5), availablePool: 999999 },
    one_loss: { outcome: 'loss', maxWinAmount: 0, availablePool: 0 },
  };
  if (forcedResult && oneTimeResults[forcedResult]) {
    await supabaseAdmin.from('profiles').update({ forced_result: null }).eq('user_id', userId);
    return oneTimeResults[forcedResult];
  }

  // Free spins: no pool distribution or deduct — outcome only, house absorbs cost
  if (!isFreeSpin) {
    await supabaseAdmin.rpc('distribute_bet_to_pools', {
      p_game_id: gameId,
      p_bet_amount: betAmount,
      p_small_pct: profitSettings.small_win_pool_pct,
      p_medium_pct: profitSettings.medium_win_pool_pct,
      p_big_pct: profitSettings.big_win_pool_pct,
      p_jackpot_pct: profitSettings.jackpot_pool_pct,
    });
  }

  const updatedPools = isFreeSpin ? pools : await getPoolBalances(gameId);

  const globalStats = globalStatsRes.data;
  let globalTotalBets = 0,
    globalTotalWins = 0;
  if (globalStats && globalStats.length > 0) {
    globalTotalBets = Number(globalStats[0].total_bets) || 0;
    globalTotalWins = Number(globalStats[0].total_wins) || 0;
  }
  globalTotalBets += betAmount;
  const globalAvailablePool = Math.max(0, globalTotalBets * (1 - configMarginRatio) - globalTotalWins);
  const targetRTP = 100 - profitSettings.profit_margin;
  const globalCurrentRTP = globalTotalBets > 0 ? (globalTotalWins / globalTotalBets) * 100 : 0;
  const rtpExcess = Math.max(0, globalCurrentRTP - targetRTP);
  const rtpPenalty = Math.min(rtpExcess * 2, 30);

  if (globalAvailablePool <= 0) return { outcome: 'loss', maxWinAmount: 0, availablePool: 0 };

  const todayGameSessions = todayGameRes.data || [];
  let todayBets = betAmount,
    todayWins = 0;
  todayGameSessions.forEach((s) => {
    todayBets += Number(s.bet_amount) || 0;
    todayWins += Number(s.win_amount) || 0;
  });
  const todayProfit = todayBets - todayWins;
  const todayMinProfit = todayBets * configMarginRatio;
  const dailyProfitHealthy = todayBets < 200 || todayProfit >= todayMinProfit;

  const roll = secureRandom() * 100;
  const effectiveLossRate = Math.min(95, profitSettings.loss_rate + rtpPenalty);
  const effectiveSmallPct = profitSettings.small_win_pct * (1 - rtpPenalty / 100);
  const effectiveMedPct = profitSettings.medium_win_pct * (1 - rtpPenalty / 100);
  const effectiveBigPct = profitSettings.big_win_pct * (1 - rtpPenalty / 100);
  const effectiveJackpotPct = profitSettings.jackpot_win_pct * (1 - rtpPenalty / 100);
  const lossCutoff = effectiveLossRate;
  const smallCutoff = lossCutoff + effectiveSmallPct;
  const medCutoff = smallCutoff + effectiveMedPct;
  const bigCutoff = medCutoff + effectiveBigPct;
  const absoluteMaxWin = Math.round(betAmount * maxWinCap);

  if (roll < lossCutoff) return { outcome: 'loss', maxWinAmount: 0, availablePool: globalAvailablePool };

  if (roll >= bigCutoff && roll < bigCutoff + effectiveJackpotPct) {
    if (isFreeSpin) {
      const mult = 50 + secureRandom() * 150;
      let maxWin = Math.min(Math.round(betAmount * mult), absoluteMaxWin);
      if (gameId === 'lucky-777') maxWin = roundToDisplayableLucky777(maxWin, betAmount);
      if (maxWin >= betAmount * 20) return { outcome: 'mega_win', maxWinAmount: maxWin, availablePool: globalAvailablePool };
    }
    const onCooldown = await checkUserCooldown(userId, 'jackpot', profitSettings.jackpot_cooldown_hours, updatedPools.jackpot);
    if (!onCooldown && dailyProfitHealthy && updatedPools.jackpot >= betAmount * 50) {
      const mult = 50 + secureRandom() * 150;
      const maxWin = Math.min(
        Math.round(betAmount * mult),
        absoluteMaxWin,
        Math.floor(updatedPools.jackpot * 0.8),
        Math.floor(globalAvailablePool)
      );
      if (maxWin >= betAmount * 20) {
        if (gameId === 'lucky-777') maxWin = roundToDisplayableLucky777(maxWin, betAmount);
        if (maxWin >= betAmount * 20) {
          await supabaseAdmin.rpc('deduct_from_pool', { p_game_id: gameId, p_pool_type: 'jackpot', p_amount: maxWin });
          await recordUserWin(userId, 'jackpot', maxWin, gameId);
          return { outcome: 'mega_win', maxWinAmount: maxWin, availablePool: globalAvailablePool, poolUsed: 'jackpot' };
        }
      }
    }
  }

  // Big-win range should not overlap jackpot range.
  if (roll >= medCutoff && roll < bigCutoff) {
    if (isFreeSpin) {
      const mult = 10 + secureRandom() * 20;
      let maxWin = Math.min(Math.round(betAmount * mult), absoluteMaxWin);
      if (gameId === 'lucky-777') maxWin = roundToDisplayableLucky777(maxWin, betAmount);
      if (maxWin >= betAmount * 5) return { outcome: 'big_win', maxWinAmount: maxWin, availablePool: globalAvailablePool };
    }
    const onCooldown = await checkUserCooldown(userId, 'big_win', profitSettings.big_win_cooldown_hours, updatedPools.big_win);
    if (!onCooldown && dailyProfitHealthy && updatedPools.big_win >= betAmount * 10) {
      const mult = 10 + secureRandom() * 20;
      const maxWin = Math.min(
        Math.round(betAmount * mult),
        absoluteMaxWin,
        Math.floor(updatedPools.big_win * 0.5),
        Math.floor(globalAvailablePool)
      );
      if (maxWin >= betAmount * 5) {
        if (gameId === 'lucky-777') maxWin = roundToDisplayableLucky777(maxWin, betAmount);
        if (maxWin >= betAmount * 5) {
          await supabaseAdmin.rpc('deduct_from_pool', { p_game_id: gameId, p_pool_type: 'big_win', p_amount: maxWin });
          await recordUserWin(userId, 'big_win', maxWin, gameId);
          return { outcome: 'big_win', maxWinAmount: maxWin, availablePool: globalAvailablePool, poolUsed: 'big_win' };
        }
      }
    }
  }

  if (roll >= smallCutoff && (isFreeSpin || updatedPools.medium_win >= betAmount * 2)) {
    const mult = 2 + secureRandom() * 3;
    const maxWin = isFreeSpin
      ? Math.min(Math.round(betAmount * mult), absoluteMaxWin)
      : Math.min(
          Math.round(betAmount * mult),
          absoluteMaxWin,
          Math.floor(updatedPools.medium_win * 0.3),
          Math.floor(globalAvailablePool)
        );
    if (maxWin > 0) {
      let finalWin = gameId === 'lucky-777' ? roundToDisplayableLucky777(maxWin, betAmount) : maxWin;
      if (finalWin > 0) {
        if (!isFreeSpin) await supabaseAdmin.rpc('deduct_from_pool', { p_game_id: gameId, p_pool_type: 'medium_win', p_amount: finalWin });
        return { outcome: 'medium_win', maxWinAmount: finalWin, availablePool: globalAvailablePool, poolUsed: isFreeSpin ? undefined : 'medium_win' };
      }
    }
  }

  if (roll >= lossCutoff && (isFreeSpin || updatedPools.small_win >= betAmount * 0.5)) {
    // Random mult 1.2x–2x so bet 2x → win ~2x (consistent scaling)
    const mult = 1.2 + secureRandom() * 0.8;
    const poolCap = isFreeSpin ? Math.round(betAmount * 2) : Math.max(
      Math.floor(updatedPools.small_win * 0.25),
      Math.round(betAmount * 2)
    );
    const globalCap = Math.floor(globalAvailablePool);
    let maxWin = Math.max(1, Math.min(
      Math.round(betAmount * mult),
      absoluteMaxWin,
      poolCap,
      globalCap
    ));
    // When pool is low and we'd always hit same cap (e.g. 7), add variety: pick random 50–100% of cap
    if (!isFreeSpin && globalCap > 0 && globalCap <= betAmount * 1.5) {
      const varied = Math.max(1, Math.round(globalCap * (0.5 + secureRandom() * 0.5)));
      maxWin = Math.min(maxWin, varied);
    }
    if (maxWin > 0) {
      let finalWin = gameId === 'lucky-777' ? roundToDisplayableLucky777(maxWin, betAmount) : maxWin;
      if (finalWin > 0) {
        if (!isFreeSpin) await supabaseAdmin.rpc('deduct_from_pool', { p_game_id: gameId, p_pool_type: 'small_win', p_amount: finalWin });
        return { outcome: 'small_win', maxWinAmount: finalWin, availablePool: globalAvailablePool, poolUsed: isFreeSpin ? undefined : 'small_win' };
      }
    }
  }

  return { outcome: 'loss', maxWinAmount: 0, availablePool: globalAvailablePool };
}

module.exports = { calculateOutcome, secureRandom };
