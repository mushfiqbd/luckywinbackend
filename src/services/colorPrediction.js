/**
 * Port of Supabase Edge Function color-prediction-outcome.
 */
const { supabaseAdmin } = require('./supabase');
const crypto = require('crypto');

function secureRandom() {
  const arr = new Uint32Array(1);
  crypto.randomFillSync(arr);
  return arr[0] / (0xffffffff + 1);
}

function numberToColor(num) {
  if (num === 0 || num === 5) return 'violet';
  return num % 2 === 0 ? 'red' : 'green';
}

function numberToColors(num) {
  if (num === 0) return ['red', 'violet'];
  if (num === 5) return ['green', 'violet'];
  return num % 2 === 0 ? ['red'] : ['green'];
}

function calculatePayout(betType, betValue, winningNumber, betAmount) {
  const winColors = numberToColors(winningNumber);
  if (betType === 'number') {
    if (parseInt(betValue, 10) === winningNumber) return betAmount * 9;
    return 0;
  }
  if (betType === 'color') {
    if (betValue === 'violet' && winColors.includes('violet')) return betAmount * 4.8;
    if (betValue === 'red' && winColors.includes('red')) {
      if (winningNumber === 0) return betAmount * 1.5;
      return betAmount * 2;
    }
    if (betValue === 'green' && winColors.includes('green')) {
      if (winningNumber === 5) return betAmount * 1.5;
      return betAmount * 2;
    }
  }
  return 0;
}

function calculateAggregatePayout(bets, winningNumber) {
  return bets.reduce((sum, bet) => sum + calculatePayout(bet.type, bet.value, winningNumber, bet.amount), 0);
}

async function loadPredictionContext(userId, totalBetAmount, gameId) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const [profitSettingsRes, globalStatsRes, windowRes, recentWinsRes] = await Promise.all([
    supabaseAdmin.from('game_profit_settings').select('profit_margin, max_win_multiplier, loss_rate').eq('game_id', gameId).single(),
    supabaseAdmin.rpc('get_total_bets_and_wins'),
    supabaseAdmin.from('game_sessions').select('bet_amount, win_amount').eq('game_id', gameId).gte('created_at', fiveMinAgo),
    supabaseAdmin.from('game_sessions').select('result').eq('user_id', userId).eq('game_id', gameId).order('created_at', { ascending: false }).limit(10),
  ]);

  const profitSettings = profitSettingsRes.data || { profit_margin: 25, max_win_multiplier: 9, loss_rate: 70 };
  const configMarginRatio = Math.max(5, Math.min(40, Number(profitSettings.profit_margin))) / 100;
  const lossRate = Math.max(50, Math.min(99, Number(profitSettings.loss_rate ?? 70)));

  let globalTotalBets = 0;
  let globalTotalWins = 0;
  if (globalStatsRes.data && globalStatsRes.data.length > 0) {
    globalTotalBets = Number(globalStatsRes.data[0].total_bets) || 0;
    globalTotalWins = Number(globalStatsRes.data[0].total_wins) || 0;
  }
  const globalAvailablePool = Math.max(0, globalTotalBets * (1 - configMarginRatio) - globalTotalWins);

  const windowSessions = windowRes.data || [];
  let windowBets = 0;
  let windowWins = 0;
  windowSessions.forEach((session) => {
    windowBets += Number(session.bet_amount) || 0;
    windowWins += Number(session.win_amount) || 0;
  });
  windowBets += totalBetAmount;
  const windowPool = Math.max(0, windowBets * (1 - configMarginRatio) - windowWins);
  const availablePool = Math.min(globalAvailablePool, windowPool);

  const recentResults = (recentWinsRes.data || []).map((row) => row.result);
  let consecutiveWins = 0;
  for (const result of recentResults) {
    if (result === 'win') consecutiveWins++;
    else break;
  }

  return {
    availablePool,
    lossRate,
    streakPenalty: Math.min(consecutiveWins * 8, 25),
  };
}

async function computeOutcome(userId, betAmount, betType, betValue, periodId) {
  const gameId = 'color-prediction';
  const { availablePool, lossRate, streakPenalty } = await loadPredictionContext(userId, betAmount, gameId);
  const effectiveLossRate = Math.min(98, lossRate + streakPenalty);

  const roll = secureRandom() * 100;
  const isLoss = roll < effectiveLossRate || availablePool < betAmount * 0.5;

  let winningNumber;
  if (isLoss) {
    const losingNumbers = [];
    for (let n = 0; n <= 9; n++) {
      if (calculatePayout(betType, betValue, n, betAmount) === 0) losingNumbers.push(n);
    }
    winningNumber = losingNumbers.length > 0 ? losingNumbers[Math.floor(secureRandom() * losingNumbers.length)] : Math.floor(secureRandom() * 10);
  } else {
    const winningNumbers = [];
    for (let n = 0; n <= 9; n++) {
      const payout = calculatePayout(betType, betValue, n, betAmount);
      if (payout > 0) winningNumbers.push({ number: n, payout });
    }
    if (winningNumbers.length === 0) {
      winningNumber = Math.floor(secureRandom() * 10);
    } else {
      winningNumbers.sort((a, b) => a.payout - b.payout);
      const winPayout = winningNumbers[0].payout;
      if (winPayout > availablePool) {
        const losingNumbers = [];
        for (let n = 0; n <= 9; n++) {
          if (calculatePayout(betType, betValue, n, betAmount) === 0) losingNumbers.push(n);
        }
        winningNumber = losingNumbers.length > 0 ? losingNumbers[Math.floor(secureRandom() * losingNumbers.length)] : Math.floor(secureRandom() * 10);
      } else {
        winningNumber = winningNumbers[0].number;
      }
    }
  }

  const winningColor = numberToColor(winningNumber);
  const winningColors = numberToColors(winningNumber);
  const payout = calculatePayout(betType, betValue, winningNumber, betAmount);
  const isWin = payout > 0;

  return {
    winning_number: winningNumber,
    winning_color: winningColor,
    winning_colors: winningColors,
    payout,
    is_win: isWin,
    period_id: periodId,
    streak_penalty: streakPenalty,
  };
}

async function computeRoundOutcome(userId, bets, periodId) {
  const normalizedBets = Array.isArray(bets)
    ? bets
        .map((bet) => ({
          type: String(bet.type || ''),
          value: String(bet.value || ''),
          amount: Number(bet.amount || 0),
        }))
        .filter((bet) => bet.type && bet.value && bet.amount > 0)
    : [];

  if (normalizedBets.length === 0) {
    throw new Error('No valid bets provided');
  }

  const gameId = 'color-prediction';
  const totalBetAmount = normalizedBets.reduce((sum, bet) => sum + bet.amount, 0);
  const { availablePool, lossRate, streakPenalty } = await loadPredictionContext(userId, totalBetAmount, gameId);
  const effectiveLossRate = Math.min(98, lossRate + streakPenalty);

  const losingNumbers = [];
  const winningNumbers = [];
  for (let number = 0; number <= 9; number++) {
    const payout = calculateAggregatePayout(normalizedBets, number);
    if (payout > 0) winningNumbers.push({ number, payout });
    else losingNumbers.push(number);
  }

  const roll = secureRandom() * 100;
  const shouldLose = roll < effectiveLossRate || availablePool < totalBetAmount * 0.5;

  let winningNumber;
  if (shouldLose && losingNumbers.length > 0) {
    winningNumber = losingNumbers[Math.floor(secureRandom() * losingNumbers.length)];
  } else {
    const affordableWins = winningNumbers
      .filter((entry) => entry.payout <= availablePool)
      .sort((a, b) => a.payout - b.payout);

    if (affordableWins.length > 0) {
      winningNumber = affordableWins[0].number;
    } else if (losingNumbers.length > 0) {
      winningNumber = losingNumbers[Math.floor(secureRandom() * losingNumbers.length)];
    } else {
      winningNumbers.sort((a, b) => a.payout - b.payout);
      winningNumber = winningNumbers[0]?.number ?? Math.floor(secureRandom() * 10);
    }
  }

  const winningColor = numberToColor(winningNumber);
  const winningColors = numberToColors(winningNumber);
  const payout = calculateAggregatePayout(normalizedBets, winningNumber);

  return {
    winning_number: winningNumber,
    winning_color: winningColor,
    winning_colors: winningColors,
    payout,
    is_win: payout > 0,
    period_id: periodId,
    streak_penalty: streakPenalty,
  };
}

module.exports = {
  computeOutcome,
  computeRoundOutcome,
  calculatePayout,
  calculateAggregatePayout,
  numberToColor,
  numberToColors,
};
