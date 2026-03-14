const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const ALLOWED_RPCS = new Set([
  'admin_final_approve_deposit',
  'adjust_wallet_balance',
  'add_vip_points',
  'claim_cashback',
  'get_withdrawable_balance',
  'get_user_bonus_turnover',
  'try_daily_spin',
  'get_daily_spin_status',
  'get_or_create_crash_round',
  'load_agent_balance',
  'pay_agent_commission',
  'process_agent_assigned_deposit_approval',
  'process_agent_deposit',
  'process_agent_withdrawal_approval',
  'record_agent_commission',
  'get_profit_chart_data',
  'get_approved_withdrawal_total',
  'get_total_bets_and_wins',
  'get_approved_deposit_total',
  'get_session_stats_by_range',
  'get_per_game_stats_by_range',
  'has_role',
]);

const ADMIN_ONLY_RPCS = new Set([
  'admin_final_approve_deposit',
  'load_agent_balance',
  'pay_agent_commission',
  'get_profit_chart_data',
  'get_approved_withdrawal_total',
  'get_total_bets_and_wins',
  'get_approved_deposit_total',
  'get_session_stats_by_range',
  'get_per_game_stats_by_range',
]);

const AGENT_OR_ADMIN_RPCS = new Set([
  'process_agent_assigned_deposit_approval',
  'process_agent_deposit',
  'process_agent_withdrawal_approval',
  'record_agent_commission',
]);

const USER_SCOPED_RPC_PARAMS = {
  adjust_wallet_balance: 'p_user_id',
  add_vip_points: 'p_user_id',
  get_withdrawable_balance: 'p_user_id',
  get_user_bonus_turnover: 'p_user_id',
  try_daily_spin: 'p_user_id',
  get_daily_spin_status: 'p_user_id',
  claim_cashback: 'p_user_id',
  has_role: '_user_id',
  pay_agent_commission: 'p_admin_id',
  admin_final_approve_deposit: 'p_admin_id',
  process_agent_assigned_deposit_approval: 'p_agent_id',
  process_agent_deposit: 'p_agent_id',
  process_agent_withdrawal_approval: 'p_agent_id',
  record_agent_commission: 'p_agent_id',
};

/**
 * POST /api/rpc/:name
 * Body: { ...params } (e.g. { p_user_id: "...", p_amount: 100 })
 * Frontend যে সব supabase.rpc() call করে সেগুলো এখান দিয়ে করবে।
 * Auth: Bearer token required (user id from JWT used where needed by RPC).
 */
router.post('/:name', requireAuth, async (req, res) => {
  const name = req.params.name;
  const params = { ...(req.body || {}) };
  if (!ALLOWED_RPCS.has(name)) {
    return res.status(403).json({ error: 'RPC not allowed through this route' });
  }

  if (ADMIN_ONLY_RPCS.has(name)) {
    try {
      const [{ data: isAdmin, error: adminError }, { data: isModerator, error: moderatorError }] = await Promise.all([
        supabaseAdmin.rpc('has_role', { _user_id: req.user.id, _role: 'admin' }),
        supabaseAdmin.rpc('has_role', { _user_id: req.user.id, _role: 'moderator' }),
      ]);
      if (adminError || moderatorError) {
        throw adminError || moderatorError;
      }
      if (!isAdmin && !isModerator) {
        return res.status(403).json({ error: 'Admin access required' });
      }
    } catch (err) {
      console.error('RPC admin guard error:', name, err);
      return res.status(500).json({ error: 'RPC permission check failed' });
    }
  }

  if (AGENT_OR_ADMIN_RPCS.has(name)) {
    try {
      const [{ data: isAdmin, error: adminError }, { data: isAgent, error: agentError }] = await Promise.all([
        supabaseAdmin.rpc('has_role', { _user_id: req.user.id, _role: 'admin' }),
        supabaseAdmin.rpc('has_role', { _user_id: req.user.id, _role: 'payment_agent' }),
      ]);
      if (adminError || agentError) {
        throw adminError || agentError;
      }
      if (!isAdmin && !isAgent) {
        return res.status(403).json({ error: 'Agent or admin access required' });
      }
    } catch (err) {
      console.error('RPC agent/admin guard error:', name, err);
      return res.status(500).json({ error: 'RPC permission check failed' });
    }
  }

  const userParam = USER_SCOPED_RPC_PARAMS[name];
  if (userParam) {
    params[userParam] = req.user.id;
  }
  try {
    const { data, error } = await supabaseAdmin.rpc(name, params);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (err) {
    console.error('RPC error:', name, err);
    return res.status(500).json({ error: 'RPC failed' });
  }
});

module.exports = router;
