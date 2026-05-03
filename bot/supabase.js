'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;

const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const ROLE         = SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
  if (ROLE === 'service_role') {
    console.log('[Supabase] Connected ✅ — auth role: service_role');
  } else {
    console.log('[Supabase] Connected ✅ — auth role: anon (FALLBACK — set SUPABASE_SERVICE_ROLE_KEY)');
  }
} else {
  console.log('[Supabase] Not configured — using JSON fallback');
}

function isEnabled() {
  return supabase !== null;
}

module.exports = { supabase, isEnabled };
