/**
 * Super Ace slot — 4x5, 1024-ways, golden positions, cascade.
 * Profit-margin safe + RNG; ported from supabase/functions/super-ace-spin.
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');

const VALID_BETS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const GAME_ID = 'super-ace';
const DEFAULT_PROFIT_MARGIN = 25;
const ROWS = 4;
const COLS = 5;
const BASE_MULTIPLIERS = [1, 2, 3, 5];
const FREE_MULTIPLIERS = [2, 4, 6, 10];
const MAX_WIN_CAP = 10000;
const FREE_SPIN_TRIGGER = 3;
const FREE_SPIN_AWARD = 10;
const FREE_SPIN_RETRIGGER_AWARD = 5;

const NORMAL_SYMBOLS = [
  { id: 'spade', payout: { 3: 1, 4: 2, 5: 4 }, weight: 18, isWild: false, isScatter: false, isGolden: false },
  { id: 'heart', payout: { 3: 1, 4: 2, 5: 4 }, weight: 18, isWild: false, isScatter: false, isGolden: false },
  { id: 'club', payout: { 3: 1, 4: 2, 5: 4 }, weight: 18, isWild: false, isScatter: false, isGolden: false },
  { id: 'diamond', payout: { 3: 1.2, 4: 2.5, 5: 5 }, weight: 16, isWild: false, isScatter: false, isGolden: false },
  { id: 'jack', payout: { 3: 1.5, 4: 3, 5: 6 }, weight: 14, isWild: false, isScatter: false, isGolden: false },
  { id: 'queen', payout: { 3: 2, 4: 4, 5: 8 }, weight: 12, isWild: false, isScatter: false, isGolden: false },
  { id: 'king', payout: { 3: 2.5, 4: 5, 5: 10 }, weight: 10, isWild: false, isScatter: false, isGolden: false },
  { id: 'ace', payout: { 3: 4, 4: 8, 5: 20 }, weight: 8, isWild: false, isScatter: false, isGolden: false },
];
const JOKER_WILD = { id: 'joker', payout: { 3: 0, 4: 0, 5: 0 }, weight: 3, isWild: true, isScatter: false, isGolden: false };
const SCATTER = { id: 'scatter', payout: { 3: 5, 4: 20, 5: 100 }, weight: 1, isWild: false, isScatter: true, isGolden: false };

const ALL_SYMBOLS = [...NORMAL_SYMBOLS, JOKER_WILD, SCATTER];
let TOTAL_WEIGHT = ALL_SYMBOLS.reduce((s, sym) => s + sym.weight, 0);
const FREE_SPIN_WEIGHT_OVERRIDES = { scatter: 2, joker: 5 };

function secureRandom() {
  const arr = new Uint32Array(1);
  crypto.randomFillSync(arr);
  return arr[0] / (0xffffffff + 1);
}

function pickSymbol(freeSpinMode = false) {
  let symbols = ALL_SYMBOLS;
  let totalW = TOTAL_WEIGHT;
  if (freeSpinMode) {
    symbols = ALL_SYMBOLS.map((s) => {
      const ow = FREE_SPIN_WEIGHT_OVERRIDES[s.id];
      return ow !== undefined ? { ...s, weight: ow } : s;
    });
    totalW = symbols.reduce((a, s) => a + s.weight, 0);
  }
  let r = secureRandom() * totalW;
  for (const sym of symbols) {
    r -= sym.weight;
    if (r <= 0) return { ...sym };
  }
  return { ...symbols[symbols.length - 1] };
}

function generateGrid(freeSpinMode = false, goldenChance = 0.08) {
  const grid = [];
  for (let row = 0; row < ROWS; row++) {
    const rowArr = [];
    for (let col = 0; col < COLS; col++) {
      const sym = pickSymbol(freeSpinMode);
      if (!sym.isWild && !sym.isScatter && col >= 1 && col <= 3) {
        const gc = freeSpinMode ? goldenChance * 1.5 : goldenChance;
        if (secureRandom() < gc) sym.isGolden = true;
      }
      rowArr.push(sym);
    }
    grid.push(rowArr);
  }
  return grid;
}

function wouldCreateWin(grid, row, col, sym) {
  if (col < 2) return false;
  for (let c = 0; c < col; c++) {
    let hasMatch = false;
    for (let r = 0; r < ROWS; r++) {
      if (grid[r][c] && (grid[r][c].id === sym.id || grid[r][c].isWild)) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) return false;
  }
  return true;
}

function generateNoWinGrid(freeSpinMode = false) {
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
      } while (col >= 2 && wouldCreateWin(grid, row, col, sym) && attempts < 50);
      grid[row].push(sym);
    }
  }
  return grid;
}

function generateForcedWinGrid(freeSpinMode = false, isMega = false) {
  const grid = [];
  const highSymbols = isMega
    ? NORMAL_SYMBOLS.filter((s) => s.id === 'ace' || s.id === 'king')
    : NORMAL_SYMBOLS.filter((s) => s.id === 'queen' || s.id === 'king');
  const winSym = highSymbols[Math.floor(secureRandom() * highSymbols.length)];
  for (let row = 0; row < ROWS; row++) {
    const rowArr = [];
    for (let col = 0; col < COLS; col++) {
      if (row === 0) rowArr.push({ ...winSym });
      else if (isMega && row === 1) rowArr.push({ ...winSym });
      else rowArr.push(pickSymbol(freeSpinMode));
    }
    grid.push(rowArr);
  }
  return grid;
}

function generateSmallWinGrid(freeSpinMode = false) {
  const grid = [];
  const lowSymbols = NORMAL_SYMBOLS.filter((s) => ['spade', 'heart', 'club'].includes(s.id));
  const winSym = lowSymbols[Math.floor(secureRandom() * lowSymbols.length)];
  for (let row = 0; row < ROWS; row++) {
    const rowArr = [];
    for (let col = 0; col < COLS; col++) {
      if (row === 0 && col < 3) rowArr.push({ ...winSym });
      else {
        let sym;
        let attempts = 0;
        do {
          sym = pickSymbol(freeSpinMode);
          attempts++;
        } while (sym.id === winSym.id && col >= 3 && row === 0 && attempts < 20);
        rowArr.push(sym);
      }
    }
    grid.push(rowArr);
  }
  return grid;
}

// Medium win: ~5x–10x (queen/king 4-way)
function generateMediumWinGrid(freeSpinMode = false) {
  const grid = [];
  const medSymbols = NORMAL_SYMBOLS.filter((s) => ['queen', 'king'].includes(s.id));
  const winSym = medSymbols[Math.floor(secureRandom() * medSymbols.length)];
  for (let row = 0; row < ROWS; row++) {
    const rowArr = [];
    for (let col = 0; col < COLS; col++) {
      if (row === 0 && col < 4) rowArr.push({ ...winSym });
      else {
        let sym;
        let attempts = 0;
        do {
          sym = pickSymbol(freeSpinMode);
          attempts++;
        } while (sym.id === winSym.id && col < 4 && row === 0 && attempts < 20);
        rowArr.push(sym);
      }
    }
    grid.push(rowArr);
  }
  return grid;
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
  return grid.map((row) =>
    row.map((s) => ({
      id: s.id,
      isWild: s.isWild,
      isScatter: s.isScatter,
      isGolden: s.isGolden || false,
    }))
  );
}

function evaluateWins(grid, bet) {
  const wins = [];
  for (const sym of NORMAL_SYMBOLS) {
    const reelMatches = [];
    for (let col = 0; col < COLS; col++) {
      const colPositions = [];
      for (let row = 0; row < ROWS; row++) {
        const cell = grid[row][col];
        if (cell.id === sym.id || cell.isWild) colPositions.push([row, col]);
      }
      if (colPositions.length === 0) break;
      reelMatches.push(colPositions);
    }
    const matchCount = reelMatches.length;
    if (matchCount < 3) continue;
    const ways = reelMatches.reduce((acc, reel) => acc * reel.length, 1);
    const payKey = matchCount;
    const payPerWay = sym.payout[payKey] ?? sym.payout[5];
    // Payout = bet × multiplier × ways (no /10 — supports 0.5, 1, 2 bet)
    const rawPayout = bet * payPerWay * ways;
    const basePayout = Math.round(rawPayout * 100) / 100;
    if (basePayout > 0) {
      wins.push({
        symbolId: sym.id,
        matchCount,
        ways,
        positions: reelMatches.flat(),
        basePayout,
      });
    }
  }
  return wins;
}

function findScatters(grid) {
  const pos = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) if (grid[r][c].isScatter) pos.push([r, c]);
  return pos;
}

function getWinPosSet(wins) {
  const s = new Set();
  wins.forEach((w) => w.positions.forEach(([r, c]) => s.add(`${r}-${c}`)));
  return s;
}

function applyGoldenConversion(grid, winPositions, alreadyConverted) {
  const newGrid = grid.map((row) => row.map((s) => ({ ...s })));
  const newConversions = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const key = `${r}-${c}`;
      if (newGrid[r][c].isGolden && winPositions.has(key) && !alreadyConverted.has(key)) {
        newGrid[r][c] = { ...JOKER_WILD };
        newConversions.push(key);
      }
    }
  }
  let jokerType = 'none';
  if (newConversions.length > 0) jokerType = secureRandom() < 0.5 ? 'big' : 'little';
  if (jokerType === 'big') {
    const convertCount = 1 + Math.floor(secureRandom() * 4);
    const candidates = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 1; c < COLS; c++) {
        if (!newGrid[r][c].isWild && !newGrid[r][c].isScatter && !winPositions.has(`${r}-${c}`)) {
          candidates.push([r, c]);
        }
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(secureRandom() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const toConvert = candidates.slice(0, Math.min(convertCount, candidates.length));
    for (const [r, c] of toConvert) {
      newGrid[r][c] = { ...JOKER_WILD };
      newConversions.push(`${r}-${c}`);
    }
  }
  return { grid: newGrid, newConversions, jokerType };
}

function detectWinTier(totalWin, bet) {
  if (!bet || totalWin <= 0) return 'loss';
  const ratio = totalWin / bet;
  if (ratio >= 20) return 'mega_win';
  if (ratio >= 10) return 'big_win';
  if (ratio >= 5) return 'medium_win';
  if (ratio > 0) return 'small_win';
  return 'loss';
}

function cascadeGrid(grid, winPositions, freeSpinMode = false) {
  const newGrid = grid.map((row) => row.map((s) => ({ ...s })));
  for (let col = 0; col < COLS; col++) {
    const remaining = [];
    for (let row = 0; row < ROWS; row++) {
      if (!winPositions.has(`${row}-${col}`)) remaining.push(newGrid[row][col]);
    }
    const removed = ROWS - remaining.length;
    const newSyms = Array.from({ length: removed }, () => pickSymbol(freeSpinMode));
    const fullCol = [...newSyms, ...remaining];
    for (let row = 0; row < ROWS; row++) newGrid[row][col] = fullCol[row];
  }
  return newGrid;
}

async function runSuperAceSpin(userId, bet) {
  if (!VALID_BETS.includes(bet)) return { error: 'Invalid bet amount' };

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
  if (!isFreeSpinMode && wallet.balance < bet) return { error: 'Insufficient balance' };

  const rawMargin = profitSettingsRes.data ? Number(profitSettingsRes.data.profit_margin) : DEFAULT_PROFIT_MARGIN;
  const profitMargin = Math.max(5, Math.min(40, rawMargin));
  const maxWinMultiplier = profitSettingsRes.data ? Number(profitSettingsRes.data.max_win_multiplier) : 25;
  const profitMarginRatio = profitMargin / 100;
  const forcedResult = profileRes.data?.forced_result ?? null;

  let outcomeType = 'loss';
  let controlledWinCap = 0;

  // Win distribution: single RNG for accurate probabilities (when pool allows). RTP = totalWins/totalBets — monitor in admin.
  // Probabilities: mega ~1.67%, big ~2.5%, medium ~5%, small ~29%, loss ~62%. Race condition: consider transaction or per-user lock for concurrent spins.
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
      globalAvailablePool > 0 ? globalAvailablePool : Infinity,
      gameAvailablePool > 0 ? gameAvailablePool : Infinity
    );
    const isBootstrap = availablePool <= 0 || (globalTotalBets < 100 && gameTotalBets < 50);
    const poolCapped = !isBootstrap && (
      globalCurrentProfit <= globalMinimumProfit ||
      (gameTotalBets > 0 && gameCurrentProfit <= gameMinimumProfit)
    );

    if (poolCapped) {
      outcomeType = 'loss';
    } else {
      const r = secureRandom();
      // Bootstrap: cap wins to pool share (distribute adds 30/20/10/5% of bet to pools before deduct)
      const bootstrapCaps = { small_win: bet * 0.28, medium_win: bet * 0.19, big_win: bet * 0.09, mega_win: bet * 0.09 };
      if (r < 0.0167) {
        outcomeType = 'mega_win';
        const megaMin = 20;
        const megaMax = Math.max(megaMin, maxWinMultiplier);
        controlledWinCap = Math.min(
          Math.round(bet * (megaMin + secureRandom() * (megaMax - megaMin))),
          isBootstrap ? bootstrapCaps.mega_win : availablePool
        );
      } else if (r < 0.0417) {
        outcomeType = 'big_win';
        controlledWinCap = Math.min(Math.round(bet * (5 + secureRandom() * 3)), isBootstrap ? bootstrapCaps.big_win : availablePool);
      } else if (r < 0.0917) {
        outcomeType = 'medium_win';
        controlledWinCap = Math.min(Math.round(bet * (5 + secureRandom() * 5)), isBootstrap ? bootstrapCaps.medium_win : availablePool);
      } else if (r < 0.3817) {
        outcomeType = 'small_win';
        controlledWinCap = Math.min(Math.round(bet * (0.5 + secureRandom() * 1.0)), isBootstrap ? bootstrapCaps.small_win : availablePool);
      } else {
        outcomeType = 'loss';
      }
    }
  }

  let initialGrid;
  if (outcomeType === 'loss' && !isFreeSpinMode) initialGrid = generateNoWinGrid(isFreeSpinMode);
  else if (outcomeType === 'mega_win') initialGrid = generateForcedWinGrid(isFreeSpinMode, true);
  else if (outcomeType === 'big_win') initialGrid = generateForcedWinGrid(isFreeSpinMode, false);
  else if (outcomeType === 'medium_win') initialGrid = generateMediumWinGrid(isFreeSpinMode);
  else if (outcomeType === 'small_win') {
    initialGrid = generateGrid(isFreeSpinMode);
    const testWins = evaluateWins(initialGrid, bet);
    if (testWins.length === 0) initialGrid = generateSmallWinGrid(isFreeSpinMode);
  } else initialGrid = generateGrid(isFreeSpinMode);

  const goldenPositions = [];
  const scatterPositions = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (initialGrid[r][c].isGolden) goldenPositions.push(`${r}-${c}`);
      if (initialGrid[r][c].isScatter) scatterPositions.push(`${r}-${c}`);
    }
  }

  let currentGrid = initialGrid;
  let totalWin = 0;
  let cascadeNum = 0;
  const cascadeSteps = [];
  const goldenConverted = new Set();
  const multipliers = isFreeSpinMode ? FREE_MULTIPLIERS : BASE_MULTIPLIERS;
  const maxWin = bet * MAX_WIN_CAP;

  while (true) {
    const wins = evaluateWins(currentGrid, bet);
    if (wins.length === 0) break;

    const allWinPos = getWinPosSet(wins);
    const mult = multipliers[Math.min(cascadeNum, multipliers.length - 1)];
    const basePay = wins.reduce((s, w) => s + w.basePayout, 0);
    let cascadePay = Math.round(basePay * mult);
    if (totalWin + cascadePay > maxWin) cascadePay = maxWin - totalWin;
    if (controlledWinCap > 0 && !isFreeSpinMode && totalWin + cascadePay > controlledWinCap) {
      cascadePay = Math.max(0, controlledWinCap - totalWin);
    }
    totalWin += cascadePay;

    const { grid: convertedGrid, newConversions } = applyGoldenConversion(currentGrid, allWinPos, goldenConverted);
    newConversions.forEach((k) => goldenConverted.add(k));

    cascadeSteps.push({
      grid: simplifyGrid(currentGrid),
      winPositions: Array.from(allWinPos),
      cascadePayout: cascadePay,
      multiplier: mult,
      goldenConversions: newConversions,
    });

    currentGrid = cascadeGrid(convertedGrid, allWinPos, isFreeSpinMode);
    cascadeNum++;
    if (cascadeNum >= 20 || totalWin >= maxWin) break;
  }

  // Small win tier = 0.5x–1.5x: enforce minimum so 10 bet never pays 1 or 3 as "small_win"
  if (outcomeType === 'small_win' && !isFreeSpinMode) {
    const smallMin = Math.round(bet * 0.5);
    if (totalWin < smallMin) totalWin = Math.min(Math.max(smallMin, totalWin), controlledWinCap || Infinity);
  }

  let freeSpinTriggered = false;
  let freeSpinSessionId = activeSession?.id ?? null;
  let spinsRemaining = activeSession?.spins_remaining ?? 0;
  const scatters = findScatters(initialGrid);
  const sessionSpinDelta = isFreeSpinMode && activeSession ? 1 : 0;
  let sessionAward = 0;

  if (scatters.length >= FREE_SPIN_TRIGGER) {
    freeSpinTriggered = true;
    sessionAward = activeSession ? FREE_SPIN_RETRIGGER_AWARD : FREE_SPIN_AWARD;
  }

  const winTier = detectWinTier(totalWin, bet);

  // Update reward_pools so admin Reward Pool Balances stays in sync (real-time)
  const poolPct = profitSettingsRes.data || {};
  const smallPct = Number(poolPct.small_win_pool_pct) || 30;
  const mediumPct = Number(poolPct.medium_win_pool_pct) || 20;
  const bigPct = Number(poolPct.big_win_pool_pct) || 10;
  const jackpotPct = Number(poolPct.jackpot_pool_pct) || 5;
  const { data: settlementData, error: settlementError } = await supabaseAdmin.rpc('settle_slot_spin', {
    p_user_id: userId,
    p_game_id: GAME_ID,
    p_game_name: 'Super Ace',
    p_bet_amount: bet,
    p_total_win: totalWin,
    p_is_free_spin: isFreeSpinMode,
    p_session_spin_delta: sessionSpinDelta,
    p_session_award: sessionAward,
    p_log_cascades: cascadeNum,
    p_log_grid_result: simplifyGrid(initialGrid),
    p_result_multiplier: totalWin > 0 ? (cascadeSteps.length > 0 ? cascadeSteps[cascadeSteps.length - 1].multiplier : 1) : 1,
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

  return {
    initialGrid: simplifyGrid(initialGrid),
    goldenPositions,
    scatterPositions,
    cascadeSteps,
    finalGrid: cascadeSteps.length > 0 ? simplifyGrid(currentGrid) : undefined,
    totalWin,
    newBalance,
    winTier,
    freeSpins: {
      triggered: freeSpinTriggered,
      remaining: spinsRemaining,
      sessionId: freeSpinSessionId,
    },
  };
}

module.exports = { runSuperAceSpin, VALID_BETS };
