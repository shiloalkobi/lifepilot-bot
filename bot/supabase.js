'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  console.log('[Supabase] Connected ✅');
} else {
  console.log('[Supabase] Not configured — using JSON fallback');
}

function isEnabled() {
  return supabase !== null;
}

module.exports = { supabase, isEnabled };
