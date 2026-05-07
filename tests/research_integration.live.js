'use strict';

/**
 * Phase 4d Task 7 — limited live integration test.
 *
 * ONE end-to-end run with real services:
 *   • Real adapter fetch (1 PubMed query)
 *   • Real Gemini classification (1 article)
 *   • Real Supabase write (test article via upsertArticle)
 *   • Verify the row exists with correct shape
 *   • Cleanup: DELETE rows where source_id LIKE 'test-%'
 *
 * REQUIRES: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY
 *
 * If only anon fallback is available, RLS will block writes and reads.
 * Honest gap (4d.G* in 01d) documents this if the seat lacks service_role.
 *
 * Usage:
 *   node tests/research_integration.live.js
 */

require('dotenv').config();

const pubmed = require('../skills/research/sources/pubmed');
const { classifyArticle } = require('../skills/research/filter/tiers');
const articles = require('../skills/research/storage/articles');

const TEST_CHAT_ID = 999999;            // sentinel; not a real user
const SOURCE_ID_PREFIX = 'test-4d-';

(async () => {
  console.log('=== Phase 4d Task 7 — Live Integration Test ===');
  console.log('Auth role:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon (FALLBACK)');
  console.log('');

  let cleanupNeeded = false;
  try {
    // Step 1 — Real PubMed fetch (1 article)
    console.log('Step 1: pubmed.fetch (last 30 days)...');
    const realArticles = await pubmed.fetch(null, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    if (!realArticles.length) throw new Error('PubMed returned 0 articles — cannot proceed');
    const article = realArticles[0];
    // Re-prefix source_id so the test doesn't collide with production data
    // (and so cleanup can target it).
    const testArticle = {
      ...article,
      source_id: `${SOURCE_ID_PREFIX}${article.source_id}`,
    };
    console.log(`  → 1 article: ${testArticle.source_id} — "${testArticle.title.slice(0, 60)}…"`);

    // Step 2 — Real Gemini classification
    console.log('Step 2: classifyArticle (real Gemini)...');
    const classification = await classifyArticle(testArticle, { treatments: [] });
    console.log(`  → tier=${classification.tier}, blocked_by=${classification.blocked_by || '-'}, tokens=${classification._tokens?.total ?? '-'}`);

    if (classification.tier === 3) {
      console.log('  → article was tier-3 blocked; substituting a synthetic tier-1 to exercise upsert path');
      classification.tier = 1;
      classification.framing_he = null;
      classification.block_reason = null;
      classification.classifier_rationale = '[test substitution] synthetic tier 1';
    }

    // Step 3 — Real Supabase write
    console.log('Step 3: upsertArticle (real Supabase)...');
    cleanupNeeded = true;
    const saved = await articles.upsertArticle(testArticle, classification);
    console.log(`  → row id=${saved.id}, source_id=${saved.source_id}, tier=${saved.tier}, framing_he=${saved.framing_he ? 'set' : 'null'}`);

    // Step 4 — Mark surfaced + verify
    console.log('Step 4: markSurfaced + verify...');
    await articles.markSurfaced(saved.id, TEST_CHAT_ID);
    const history = await articles.getHistory(TEST_CHAT_ID, 5);
    const found = history.find(a => a.id === saved.id);
    if (!found) throw new Error('upserted row not found via getHistory');
    if (found.surfaced_to_chat_id !== TEST_CHAT_ID) throw new Error('surfaced_to_chat_id not set correctly');
    if (![1, 2].includes(found.tier)) throw new Error(`tier ${found.tier} not in {1,2}`);
    console.log('  → verified: row visible via getHistory, surfaced_to_chat_id correctly set');

    // Step 5 — Cleanup
    console.log('Step 5: cleanup DELETE WHERE source_id LIKE test-%...');
    await articles.deleteBySourceIdPrefix(SOURCE_ID_PREFIX);
    cleanupNeeded = false;
    const post = await articles.getHistory(TEST_CHAT_ID, 5);
    const stillThere = post.find(a => a.source_id && a.source_id.startsWith(SOURCE_ID_PREFIX));
    if (stillThere) throw new Error('cleanup did not remove the test row');
    console.log('  → cleanup verified');

    console.log('');
    console.log('=== ALL STEPS PASS ✅ ===');
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('=== INTEGRATION TEST FAILED ❌ ===');
    console.error(err.message);
    if (cleanupNeeded) {
      try {
        await articles.deleteBySourceIdPrefix(SOURCE_ID_PREFIX);
        console.error('Cleanup attempted on failure path.');
      } catch (e) {
        console.error('Cleanup also failed:', e.message);
      }
    }
    process.exit(1);
  }
})();
