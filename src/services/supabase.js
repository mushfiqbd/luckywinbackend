const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

/** Service role client - for backend only, full DB access */
const supabaseAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Anon client - for auth.getUser(token) when verifying JWT from frontend */
let supabaseAnon = null;
function getAnonClient() {
  if (!anonKey) {
    throw new Error('SUPABASE_ANON_KEY is required for backend auth verification');
  }
  if (!supabaseAnon) {
    supabaseAnon = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return supabaseAnon;
}

module.exports = { supabaseAdmin, getAnonClient };
