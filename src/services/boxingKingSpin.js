/**
 * Boxing King (Sweet Bonanza) slot — 5x3, 25 paylines.
 * Profit-margin safe + RNG; ported from supabase/functions/boxing-king-spin.
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');

const VALID_BETS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const GAME_ID = 'sweet-bonanza';
const DEFAULT_PROFIT_MARGIN = 25;
const MAX_WIN_CAP = 5000;
const FREE_SPIN_TRIGGER = 3;
const FREE_SPIN_AWARD = 10;

// ─── Symbol definitions ───
const BOXER = { id: 'boxer', payouts: { 2: 0.5, 3: 5, 4: 15, 5: 50 }, weight: 8, isWild: false, isScatter: false };
const GLOVES = { id: 'gloves', payouts: { 3: 2.5, 4: 8, 5: 25 }, weight: 10, isWild: false, isScatter: false };
const TROPHY = { id: 'trophy', payouts: { 3: 1.5, 4: 5, 5: 15 }, weight: 12, isWild: false, isScatter: false };
const SYM_A = { id: 'A', payouts: { 3: 1, 4: 3, 5: 10 }, weight: 16, isWild: false, isScatter: false };
const SYM_K = { id: 'K', payouts: { 3: 0.8, 4: 2.5, 5: 8 }, weight: 17, isWild: false, isScatter: false };
const SYM_Q = { id: 'Q', payouts: { 3: 0.6, 4: 2, 5: 6 }, weight: 18, isWild: false, isScatter: false };
const SYM_J = { id: 'J', payouts: { 3: 0.5, 4: 1.5, 5: 5 }, weight: 19, isWild: false, isScatter: false };
const SYM_10 = { id: '10', payouts: { 3: 0.4, 4: 1.2, 5: 4 }, weight: 20, isWild: false, isScatter: false };
const WILD = { id: 'wild', payouts: { 2: 1, 3: 10, 4: 50, 5: 200 }, weight: 3, isWild: true, isScatter: false };
const SCATTER = { id: 'scatter', payouts: { 3: 2, 4: 10, 5: 50 }, weight: 2, isWild: false, isScatter: true };

const ALL_SYMBOLS = [BOXER, GLOVES, TROPHY, SYM_A, SYM_K, SYM_Q, SYM_J, SYM_10, WILD, SCATTER];
const NORMAL_SYMBOLS = ALL_SYMBOLS.filter((s) => !s.isWild && !s.isScatter);

const ROWS = 3;
const COLS = 5;

const PAYLINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [0, 1, 1, 1, 0],
  [2, 1, 1, 1, 2], [1, 0, 1, 0, 1], [1, 2, 1, 2, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 2, 0, 2, 0], [2, 0, 2, 0, 2], [0, 2, 2, 2, 0],
  [2, 0, 0, 0, 2], [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [1, 0, 2, 0, 1], [1, 2, 0, 2, 1],
];

function buildReelStrip(scatterW, wildW) {
  const symbols = ALL_SYMBOLS.map((s) => ({
    ...s,
    weight: s.isScatter ? scatterW : s.isWild ? wildW : s.weight,
  }));
  const totalWeight = symbols.reduce((a, s) => a + s.weight, 0);
  return { symbols, totalWeight };
}

const BASE_REEL_STRIPS = [
  buildReelStrip(1, 2), buildReelStrip(2, 3), buildReelStrip(3, 4), buildReelStrip(2, 3), buildReelStrip(1, 2),
];
const FREE_REEL_STRIPS = [
  buildReelStrip(2, 5), buildReelStrip(3, 6), buildReelStrip(4, 8), buildReelStrip(3, 6), buildReelStrip(2, 5),
];

function secureRandom() {
  const arr = new Uint32Array(1);
  crypto.randomFillSync(arr);
  return arr[0] / (0xffffffff + 1);
}

function pickFromReel(strip) {
  let r = secureRandom() * strip.totalWeight;
  for (const s of strip.symbols) {
    r -= s.weight;
    if (r <= 0) return { ...s };
  }
  return { ...strip.symbols[strip.symbols.length - 1] };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = (hash << 5) - hash + ch;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function pickWinPositions(seed, total, winCount) {
  const positions = Array.from({ length: total }, (_, i) => i);
  let s = seed;
  for (let i = positions.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return positions.slice(0, winCount);
}

function simplifyGrid(grid) {
  return grid.map((row) => row.map((s) => ({ id: s.id, isWild: s.isWild, isScatter: s.isScatter })));
}

function generateGrid(freeSpinMode = false) {
  const strips = freeSpinMode ? FREE_REEL_STRIPS : BASE_REEL_STRIPS;
  const grid = [];
  for (let r = 0; r < ROWS; r++) grid.push([]);
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      grid[row].push(pickFromReel(strips[col]));
    }
  }
  return grid;
}

function wouldCreatePaylineWin(grid, row, col, sym) {
  if (col < 2) return false;
  for (const payline of PAYLINES) {
    if (payline[col] !== row) continue;
    let matchId = '';
    let allMatch = true;
    for (let c = 0; c < col; c++) {
      const pr = payline[c];
      if (!grid[pr] || !grid[pr][c]) {
        allMatch = false;
        break;
      }
      const cell = grid[pr][c];
      if (c === 0) matchId = cell.isWild ? sym.id : cell.id;
      else if (cell.id !== matchId && !cell.isWild) {
        allMatch = false;
        break;
      }
    }
    if (allMatch && (sym.id === matchId || sym.isWild)) return true;
  }
  return false;
}

function generateNoWinGrid() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) grid.push([]);
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      let sym;
      let attempts = 0;
      do {
        const idx = Math.floor(secureRandom() * NORMAL_SYMBOLS.length);
        sym = { ...NORMAL_SYMBOLS[idx] };
        attempts++;
      } while (attempts < 50 && wouldCreatePaylineWin(grid, row, col, sym));
      grid[row].push(sym);
    }
  }
  return grid;
}

function generateSmallWinGrid(freeSpinMode = false) {
  const grid = generateGrid(freeSpinMode);
  const lowSyms = [SYM_J, SYM_Q, SYM_K, SYM_10];
  const sym = lowSyms[Math.floor(secureRandom() * lowSyms.length)];
  for (let c = 0; c < 3; c++) grid[1][c] = { ...sym };
  for (let c = 3; c < COLS; c++) {
    if (grid[1][c].id === sym.id || grid[1][c].isWild) {
      const other = NORMAL_SYMBOLS.filter((s) => s.id !== sym.id);
      grid[1][c] = { ...other[Math.floor(secureRandom() * other.length)] };
    }
  }
  return grid;
}

function generateBigWinGrid(freeSpinMode = false) {
  const grid = generateGrid(freeSpinMode);
  const medSyms = [GLOVES, TROPHY, SYM_A];
  const sym = medSyms[Math.floor(secureRandom() * medSyms.length)];
  const matchLen = secureRandom() < 0.5 ? 4 : 5;
  for (let c = 0; c < matchLen; c++) grid[1][c] = { ...sym };
  return grid;
}

function generateMegaWinGrid(freeSpinMode = false) {
  const grid = generateGrid(freeSpinMode);
  const sym = BOXER;
  for (let c = 0; c < COLS; c++) {
    grid[0][c] = { ...sym };
    grid[1][c] = { ...sym };
  }
  return grid;
}

function evaluatePaylineWins(grid, betPerLine) {
  const wins = [];
  for (let pi = 0; pi < PAYLINES.length; pi++) {
    const payline = PAYLINES[pi];
    const firstSym = grid[payline[0]][0];
    if (firstSym.isScatter) continue;
    let matchSymId = firstSym.isWild ? '' : firstSym.id;
    let matchCount = 1;
    const positions = [[payline[0], 0]];
    for (let col = 1; col < COLS; col++) {
      const cell = grid[payline[col]][col];
      if (cell.isScatter) break;
      if (cell.isWild) {
        matchCount++;
        positions.push([payline[col], col]);
      } else if (matchSymId === '' || cell.id === matchSymId) {
        if (matchSymId === '') matchSymId = cell.id;
        matchCount++;
        positions.push([payline[col], col]);
      } else break;
    }
    if (matchCount < 2) continue;
    const symDef = matchSymId === '' ? WILD : ALL_SYMBOLS.find((s) => s.id === matchSymId) || WILD;
    const payout = symDef.payouts[matchCount] ?? 0;
    if (payout <= 0) continue;
    const winAmount = Math.round(betPerLine * payout * 100) / 100;
    wins.push({ paylineIndex: pi, symbolId: symDef.id, matchCount, payout: winAmount, positions });
  }
  return wins;
}

function evaluateScatterWins(grid, totalBet) {
  const positions = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c].isScatter) positions.push([r, c]);
    }
  }
  const count = positions.length;
  const scatterPayout = SCATTER.payouts[count] ?? 0;
  return { count, payout: Math.round(totalBet * scatterPayout * 100) / 100, positions };
}

function resolveBonusFight() {
  const roll = secureRandom() * 100;
  let multiplier, tier;
  if (roll < 2) {
    multiplier = 50;
    tier = 'KNOCKOUT';
  } else if (roll < 10) {
    multiplier = 25;
    tier = 'TKO';
  } else if (roll < 25) {
    multiplier = 10;
    tier = 'UPPERCUT';
  } else if (roll < 50) {
    multiplier = 5;
    tier = 'HOOK';
  } else {
    multiplier = 2;
    tier = 'JAB';
  }
  return { triggered: true, multiplier, tier };
}

function cascadeGrid(grid, winPositions, freeSpinMode = false) {
  const newGrid = grid.map((row) => row.map((s) => ({ ...s })));
  const strips = freeSpinMode ? FREE_REEL_STRIPS : BASE_REEL_STRIPS;
  for (let col = 0; col < COLS; col++) {
    const remaining = [];
    for (let row = 0; row < ROWS; row++) {
      if (!winPositions.has(`${row}-${col}`)) remaining.push(newGrid[row][col]);
    }
    const removed = ROWS - remaining.length;
    const newSyms = Array.from({ length: removed }, () => pickFromReel(strips[col]));
    const fullCol = [...newSyms, ...remaining];
    for (let row = 0; row < ROWS; row++) newGrid[row][col] = fullCol[row];
  }
  return newGrid;
}

// Same 4 tiers as Super Ace for reward_pools and frontend
function detectWinTier(totalWin, bet) {
  if (!bet || totalWin <= 0) return 'loss';
  const ratio = totalWin / bet;
  if (ratio >= 20) return 'mega_win';
  if (ratio >= 10) return 'big_win';
  if (ratio >= 5) return 'medium_win';
  if (ratio > 0) return 'small_win';
  return 'loss';
}

async function runBoxingKingSpin(userId, bet) {
  if (!VALID_BETS.includes(bet)) {
    return { error: 'Invalid bet amount' };
  }

  const betPerLine = bet / 25;

  // ─── FAST: All initial reads in parallel (casino-grade latency) ───
  const [
    sessionRes,
    walletRes,
    profitSettingsRes,
    profileRes,
    globalStatsRes,
    gameStatsRes,
    spinCountRes,
  ] = await Promise.all([
    supabaseAdmin.from('super_ace_sessions').select('*').eq('user_id', userId).eq('game_id', GAME_ID).eq('active', true).maybeSingle(),
    supabaseAdmin.from('wallets').select('balance').eq('user_id', userId).single(),
    supabaseAdmin.from('game_profit_settings').select('profit_margin, max_win_multiplier, small_win_pool_pct, medium_win_pool_pct, big_win_pool_pct, jackpot_pool_pct').eq('game_id', GAME_ID).single(),
    supabaseAdmin.from('profiles').select('forced_result').eq('user_id', userId).single(),
    supabaseAdmin.rpc('get_total_bets_and_wins'),
    supabaseAdmin.rpc('get_game_stats', { p_game_id: GAME_ID }),
    supabaseAdmin.from('game_sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ]);

  const activeSession = sessionRes.data;
  const wallet = walletRes.data;
  const walletErr = walletRes.error;

  if (walletErr || !wallet) return { error: 'Wallet not found' };

  const isFreeSpinMode = !!(activeSession && activeSession.spins_remaining > 0);
  const freeSpinMultiplier = isFreeSpinMode
    ? Math.min(1 + (activeSession.total_spins_awarded - activeSession.spins_remaining) * 0.5, 5)
    : 1;

  if (!isFreeSpinMode && wallet.balance < bet) return { error: 'Insufficient balance' };

  const rawMargin = profitSettingsRes.data ? Number(profitSettingsRes.data.profit_margin) : DEFAULT_PROFIT_MARGIN;
  const profitMargin = Math.max(5, Math.min(40, rawMargin));
  const maxWinMultiplier = profitSettingsRes.data ? Number(profitSettingsRes.data.max_win_multiplier) : 25;
  const profitMarginRatio = profitMargin / 100;
  const forcedResult = profileRes.data?.forced_result ?? null;

  let outcomeType = 'loss';
  let controlledWinCap = 0;

  // Single RNG for outcome distribution. RTP = totalWins/totalBets — monitor in admin. Race condition: consider transaction or per-user lock for concurrent spins.
  if (forcedResult === 'loss') outcomeType = 'loss';
  else if (forcedResult === 'big_win') outcomeType = 'big_win';
  else if (forcedResult === 'mega_win') outcomeType = 'mega_win';
  else if (forcedResult === 'small_win') outcomeType = 'small_win';
  else if (forcedResult === 'medium_win') outcomeType = 'medium_win';
  else if (forcedResult && ['one_big_win', 'one_mega_win', 'one_small_win', 'one_medium_win', 'one_loss'].includes(forcedResult)) {
    const map = { one_big_win: 'big_win', one_mega_win: 'mega_win', one_small_win: 'small_win', one_medium_win: 'medium_win', one_loss: 'loss' };
    outcomeType = map[forcedResult] || 'loss';
    await supabaseAdmin.from('profiles').update({ forced_result: null }).eq('user_id', userId);
  } else if (!isFreeSpinMode) {
    const globalStats = globalStatsRes.data;
    let globalTotalBets = 0,
      globalTotalWins = 0;
    if (globalStats && globalStats.length > 0) {
      globalTotalBets = Number(globalStats[0].total_bets) || 0;
      globalTotalWins = Number(globalStats[0].total_wins) || 0;
    }
    const globalAvailablePool = Math.max(0, globalTotalBets * (1 - profitMarginRatio) - globalTotalWins);
    const globalCurrentProfit = globalTotalBets - globalTotalWins;
    const globalMinimumProfit = globalTotalBets * profitMarginRatio;

    let gameTotalBets = 0,
      gameTotalWins = 0;
    if (!gameStatsRes.error && gameStatsRes.data) {
      const gameStats = gameStatsRes.data;
      const row = Array.isArray(gameStats) ? gameStats[0] : gameStats;
      if (row && (row.total_bets != null || row.total_wins != null)) {
        gameTotalBets = Number(row.total_bets) || 0;
        gameTotalWins = Number(row.total_wins) || 0;
      }
    } else {
      const { data: sessions } = await supabaseAdmin.from('game_sessions').select('bet_amount, win_amount').eq('game_id', GAME_ID);
      (sessions || []).forEach((s) => {
        gameTotalBets += Number(s.bet_amount) || 0;
        gameTotalWins += Number(s.win_amount) || 0;
      });
    }
    const gameAvailablePool = Math.max(0, gameTotalBets * (1 - profitMarginRatio) - gameTotalWins);
    const gameCurrentProfit = gameTotalBets - gameTotalWins;
    const gameMinimumProfit = gameTotalBets * profitMarginRatio;

    const availablePool = Math.min(
      globalAvailablePool > 0 ? globalAvailablePool : 0,
      gameAvailablePool > 0 ? gameAvailablePool : globalAvailablePool
    );

    if (
      availablePool <= 0 ||
      globalCurrentProfit <= globalMinimumProfit ||
      (gameTotalBets > 0 && gameCurrentProfit <= gameMinimumProfit)
    ) {
      outcomeType = 'loss';
    } else {
      const r = secureRandom();
      if (r < 0.0167) {
        outcomeType = 'mega_win';
        const megaMin = 20;
        const megaMax = Math.max(megaMin, maxWinMultiplier);
        controlledWinCap = Math.min(
          Math.round(bet * (megaMin + secureRandom() * (megaMax - megaMin))),
          availablePool
        );
      } else if (r < 0.0417) {
        outcomeType = 'big_win';
        controlledWinCap = Math.min(Math.round(bet * (5 + secureRandom() * 3)), availablePool);
      } else if (r < 0.0917) {
        outcomeType = 'medium_win';
        controlledWinCap = Math.min(Math.round(bet * (5 + secureRandom() * 5)), availablePool);
      } else if (r < 0.3817) {
        outcomeType = 'small_win';
        controlledWinCap = Math.min(Math.round(bet * (0.5 + secureRandom() * 1.0)), availablePool);
      } else {
        outcomeType = 'loss';
      }
    }
  }

  let initialGrid;
  if (outcomeType === 'loss' && !isFreeSpinMode) initialGrid = generateNoWinGrid();
  else if (outcomeType === 'mega_win') initialGrid = generateMegaWinGrid(isFreeSpinMode);
  else if (outcomeType === 'big_win') initialGrid = generateBigWinGrid(isFreeSpinMode);
  else if (outcomeType === 'medium_win') initialGrid = generateBigWinGrid(isFreeSpinMode);
  else if (outcomeType === 'small_win') initialGrid = generateSmallWinGrid(isFreeSpinMode);
  else initialGrid = generateGrid(isFreeSpinMode);

  const paylineWins = evaluatePaylineWins(initialGrid, betPerLine);
  const scatterResult = evaluateScatterWins(initialGrid, bet);
  const scatterPositions = scatterResult.positions.map(([r, c]) => `${r}-${c}`);

  let currentGrid = initialGrid;
  let totalWin = 0;
  let cascadeNum = 0;
  const cascadeSteps = [];
  const maxWin = bet * MAX_WIN_CAP;
  const cascadeMultipliers = isFreeSpinMode ? [1, 2, 3, 5, 8] : [1, 1.5, 2, 3, 5];
  let currentPaylineWins = paylineWins;
  let firstRound = true;

  while (true) {
    const wins = firstRound ? currentPaylineWins : evaluatePaylineWins(currentGrid, betPerLine);
    firstRound = false;
    if (wins.length === 0) break;

    const allWinPos = new Set();
    wins.forEach((w) => w.positions.forEach(([r, c]) => allWinPos.add(`${r}-${c}`)));

    const mult = cascadeMultipliers[Math.min(cascadeNum, cascadeMultipliers.length - 1)];
    const fsMult = isFreeSpinMode ? freeSpinMultiplier : 1;
    let basePay = wins.reduce((s, w) => s + w.payout, 0);
    let cascadePay = Math.round(basePay * mult * fsMult * 100) / 100;
    if (totalWin + cascadePay > maxWin) cascadePay = maxWin - totalWin;
    if (controlledWinCap > 0 && !isFreeSpinMode && totalWin + cascadePay > controlledWinCap) {
      cascadePay = Math.max(0, controlledWinCap - totalWin);
    }
    totalWin += cascadePay;

    cascadeSteps.push({
      grid: simplifyGrid(currentGrid),
      winPositions: Array.from(allWinPos),
      paylineWins: wins.map((w) => ({
        paylineIndex: w.paylineIndex,
        symbolId: w.symbolId,
        matchCount: w.matchCount,
        payout: w.payout,
      })),
      cascadePayout: cascadePay,
      multiplier: mult,
    });

    currentGrid = cascadeGrid(currentGrid, allWinPos, isFreeSpinMode);
    cascadeNum++;
    currentPaylineWins = evaluatePaylineWins(currentGrid, betPerLine);
    if (cascadeNum >= 20 || totalWin >= maxWin || currentPaylineWins.length === 0) break;
  }

  if (outcomeType === 'small_win' && !isFreeSpinMode) {
    const smallMin = Math.round(bet * 0.5);
    if (totalWin < smallMin) totalWin = Math.min(Math.max(smallMin, totalWin), controlledWinCap || Infinity);
  }

  if (scatterResult.payout > 0) totalWin += scatterResult.payout;

  let bonusFight = null;
  if (scatterResult.count >= 4) {
    bonusFight = resolveBonusFight();
    const fightBase = totalWin > 0 ? totalWin : bet;
    const fightWin = Math.round(fightBase * bonusFight.multiplier);
    totalWin += Math.min(fightWin, maxWin - totalWin);
  }

  let freeSpinTriggered = false;
  let freeSpinSessionId = activeSession?.id ?? null;
  let spinsRemaining = activeSession?.spins_remaining ?? 0;
  const sessionSpinDelta = isFreeSpinMode && activeSession ? 1 : 0;
  let sessionAward = 0;

  if (scatterResult.count >= FREE_SPIN_TRIGGER) {
    freeSpinTriggered = true;
    sessionAward = FREE_SPIN_AWARD;
  }

  const winTier = detectWinTier(totalWin, bet);

  const poolPct = profitSettingsRes.data || {};
  const smallPct = Number(poolPct.small_win_pool_pct) || 30;
  const mediumPct = Number(poolPct.medium_win_pool_pct) || 20;
  const bigPct = Number(poolPct.big_win_pool_pct) || 10;
  const jackpotPct = Number(poolPct.jackpot_pool_pct) || 5;
  const { data: settlementData, error: settlementError } = await supabaseAdmin.rpc('settle_slot_spin', {
    p_user_id: userId,
    p_game_id: GAME_ID,
    p_game_name: 'Boxing King',
    p_bet_amount: bet,
    p_total_win: totalWin,
    p_is_free_spin: isFreeSpinMode,
    p_session_spin_delta: sessionSpinDelta,
    p_session_award: sessionAward,
    p_log_cascades: cascadeNum,
    p_log_grid_result: simplifyGrid(initialGrid),
    p_result_multiplier: totalWin > 0 ? totalWin / bet : 0,
    p_win_tier: winTier,
    p_small_pct: smallPct,
    p_medium_pct: mediumPct,
    p_big_pct: bigPct,
    p_jackpot_pct: jackpotPct,
  });
  if (settlementError) {
    return { error: settlementError.message };
  }

  const newBalance = Number(settlementData?.newBalance ?? wallet.balance - (isFreeSpinMode ? 0 : bet) + totalWin);
  const settledFreeSpins = settlementData?.freeSpins || null;
  spinsRemaining = Number(settledFreeSpins?.remaining || 0);
  freeSpinSessionId = settledFreeSpins?.sessionId ?? null;

  if (forcedResult && forcedResult !== 'persistent_loss') {
    await supabaseAdmin
      .from('profiles')
      .update({ forced_result: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
  }

  return {
    initialGrid: simplifyGrid(initialGrid),
    scatterPositions,
    cascadeSteps,
    finalGrid: cascadeSteps.length > 0 ? simplifyGrid(currentGrid) : undefined,
    paylineWins: paylineWins.map((w) => ({
      paylineIndex: w.paylineIndex,
      symbolId: w.symbolId,
      matchCount: w.matchCount,
      payout: w.payout,
      positions: w.positions,
    })),
    scatterWin: scatterResult,
    bonusFight,
    totalWin,
    newBalance,
    winTier,
    freeSpins: {
      triggered: freeSpinTriggered,
      remaining: spinsRemaining,
      sessionId: freeSpinSessionId,
      multiplier: freeSpinMultiplier,
    },
  };
}

module.exports = { runBoxingKingSpin, VALID_BETS };
