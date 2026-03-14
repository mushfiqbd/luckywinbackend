const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../services/supabase');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/**
 * POST /api/admin/set-password
 * Body: { user_id, password } (password min 6 chars)
 * Admin only. Sets user password via Supabase Auth.
 */
router.post('/set-password', requireAuth, requireAdmin, async (req, res) => {
  const { user_id, password } = req.body || {};
  if (!user_id || !password || password.length < 6) {
    return res.status(400).json({ error: 'user_id and password (min 6 chars) required' });
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, { password });
  if (error) {
    return res.status(400).json({ error: error.message });
  }
  return res.json({ success: true });
});

/**
 * POST /api/admin/approve-agent
 * Body: { application_id, password }
 * Admin only. Approves agent application: create/update user, assign role, wallet, update application.
 */
router.post('/approve-agent', requireAuth, requireAdmin, async (req, res) => {
  const { application_id, password } = req.body || {};
  if (!application_id || !password || password.length < 6) {
    return res.status(400).json({ error: 'application_id and password (min 6 chars) required' });
  }

  const { data: app, error: appErr } = await supabaseAdmin
    .from('agent_applications')
    .select('*')
    .eq('id', application_id)
    .single();

  if (appErr || !app) {
    return res.status(404).json({ error: 'Application not found' });
  }
  if (app.status !== 'pending') {
    return res.status(400).json({ error: 'Application already processed' });
  }

  const phone = app.phone.replace(/[^0-9]/g, '');
  const email = `${phone}@luckywin.app`;

  const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
  const existingUser = listData?.users?.find((u) => u.email === email);
  let userId;

  if (existingUser) {
    userId = existingUser.id;
    await supabaseAdmin.auth.admin.updateUserById(userId, { password });
  } else {
    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: app.name, phone },
    });
    if (createErr || !newUser?.user) {
      return res.status(500).json({ error: 'Failed to create user: ' + (createErr?.message || 'Unknown') });
    }
    userId = newUser.user.id;
  }

  await supabaseAdmin.from('user_roles').upsert(
    { user_id: userId, role: 'payment_agent' },
    { onConflict: 'user_id,role' }
  );

  const { data: existingWallet } = await supabaseAdmin
    .from('agent_wallets')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (!existingWallet) {
    await supabaseAdmin.from('agent_wallets').insert({ user_id: userId });
  }

  // Ensure profile exists so agent shows in Payment Agents list
  const { data: existingProfile } = await supabaseAdmin
    .from('profiles')
    .select('user_id')
    .eq('user_id', userId)
    .single();
  if (existingProfile) {
    await supabaseAdmin.from('profiles').update({
      username: app.name,
      phone: phone,
    }).eq('user_id', userId);
  } else {
    const { data: refCode } = await supabaseAdmin.rpc('generate_refer_code');
    const { data: uCode } = await supabaseAdmin.rpc('generate_user_code');
    await supabaseAdmin.from('profiles').insert({
      user_id: userId,
      username: app.name,
      phone: phone,
      refer_code: refCode ?? null,
      user_code: uCode ?? null,
    });
  }

  await supabaseAdmin
    .from('agent_applications')
    .update({
      status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: req.user.id,
    })
    .eq('id', application_id);

  return res.json({
    success: true,
    user_id: userId,
    phone,
    message: `Agent ${app.name} approved and account created`,
  });
});

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('880')) digits = '0' + digits.slice(3);
  if (!digits.startsWith('0')) digits = '0' + digits;
  return digits;
}

/**
 * POST /api/admin/add-agent-direct
 * Body: { phone, password, name? }
 * Admin only. Creates agent directly (no application). Agent logs in at /agent-login with phone + password.
 */
router.post('/add-agent-direct', requireAuth, requireAdmin, async (req, res) => {
  const { phone: rawPhone, password, name } = req.body || {};
  if (!rawPhone || !password || password.length < 6) {
    return res.status(400).json({ error: 'phone and password (min 6 chars) required' });
  }

  const phone = normalizePhone(rawPhone);
  if (!/^01[3-9]\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid BD phone (01XXXXXXXXX)' });
  }

  const email = `${phone}@luckywin.app`;
  const displayName = (name && String(name).trim()) || phone;

  const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
  const existingUser = listData?.users?.find((u) => u.email === email);
  let userId;

  if (existingUser) {
    userId = existingUser.id;
    await supabaseAdmin.auth.admin.updateUserById(userId, { password });
  } else {
    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: displayName, phone },
    });
    if (createErr || !newUser?.user) {
      return res.status(500).json({ error: 'Failed to create user: ' + (createErr?.message || 'Unknown') });
    }
    userId = newUser.user.id;
  }

  const { data: existingRole } = await supabaseAdmin
    .from('user_roles')
    .select('id')
    .eq('user_id', userId)
    .eq('role', 'payment_agent')
    .single();
  if (!existingRole) {
    await supabaseAdmin.from('user_roles').insert({ user_id: userId, role: 'payment_agent' });
  }

  const { data: existingWallet } = await supabaseAdmin
    .from('agent_wallets')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (!existingWallet) {
    await supabaseAdmin.from('agent_wallets').insert({ user_id: userId });
  }

  const { data: existingProfile } = await supabaseAdmin
    .from('profiles')
    .select('user_id')
    .eq('user_id', userId)
    .single();
  if (existingProfile) {
    await supabaseAdmin.from('profiles').update({ username: displayName, phone }).eq('user_id', userId);
  } else {
    const { data: refCode } = await supabaseAdmin.rpc('generate_refer_code');
    const { data: uCode } = await supabaseAdmin.rpc('generate_user_code');
    await supabaseAdmin.from('profiles').insert({
      user_id: userId,
      username: displayName,
      phone,
      refer_code: refCode ?? null,
      user_code: uCode ?? null,
    });
  }

  return res.json({
    success: true,
    user_id: userId,
    phone,
    message: 'Agent created. Login at /agent-login with this number and password.',
  });
});

/**
 * POST /api/admin/create-sub-admin
 * Body: { phone, password, name? }
 * Admin only. Creates sub-admin (moderator) with phone + password. Sub-admin logs in at admin panel with same credentials.
 */
router.post('/create-sub-admin', requireAuth, requireAdmin, async (req, res) => {
  const { phone: rawPhone, password, name } = req.body || {};
  if (!rawPhone || !password || password.length < 6) {
    return res.status(400).json({ error: 'phone and password (min 6 chars) required' });
  }

  const phone = normalizePhone(rawPhone);
  if (!/^01[3-9]\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid BD phone (01XXXXXXXXX)' });
  }

  const email = `${phone}@luckywin.app`;
  const displayName = (name && String(name).trim()) || phone;

  const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
  const existingUser = listData?.users?.find((u) => u.email === email);
  let userId;

  if (existingUser) {
    userId = existingUser.id;
    await supabaseAdmin.auth.admin.updateUserById(userId, { password });
  } else {
    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: displayName, phone },
    });
    if (createErr || !newUser?.user) {
      return res.status(500).json({ error: 'Failed to create user: ' + (createErr?.message || 'Unknown') });
    }
    userId = newUser.user.id;
  }

  const { data: existingRoles } = await supabaseAdmin
    .from('user_roles')
    .select('role')
    .eq('user_id', userId);
  const hasAdminOrMod = existingRoles?.some((r) => r.role === 'admin' || r.role === 'moderator');
  if (hasAdminOrMod) {
    return res.status(400).json({ error: 'User is already admin or sub-admin' });
  }

  await supabaseAdmin.from('user_roles').insert({ user_id: userId, role: 'moderator' });
  await supabaseAdmin.from('sub_admin_permissions').insert({ user_id: userId, module: '/admin/dashboard' });

  const { data: existingProfile } = await supabaseAdmin
    .from('profiles')
    .select('user_id')
    .eq('user_id', userId)
    .single();
  if (existingProfile) {
    await supabaseAdmin.from('profiles').update({ username: displayName, phone }).eq('user_id', userId);
  } else {
    const { data: refCode } = await supabaseAdmin.rpc('generate_refer_code');
    const { data: uCode } = await supabaseAdmin.rpc('generate_user_code');
    await supabaseAdmin.from('profiles').insert({
      user_id: userId,
      username: displayName,
      phone,
      refer_code: refCode ?? null,
      user_code: uCode ?? null,
    });
  }

  return res.json({
    success: true,
    user_id: userId,
    phone,
    message: 'Sub-admin created. Login at admin panel with this phone and password.',
  });
});

module.exports = router;
