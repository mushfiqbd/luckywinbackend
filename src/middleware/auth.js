const { getAnonClient } = require('../services/supabase');

/**
 * Expects Authorization: Bearer <jwt>.
 * Verifies the token with Supabase Auth and sets req.user = { id }.
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const anonClient = getAnonClient();
    const { data, error } = await anonClient.auth.getUser(token);
    if (error || !data?.user?.id) {
      throw error || new Error('Invalid token');
    }
    req.user = { id: data.user.id };
    req.jwt = token;
    return next();
  } catch (e) {
    req.user = null;
    return next();
  }
}

/** Require auth; 401 if no user */
function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
}

/** Require admin role (uses Supabase RPC has_role) */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { supabaseAdmin } = require('../services/supabase');
  supabaseAdmin
    .rpc('has_role', { _user_id: req.user.id, _role: 'admin' })
    .then(({ data }) => {
      if (!data) return res.status(403).json({ error: 'Admin access required' });
      next();
    })
    .catch((err) => {
      console.error('requireAdmin error:', err);
      res.status(500).json({ error: 'Server error' });
    });
}

module.exports = { optionalAuth, requireAuth, requireAdmin };
