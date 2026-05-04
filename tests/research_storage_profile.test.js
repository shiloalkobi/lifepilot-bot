'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const profile = require('../skills/research/storage/profile');

// More-elaborate mock: each call to .from() returns a builder that we can
// program with sequential responses, since some flows do multiple round-trips
// (e.g., ensureProfile → maybeSingle → insert → single).
function makeClient() {
  const queue = [];
  const calls = [];
  return {
    queueResponse(resp) { queue.push(resp); },
    calls,
    from(table) {
      const ops = [];
      const proxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve) => {
              calls.push({ table, ops: [...ops] });
              const next = queue.shift() || { data: null, error: null };
              resolve(next);
            };
          }
          return (...args) => { ops.push([prop, ...args]); return proxy; };
        },
      });
      return proxy;
    },
  };
}

test('isSameDayInIL returns true for "now" timestamps', () => {
  assert.equal(profile.isSameDayInIL(new Date().toISOString()), true);
});

test('isSameDayInIL returns false for null', () => {
  assert.equal(profile.isSameDayInIL(null), false);
  assert.equal(profile.isSameDayInIL(undefined), false);
});

test('isSameDayInIL returns false for old timestamps', () => {
  const oldIso = '2020-01-01T00:00:00Z';
  assert.equal(profile.isSameDayInIL(oldIso), false);
});

test('getProfile returns null when not found', async () => {
  const client = makeClient();
  client.queueResponse({ data: null, error: null });
  const out = await profile.getProfile(123, client);
  assert.equal(out, null);
});

test('getProfile returns the row when found', async () => {
  const expected = { chat_id: 123, treatments: ['DRG'] };
  const client = makeClient();
  client.queueResponse({ data: expected, error: null });
  const out = await profile.getProfile(123, client);
  assert.deepEqual(out, expected);
});

test('ensureProfile returns existing profile without insert', async () => {
  const existing = { chat_id: 123, treatments: [] };
  const client = makeClient();
  client.queueResponse({ data: existing, error: null });   // getProfile maybeSingle
  const out = await profile.ensureProfile(123, client);
  assert.deepEqual(out, existing);
  assert.equal(client.calls.length, 1, 'only the maybeSingle lookup happens');
});

test('ensureProfile inserts when missing', async () => {
  const client = makeClient();
  client.queueResponse({ data: null, error: null });                            // getProfile
  client.queueResponse({ data: { chat_id: 123, treatments: [] }, error: null }); // insert single
  const out = await profile.ensureProfile(123, client);
  assert.equal(out.chat_id, 123);
  assert.equal(client.calls.length, 2);
});

test('applyProfileUpdate: profile_he change saves directly (no confirmation)', async () => {
  const client = makeClient();
  // ensureProfile path: maybeSingle returns existing
  client.queueResponse({ data: { chat_id: 123, treatments: [] }, error: null });
  // update path: returns updated row
  client.queueResponse({ data: { chat_id: 123, treatments: [], profile_he: 'new' }, error: null });

  const out = await profile.applyProfileUpdate(123, { profile_he: 'new' }, client);
  assert.equal(out.saved, true);
  assert.equal(out.profile.profile_he, 'new');
});

test('applyProfileUpdate: treatments change WITHOUT confirmed → no save, returns confirmation_needed', async () => {
  const client = makeClient();
  client.queueResponse({ data: { chat_id: 123, treatments: ['DRG'] }, error: null });
  // No second response queued because no DB write should happen.

  const out = await profile.applyProfileUpdate(
    123,
    { treatments: ['DRG', 'gabapentin'] },
    client,
  );
  assert.equal(out.saved, false);
  assert.equal(out.confirmation_needed, true);
  assert.deepEqual(out.proposed_changes.treatments_before, ['DRG']);
  assert.deepEqual(out.proposed_changes.treatments_after, ['DRG', 'gabapentin']);
  assert.equal(client.calls.length, 1, 'only the ensureProfile lookup occurred');
});

test('applyProfileUpdate: treatments change WITH confirmed=true → saves', async () => {
  const client = makeClient();
  client.queueResponse({ data: { chat_id: 123, treatments: ['DRG'] }, error: null });
  client.queueResponse({ data: { chat_id: 123, treatments: ['DRG', 'gabapentin'] }, error: null });

  const out = await profile.applyProfileUpdate(
    123,
    { treatments: ['DRG', 'gabapentin'], confirmed: true },
    client,
  );
  assert.equal(out.saved, true);
  assert.equal(out.treatments_changed, true);
  assert.deepEqual(out.profile.treatments, ['DRG', 'gabapentin']);
});

test('applyProfileUpdate: treatments unchanged → no confirmation needed', async () => {
  const client = makeClient();
  client.queueResponse({ data: { chat_id: 123, treatments: ['DRG'] }, error: null });
  // No write call because nothing to save.
  const out = await profile.applyProfileUpdate(123, { treatments: ['DRG'] }, client);
  assert.equal(out.saved, false);
  assert.equal(out.confirmation_needed, undefined);
  assert.equal(client.calls.length, 1);
});

test('applyProfileUpdate: array order does not matter for treatments equality', async () => {
  const client = makeClient();
  client.queueResponse({ data: { chat_id: 123, treatments: ['DRG', 'gabapentin'] }, error: null });
  const out = await profile.applyProfileUpdate(123, { treatments: ['gabapentin', 'DRG'] }, client);
  assert.equal(out.saved, false);
  assert.equal(out.confirmation_needed, undefined);
});

test('needsDisclaimer returns true when no profile yet', async () => {
  const client = makeClient();
  client.queueResponse({ data: null, error: null });
  assert.equal(await profile.needsDisclaimer(123, client), true);
});

test('needsDisclaimer returns true on stale last_disclaimer_seen', async () => {
  const client = makeClient();
  client.queueResponse({ data: { chat_id: 123, last_disclaimer_seen: '2020-01-01T00:00:00Z' }, error: null });
  assert.equal(await profile.needsDisclaimer(123, client), true);
});

test('needsDisclaimer returns false on same-IL-day timestamp', async () => {
  const client = makeClient();
  client.queueResponse({ data: { chat_id: 123, last_disclaimer_seen: new Date().toISOString() }, error: null });
  assert.equal(await profile.needsDisclaimer(123, client), false);
});

test('applyProfileUpdate redacts DB error message (no PHI)', async () => {
  const client = makeClient();
  client.queueResponse({ data: { chat_id: 123, treatments: [] }, error: null });
  client.queueResponse({ data: null, error: { message: 'leak: Hebrew profile body here' } });

  await assert.rejects(
    profile.applyProfileUpdate(123, { profile_he: 'new sensitive content' }, client),
    /applyProfileUpdate failed: DB write error$/,
  );
});
