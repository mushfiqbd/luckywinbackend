const { randomUUID } = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { calculateOutcome, secureRandom } = require('./gameOutcome');

const LEVELS = [
  { level: 1, bet: 10 }, { level: 2, bet: 20 }, { level: 3, bet: 50 },
  { level: 4, bet: 100 }, { level: 5, bet: 200 }, { level: 6, bet: 300 },
  { level: 7, bet: 500 }, { level: 8, bet: 700 }, { level: 9, bet: 900 },
  { level: 10, bet: 1000 },
];

const WIN_MULTI = 1.8;

const MAX_PATH_POS = 51; // 0-51 = 52 main path cells
const HOME_START = 52;   // first colored home cell
const HOME_END = 56;     // last colored home cell
const FINAL_HOME = 57;   // center

const SAFE_ABS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Entry to home path happens from the square just before each player's start
// blue start abs = 39 -> entry abs = 38
// green start abs = 13 -> entry abs = 12
const HOME_ENTRY_ABS = {
  blue: 38,
  green: 12,
};

const FAKE_NAMES = [
  'Rahat_99', 'ShakilPro', 'Tanvir★', 'MdArif_21', 'Nahid77',
  'JoyBD', 'Sakib_King', 'RakibStar', 'Fahim123', 'HridoyGamer',
  'Mithun_Pro', 'KamalX', 'Sumon88', 'NasirPlay', 'Robin_BD',
  'AshiqGamer', 'Tushar★★', 'MasudPro', 'Riyad55', 'ShohelKing',
  'Imran_44', 'FarhanBD', 'Arif_Pro', 'TonmoyX', 'Rasel99',
  'SajibStar', 'Mamun12', 'RifatPro', 'Jewel★', 'AbdulGamer',
  'Niloy_King', 'ShafiqBD', 'Polash66', 'MarufPlay', 'Akash_Pro',
];

const FAKE_AVATARS = [
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Felix',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Aneka',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Jasper',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Nolan',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Garfield',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Destiny',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Leo',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Salem',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Rascal',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Tiger',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Milo',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Bandit',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Oscar',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Buddy',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Rocky',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Shadow',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Max',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Duke',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Bear',
  'https://api.dicebear.com/9.x/adventurer/svg?seed=Zeus',
];

function randomInt(max) {
  return Math.floor(secureRandom() * max);
}

function getRandomOpponent() {
  return {
    id: randomUUID(),
    name: FAKE_NAMES[randomInt(FAKE_NAMES.length)],
    avatar: FAKE_AVATARS[randomInt(FAKE_AVATARS.length)],
    level: randomInt(50) + 1,
    wins: randomInt(200) + 10,
  };
}

function toAbs(rel, player) {
  return (rel + (player === 'blue' ? 39 : 13)) % 52;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function getHomeEntryAbs(player) {
  return HOME_ENTRY_ABS[player];
}

function mapRelativeTarget(startPos, diceVal, player) {
  const target = startPos + diceVal;
  const entryAbs = getHomeEntryAbs(player);

  // already in home lane
  if (startPos >= HOME_START) {
    return target <= FINAL_HOME ? target : null;
  }

  // still on main path
  const startAbs = toAbs(startPos, player);
  let currentAbs = startAbs;
  let crossedEntry = false;
  let stepsIntoHome = 0;

  for (let step = 1; step <= diceVal; step += 1) {
    currentAbs = (currentAbs + 1) % 52;

    if (!crossedEntry) {
      if (currentAbs === entryAbs) {
        crossedEntry = true;
      }
      continue;
    }

    stepsIntoHome += 1;
  }

  if (!crossedEntry) {
    return target <= MAX_PATH_POS ? target : null;
  }

  const newPos = HOME_START + stepsIntoHome - 1;
  return newPos <= FINAL_HOME ? newPos : null;
}

function getMovableTokens(state, player, diceVal) {
  const tokens = player === 'blue' ? state.blue : state.green;
  const opponent = player === 'blue' ? state.green : state.blue;
  const movable = [];

  const hasOppBlock = (absSquare) => {
    const opp = player === 'blue' ? 'green' : 'blue';
    const count = opponent.filter(
      (pos) => pos >= 0 && pos <= MAX_PATH_POS && toAbs(pos, opp) === absSquare
    ).length;
    return count >= 2;
  };

  tokens.forEach((pos, idx) => {
    if (pos === FINAL_HOME) return;

    if (pos === -1) {
      if (diceVal === 6) {
        const entryAbs = toAbs(0, player);
        if (!hasOppBlock(entryAbs)) movable.push(idx);
      }
      return;
    }

    const mappedTarget = mapRelativeTarget(pos, diceVal, player);
    if (mappedTarget === null) return;

    // block check only on main path steps before home entry
    if (pos <= MAX_PATH_POS) {
      let blocked = false;
      let currentAbs = toAbs(pos, player);
      const entryAbs = getHomeEntryAbs(player);

      for (let step = 1; step <= diceVal; step += 1) {
        currentAbs = (currentAbs + 1) % 52;

        if (hasOppBlock(currentAbs)) {
          blocked = true;
          break;
        }

        if (currentAbs === entryAbs) {
          break;
        }
      }

      if (blocked) return;
    }

    movable.push(idx);
  });

  return movable;
}

function applyMove(state, player, tokenIdx, diceVal) {
  const next = cloneState(state);
  const myTokens = player === 'blue' ? [...next.blue] : [...next.green];
  const oppTokens = player === 'blue' ? [...next.green] : [...next.blue];

  const startPos = myTokens[tokenIdx];

  if (startPos === -1) {
    if (diceVal !== 6) {
      return next;
    }
    myTokens[tokenIdx] = 0;
  } else {
    const mappedTarget = mapRelativeTarget(startPos, diceVal, player);
    if (mappedTarget === null) {
      return next;
    }
    myTokens[tokenIdx] = mappedTarget;
  }

  const movedPos = myTokens[tokenIdx];
  let captured = false;
  let extraTurn = false;

  if (movedPos >= 0 && movedPos <= MAX_PATH_POS) {
    const absP = toAbs(movedPos, player);

    if (!SAFE_ABS.has(absP)) {
      const oppPlayer = player === 'blue' ? 'green' : 'blue';

      const oppIndicesOnSquare = oppTokens
        .map((op, oi) =>
          op >= 0 && op <= MAX_PATH_POS && toAbs(op, oppPlayer) === absP ? oi : -1
        )
        .filter((oi) => oi !== -1);

      if (oppIndicesOnSquare.length === 1) {
        oppTokens[oppIndicesOnSquare[0]] = -1;
        captured = true;
        extraTurn = true;
      }
    }
  }

  if (movedPos === FINAL_HOME) {
    extraTurn = true;
  }

  if (diceVal === 6 && !captured) {
    extraTurn = true;
  }

  if (player === 'blue') {
    next.blue = myTokens;
    next.green = oppTokens;
  } else {
    next.green = myTokens;
    next.blue = oppTokens;
  }

  next.movable = [];
  next.rolled = false;
  next.lastAction = {
    player,
    tokenIdx,
    diceVal,
    captured,
    reachedHome: movedPos === FINAL_HOME,
  };

  if (myTokens.every((token) => token === FINAL_HOME)) {
    next.winner = player;
    next.phase = 'result';
    return next;
  }

  if (!extraTurn) {
    next.turn = player === 'blue' ? 'green' : 'blue';
    next.consecutiveSixes[player] = 0;
  } else {
    next.turn = player;
  }

  return next;
}

function getBiasedDice(targetOutcome, player) {
  const normal = () => randomInt(6) + 1;

  if (targetOutcome === 'natural') return normal();

  if (targetOutcome === 'force_win') {
    if (player === 'blue') {
      const r = secureRandom();
      if (r < 0.35) return 6;
      if (r < 0.55) return 5;
      if (r < 0.7) return 4;
      return normal();
    }
    const r = secureRandom();
    if (r < 0.35) return randomInt(3) + 1;
    return normal();
  }

  if (player === 'green') {
    const r = secureRandom();
    if (r < 0.35) return 6;
    if (r < 0.55) return 5;
    if (r < 0.7) return 4;
    return normal();
  }

  const r = secureRandom();
  if (r < 0.35) return randomInt(3) + 1;
  return normal();
}

function chooseAiMove(state, movable) {
  const playerTokens = state.blue;
  let best = movable[0];
  let bestScore = -Infinity;

  movable.forEach((i) => {
    const pos = state.green[i];
    let score = 0;

    if (pos === -1) {
      score = 15;
    } else {
      const np = mapRelativeTarget(pos, state.dice, 'green');

      if (np === FINAL_HOME) {
        score = 200;
      } else if (np >= HOME_START) {
        score = 80 + (np - HOME_START) * 10;
      } else {
        const absN = toAbs(np, 'green');

        const canCapture =
          !SAFE_ABS.has(absN) &&
          playerTokens.some((rp) => rp >= 0 && rp <= MAX_PATH_POS && toAbs(rp, 'blue') === absN);

        if (canCapture) score += 150;
        if (SAFE_ABS.has(absN)) score += 20;

        let dangerLevel = 0;
        playerTokens.forEach((rp) => {
          if (rp < 0 || rp > MAX_PATH_POS) return;
          for (let d = 1; d <= 6; d += 1) {
            const pred = mapRelativeTarget(rp, d, 'blue');
            if (pred !== null && pred <= MAX_PATH_POS && pred >= 0 && toAbs(pred, 'blue') === absN && !SAFE_ABS.has(absN)) {
              dangerLevel += (7 - d) * 3;
            }
          }
        });

        score -= dangerLevel;
        score += Math.max(0, 30 - pos);

        const sameSquare = state.green.filter((bp, bi) => bi !== i && bp === np).length;
        if (sameSquare > 0) score -= 10;

        playerTokens.forEach((rp) => {
          if (rp < 0 || rp > MAX_PATH_POS) return;
          const absR = toAbs(rp, 'blue');
          const dist = Math.abs(absN - absR);
          if (dist <= 6 && dist > 0) score += (7 - dist) * 5;
        });
      }
    }

    score += secureRandom() * 8 - 4;

    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });

  return best;
}

function processAiTurns(state, targetOutcome) {
  let next = cloneState(state);
  next.aiTurns = [];

  while (next.turn === 'green' && !next.winner) {
    const val = getBiasedDice(targetOutcome, 'green');
    next.dice = val;

    if (val === 6) {
      next.consecutiveSixes.green += 1;
      if (next.consecutiveSixes.green >= 3) {
        next.aiTurns.push({ dice: val, tokenIdx: null, skipped: true, reason: 'triple_six' });
        next.consecutiveSixes.green = 0;
        next.turn = 'blue';
        break;
      }
    } else {
      next.consecutiveSixes.green = 0;
    }

    const movable = getMovableTokens(next, 'green', val);

    if (movable.length === 0) {
      next.aiTurns.push({ dice: val, tokenIdx: null, skipped: true, reason: 'no_moves' });
      next.turn = 'blue';
      next.rolled = false;
      next.movable = [];
      break;
    }

    const best = chooseAiMove(next, movable);
    next.aiTurns.push({ dice: val, tokenIdx: best, skipped: false });
    next = applyMove(next, 'green', best, val);
  }

  return next;
}

async function settleMatch(row, winner) {
  const betAmount = Number(row.bet_amount);
  const winAmount = winner === 'blue' ? Math.round(betAmount * WIN_MULTI) : 0;

  if (winner === 'blue') {
    await supabaseAdmin.rpc('adjust_wallet_balance', {
      p_user_id: row.user_id,
      p_amount: winAmount,
    });
  }

  await supabaseAdmin.from('game_sessions').insert({
    user_id: row.user_id,
    game_type: 'ludo',
    game_name: 'Ludo King',
    game_id: 'ludo-king',
    bet_amount: betAmount,
    win_amount: winAmount,
    result: winner === 'blue' ? 'win' : 'loss',
    multiplier: winner === 'blue' ? WIN_MULTI : null,
  });

  const updatedState = {
    ...row.board_state,
    winner,
    phase: 'result',
    settled: true,
    winAmount,
  };

  const { data, error } = await supabaseAdmin
    .from('ludo_ai_matches')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      board_state: updatedState,
    })
    .eq('id', row.id)
    .eq('user_id', row.user_id)
    .select('*')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

function serializeMatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    gameId: row.game_id,
    levelIdx: row.level_idx,
    betAmount: Number(row.bet_amount),
    targetOutcome: row.target_outcome,
    opponent: row.opponent_profile,
    state: row.board_state,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

async function getActiveMatch(userId) {
  const { data, error } = await supabaseAdmin
    .from('ludo_ai_matches')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return data;
}

async function startLudoMatch(userId, levelIdx) {
  const level = LEVELS[levelIdx];
  if (!level) {
    throw new Error('Invalid level');
  }

  const existing = await getActiveMatch(userId);
  if (existing) {
    return serializeMatch(existing);
  }

  const { data: wallet, error: walletError } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', userId)
    .single();

  if (walletError) throw new Error(walletError.message);
  if (!wallet || Number(wallet.balance) < level.bet) {
    throw new Error('Insufficient balance');
  }

  await supabaseAdmin.rpc('adjust_wallet_balance', {
    p_user_id: userId,
    p_amount: -level.bet,
  });

  await supabaseAdmin.rpc('add_vip_points', {
    p_user_id: userId,
    p_points: Math.floor(level.bet / 100),
    p_bet_amount: level.bet,
  });

  const outcome = await calculateOutcome(userId, level.bet, 'ludo', 'ludo-king');

  const targetOutcome = outcome.outcome === 'loss'
    ? 'force_loss'
    : outcome.outcome === 'small_win' || outcome.outcome === 'medium_win' || outcome.outcome === 'big_win' || outcome.outcome === 'mega_win'
      ? 'force_win'
      : 'natural';

  const boardState = {
    blue: [-1, -1, -1, -1],
    green: [-1, -1, -1, -1],
    turn: 'blue',
    dice: 1,
    rolled: false,
    movable: [],
    winner: null,
    phase: 'playing',
    consecutiveSixes: { blue: 0, green: 0 },
    aiTurns: [],
    lastUserRoll: null,
    lastAction: null,
    settled: false,
    winAmount: 0,
  };

  const { data, error } = await supabaseAdmin
    .from('ludo_ai_matches')
    .insert({
      user_id: userId,
      game_id: 'ludo-king',
      level_idx: levelIdx,
      bet_amount: level.bet,
      target_outcome: targetOutcome,
      target_max_win: Number(outcome.maxWinAmount || 0),
      opponent_profile: getRandomOpponent(),
      board_state: boardState,
    })
    .select('*')
    .single();

  if (error) throw new Error(error.message);
  return serializeMatch(data);
}

async function requireMatch(userId, matchId) {
  const { data, error } = await supabaseAdmin
    .from('ludo_ai_matches')
    .select('*')
    .eq('id', matchId)
    .eq('user_id', userId)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  if (!data || data.status !== 'active') {
    throw new Error('Active match not found');
  }

  return data;
}

async function saveMatch(row, nextState) {
  const { data, error } = await supabaseAdmin
    .from('ludo_ai_matches')
    .update({
      board_state: nextState,
    })
    .eq('id', row.id)
    .eq('user_id', row.user_id)
    .select('*')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function getLudoMatchState(userId, matchId) {
  if (!matchId) {
    const active = await getActiveMatch(userId);
    return serializeMatch(active);
  }

  const row = await requireMatch(userId, matchId);
  return serializeMatch(row);
}

async function rollLudoDice(userId, matchId) {
  const row = await requireMatch(userId, matchId);
  let state = cloneState(row.board_state);

  if (state.winner || state.turn !== 'blue' || state.rolled) {
    throw new Error('Cannot roll dice right now');
  }

  const val = getBiasedDice(row.target_outcome, 'blue');
  state.dice = val;
  state.aiTurns = [];
  state.lastUserRoll = {
    player: 'blue',
    diceVal: val,
    hadMove: false,
  };

  if (val === 6) {
    state.consecutiveSixes.blue += 1;
    if (state.consecutiveSixes.blue >= 3) {
      state.consecutiveSixes.blue = 0;
      state.rolled = false;
      state.movable = [];
      state.turn = 'green';
      state = processAiTurns(state, row.target_outcome);

      const saved = await saveMatch(row, state);
      if (state.winner) {
        return serializeMatch(await settleMatch(saved, state.winner));
      }
      return serializeMatch(saved);
    }
  } else {
    state.consecutiveSixes.blue = 0;
  }

  const movable = getMovableTokens(state, 'blue', val);

  if (movable.length === 0) {
    state.rolled = false;
    state.movable = [];
    state.turn = 'green';
    state = processAiTurns(state, row.target_outcome);
  } else {
    state.rolled = true;
    state.movable = movable;
    state.lastUserRoll.hadMove = true;
  }

  const saved = await saveMatch(row, state);
  if (state.winner) {
    return serializeMatch(await settleMatch(saved, state.winner));
  }
  return serializeMatch(saved);
}

async function moveLudoToken(userId, matchId, tokenIdx) {
  const row = await requireMatch(userId, matchId);
  let state = cloneState(row.board_state);

  if (state.turn !== 'blue' || !state.rolled || !Array.isArray(state.movable) || !state.movable.includes(tokenIdx)) {
    throw new Error('Invalid move');
  }

  state = applyMove(state, 'blue', tokenIdx, state.dice);

  if (!state.winner && state.turn === 'green') {
    state = processAiTurns(state, row.target_outcome);
  }

  const saved = await saveMatch(row, state);
  if (state.winner) {
    return serializeMatch(await settleMatch(saved, state.winner));
  }
  return serializeMatch(saved);
}

async function passLudoTurn(userId, matchId) {
  const row = await requireMatch(userId, matchId);
  let state = cloneState(row.board_state);

  if (state.turn !== 'blue' || state.winner) {
    throw new Error('Cannot pass turn right now');
  }

  state.movable = [];
  state.rolled = false;
  state.turn = 'green';
  state.aiTurns = [];
  state = processAiTurns(state, row.target_outcome);

  const saved = await saveMatch(row, state);
  if (state.winner) {
    return serializeMatch(await settleMatch(saved, state.winner));
  }
  return serializeMatch(saved);
}

async function abandonLudoMatch(userId, matchId) {
  const row = await requireMatch(userId, matchId);

  const { data, error } = await supabaseAdmin
    .from('ludo_ai_matches')
    .update({
      status: 'abandoned',
      completed_at: new Date().toISOString(),
      board_state: {
        ...row.board_state,
        winner: 'green',
        phase: 'result',
        settled: true,
        winAmount: 0,
      },
    })
    .eq('id', row.id)
    .eq('user_id', row.user_id)
    .select('*')
    .single();

  if (error) throw new Error(error.message);

  await supabaseAdmin.from('game_sessions').insert({
    user_id: userId,
    game_type: 'ludo',
    game_name: 'Ludo King',
    game_id: 'ludo-king',
    bet_amount: Number(row.bet_amount),
    win_amount: 0,
    result: 'loss',
  });

  return serializeMatch(data);
}

module.exports = {
  LEVELS,
  WIN_MULTI,
  startLudoMatch,
  getLudoMatchState,
  rollLudoDice,
  moveLudoToken,
  passLudoTurn,
  abandonLudoMatch,
};
