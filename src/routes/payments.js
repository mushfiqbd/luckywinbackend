const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');

async function userHasRole(userId, role) {
  const { data } = await supabaseAdmin.rpc('has_role', { _user_id: userId, _role: role });
  return !!data;
}

/**
 * GET /api/payments/deposit-form-data
 * Returns data for E-wallet deposit form: payment_methods, transaction_types, payment_method_numbers, agent_payment_numbers.
 * Auth optional – form data is public so users can see payment options before logging in.
 */
router.get('/deposit-form-data', optionalAuth, async (req, res) => {
  try {
    const [methodsRes, typesRes, numbersRes, agentNumsRes] = await Promise.all([
      supabaseAdmin.from('payment_methods').select('*').eq('is_active', true).order('sort_order'),
      supabaseAdmin.from('transaction_types').select('*').eq('is_active', true).order('sort_order'),
      supabaseAdmin.from('payment_method_numbers').select('*'),
      supabaseAdmin
        .from('agent_payment_numbers')
        .select('id, agent_id, payment_method, number, rotation_hours, sort_order, is_active, created_at')
        .eq('is_active', true),
    ]);
    return res.json({
      paymentMethods: methodsRes.data || [],
      transactionTypes: typesRes.data || [],
      paymentMethodNumbers: numbersRes.data || [],
      agentPaymentNumbers: agentNumsRes.data || [],
    });
  } catch (err) {
    console.error('deposit-form-data error:', err);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
});

/**
 * GET /api/payments/withdraw-form-data
 * Returns data for E-wallet withdraw form: payment_methods, agent_payment_numbers.
 * Auth optional – form data is public so users can see payment options before logging in.
 */
router.get('/withdraw-form-data', optionalAuth, async (req, res) => {
  try {
    const [methodsRes, agentNumsRes] = await Promise.all([
      supabaseAdmin.from('payment_methods').select('id, name, icon').eq('is_active', true).order('sort_order'),
      supabaseAdmin
        .from('agent_payment_numbers')
        .select('id, agent_id, payment_method, number, rotation_hours, sort_order, is_active, created_at')
        .eq('is_active', true),
    ]);
    return res.json({
      paymentMethods: methodsRes.data || [],
      agentPaymentNumbers: agentNumsRes.data || [],
    });
  } catch (err) {
    console.error('withdraw-form-data error:', err);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
});

/**
 * GET /api/payments/lucky-agent-data
 * Returns agents, payment methods, and agent payment numbers for Lucky Agent flow.
 * Auth: Bearer token (optional - public data for authenticated users).
 */
router.get('/lucky-agent-data', requireAuth, async (req, res) => {
  try {
    const { data: roles } = await supabaseAdmin
      .from('user_roles')
      .select('user_id')
      .eq('role', 'payment_agent');

    const userIds = (roles || []).map((r) => r.user_id);
    if (userIds.length === 0) {
      return res.json({ agents: [], paymentMethods: [], agentPaymentNumbers: [] });
    }

    const [profilesRes, methodsRes, numbersRes] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('user_id, username, avatar_url, telegram_link')
        .in('user_id', userIds),
      supabaseAdmin
        .from('payment_methods')
        .select('id, name, icon')
        .eq('is_active', true)
        .order('sort_order'),
      supabaseAdmin
        .from('agent_payment_numbers')
        .select('agent_id, payment_method, number')
        .eq('is_active', true),
    ]);

    const agents = (profilesRes.data || []).map((p) => ({
      user_id: p.user_id,
      username: p.username,
      avatar_url: p.avatar_url,
      telegram_link: p.telegram_link,
    }));

    const paymentMethods = (methodsRes.data || []).map((m) => ({
      id: m.id,
      name: m.name,
      icon: m.icon,
    }));

    const agentPaymentNumbers = (numbersRes.data || []).map((n) => ({
      agent_id: n.agent_id,
      payment_method: n.payment_method,
      number: n.number,
    }));

    return res.json({ agents, paymentMethods, agentPaymentNumbers });
  } catch (err) {
    console.error('lucky-agent-data error:', err);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
});

/**
 * GET /api/payments/check-deposit-trx?trx_id=xxx
 * Returns { duplicate: true } if trx_id already exists.
 */
router.get('/check-deposit-trx', requireAuth, async (req, res) => {
  const trxId = (req.query.trx_id || '').toString().trim();
  if (!trxId) {
    return res.json({ duplicate: false });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('deposits')
      .select('id')
      .eq('trx_id', trxId)
      .limit(1);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ duplicate: !!(data && data.length > 0) });
  } catch (err) {
    console.error('check-deposit-trx error:', err);
    return res.status(500).json({ error: 'Failed to check' });
  }
});

/**
 * POST /api/payments/deposits
 * Body: { amount, method, trx_id, phone, assigned_agent_id? }
 * Creates a deposit request. Auth: Bearer token.
 */
router.post('/deposits', requireAuth, async (req, res) => {
  const { amount, method, trx_id, phone, assigned_agent_id } = req.body || {};
  if (!amount || !method || !trx_id || !phone) {
    return res.status(400).json({ error: 'amount, method, trx_id, phone required' });
  }
  const amt = Number(amount);
  if (amt < 200) {
    return res.status(400).json({ error: 'Minimum deposit ৳200' });
  }

  try {
    const insertData = {
      user_id: req.user.id,
      amount: amt,
      method: String(method),
      trx_id: String(trx_id).trim(),
      phone: String(phone).trim(),
      status: 'pending',
    };
    if (assigned_agent_id) insertData.assigned_agent_id = assigned_agent_id;

    const { data, error } = await supabaseAdmin.from('deposits').insert(insertData).select('id').single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ success: true, id: data.id });
  } catch (err) {
    console.error('deposits create error:', err);
    return res.status(500).json({ error: 'Failed to submit deposit' });
  }
});

/**
 * POST /api/payments/withdrawals
 * Body: { amount, method, phone, assigned_agent_id? }
 * Deducts balance and creates withdrawal request. Atomic - if insert fails, refunds.
 * Auth: Bearer token.
 */
router.post('/withdrawals', requireAuth, async (req, res) => {
  const { amount, method, phone, assigned_agent_id } = req.body || {};
  if (!amount || !method || !phone) {
    return res.status(400).json({ error: 'amount, method, phone required' });
  }
  const amt = Number(amount);
  if (amt < 500) {
    return res.status(400).json({ error: 'Minimum withdraw ৳500' });
  }
  if (String(phone).length < 11) {
    return res.status(400).json({ error: 'Enter valid wallet number' });
  }

  try {
    const { data: withdrawable, error: withdrawableErr } = await supabaseAdmin.rpc('get_withdrawable_balance', {
      p_user_id: req.user.id,
    });
    if (withdrawableErr) {
      return res.status(400).json({ error: withdrawableErr.message || 'Could not check balance' });
    }
    const withdrawableAmt = Number(withdrawable ?? 0);
    if (amt > withdrawableAmt) {
      return res.status(400).json({
        error:
          withdrawableAmt <= 0
            ? 'Complete bonus turnover requirement before withdrawing'
            : `Withdrawable balance ৳${withdrawableAmt.toLocaleString()}. Complete bonus turnover to unlock more.`,
      });
    }

    const { data: newBalance, error: rpcError } = await supabaseAdmin.rpc('adjust_wallet_balance', {
      p_user_id: req.user.id,
      p_amount: -amt,
    });
    if (rpcError) {
      return res.status(400).json({ error: rpcError.message || 'Insufficient balance' });
    }
    if (newBalance === null || newBalance === undefined) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const insertData = {
      user_id: req.user.id,
      amount: amt,
      method: String(method),
      phone: String(phone).trim(),
      status: 'pending',
    };
    if (assigned_agent_id) insertData.assigned_agent_id = assigned_agent_id;

    const { data: withdrawal, error: insertError } = await supabaseAdmin
      .from('withdrawals')
      .insert(insertData)
      .select('id, withdrawal_code')
      .single();

    if (insertError) {
      await supabaseAdmin.rpc('adjust_wallet_balance', {
        p_user_id: req.user.id,
        p_amount: amt,
      });
      return res.status(400).json({ error: insertError.message || 'Failed to submit withdrawal' });
    }

    return res.json({
      success: true,
      id: withdrawal.id,
      withdrawal_code: withdrawal.withdrawal_code,
      new_balance: Number(newBalance),
    });
  } catch (err) {
    console.error('withdrawals create error:', err);
    return res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

/**
 * GET /api/payments/withdrawals
 * Returns withdrawals for the logged-in user.
 * - If agent: only withdrawals assigned to this agent (with user profiles)
 * - If admin: all withdrawals (with user profiles)
 * Auth: Bearer token.
 */
router.get('/withdrawals', requireAuth, async (req, res) => {
  try {
    const isAdmin = await userHasRole(req.user.id, 'admin');
    const isAgent = await userHasRole(req.user.id, 'payment_agent');

    let query = supabaseAdmin.from('withdrawals').select('*').order('created_at', { ascending: false });
    if (!isAdmin && isAgent) {
      query = query.eq('assigned_agent_id', req.user.id);
    } else if (!isAdmin) {
      query = query.eq('user_id', req.user.id);
    }

    const { data: withdrawals, error } = await query;
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!withdrawals?.length) {
      return res.json([]);
    }

    const userIds = [...new Set(withdrawals.map((w) => w.user_id))];
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('user_id, username, user_code')
      .in('user_id', userIds);
    const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]));

    const enriched = withdrawals.map((w) => ({
      ...w,
      username: profileMap.get(w.user_id)?.username || 'Unknown',
      user_code: profileMap.get(w.user_id)?.user_code || '—',
    }));
    return res.json(enriched);
  } catch (err) {
    console.error('withdrawals list error:', err);
    return res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

/**
 * POST /api/payments/withdrawals/:id/reject
 * Agent rejects a withdrawal. Trigger will refund user.
 * Auth: Bearer token (agent or admin).
 */
router.post('/withdrawals/:id/reject', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const isAdmin = await userHasRole(req.user.id, 'admin');
    const isAgent = await userHasRole(req.user.id, 'payment_agent');
    if (!isAdmin && !isAgent) {
      return res.status(403).json({ error: 'Agent or admin access required' });
    }

    const { data: w, error: fetchErr } = await supabaseAdmin
      .from('withdrawals')
      .select('id, assigned_agent_id, status')
      .eq('id', id)
      .single();
    if (fetchErr || !w) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    if (w.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already processed' });
    }
    if (!isAdmin && w.assigned_agent_id && w.assigned_agent_id !== req.user.id) {
      return res.status(403).json({ error: 'Not assigned to you' });
    }

    const { error: updateErr } = await supabaseAdmin
      .from('withdrawals')
      .update({ status: 'rejected' })
      .eq('id', id)
      .eq('status', 'pending');
    if (updateErr) {
      return res.status(400).json({ error: updateErr.message });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('withdrawal reject error:', err);
    return res.status(500).json({ error: 'Failed to reject' });
  }
});

module.exports = router;
