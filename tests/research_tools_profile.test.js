'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../skills/research');
const { setProfile } = _internals;

const ctx = { chat_id: 758752313 };

test('treatment change without confirmed → returns confirmation_message_he', async () => {
  const fakeStore = {
    async applyProfileUpdate(_c, _u) {
      return {
        saved: false,
        confirmation_needed: true,
        proposed_changes: {
          treatments_before: ['DRG'],
          treatments_after:  ['DRG', 'gabapentin'],
        },
      };
    },
  };
  const out = await setProfile({ treatments: ['DRG', 'gabapentin'] }, ctx, { profileStore: fakeStore });
  assert.equal(out.ok, true);
  assert.equal(out.confirmation_needed, true);
  assert.match(out.confirmation_message_he, /אישור נדרש/);
  assert.match(out.confirmation_message_he, /DRG/);
  assert.match(out.confirmation_message_he, /gabapentin/);
  assert.match(out.confirmation_message_he, /"אישור" או "כן"/);
});

test('treatment change with confirmed=true → saves', async () => {
  let updatesPassed;
  const fakeStore = {
    async applyProfileUpdate(_c, u) {
      updatesPassed = u;
      return { saved: true, profile: { chat_id: 1, treatments: u.treatments }, treatments_changed: true };
    },
  };
  const out = await setProfile(
    { treatments: ['DRG', 'gabapentin'], confirmed: true },
    ctx,
    { profileStore: fakeStore },
  );
  assert.equal(updatesPassed.confirmed, true);
  assert.equal(out.ok, true);
  assert.equal(out.saved, true);
  assert.equal(out.treatments_changed, true);
});

test('profile_he-only update → no confirmation gate', async () => {
  const fakeStore = {
    async applyProfileUpdate() {
      return { saved: true, profile: { chat_id: 1, profile_he: 'updated' }, treatments_changed: false };
    },
  };
  const out = await setProfile({ profile_he: 'updated' }, ctx, { profileStore: fakeStore });
  assert.equal(out.ok, true);
  assert.equal(out.saved, true);
  assert.equal(out.confirmation_needed, undefined);
  assert.equal(out.treatments_changed, false);
});

test('confirmation_message_he handles empty before/after gracefully', async () => {
  const fakeStore = {
    async applyProfileUpdate() {
      return {
        saved: false,
        confirmation_needed: true,
        proposed_changes: { treatments_before: [], treatments_after: ['DRG'] },
      };
    },
  };
  const out = await setProfile({ treatments: ['DRG'] }, ctx, { profileStore: fakeStore });
  assert.match(out.confirmation_message_he, /נוכחי: \(ריק\)/);
  assert.match(out.confirmation_message_he, /מוצע: DRG/);
});

test('rejects when chat_id missing', async () => {
  await assert.rejects(setProfile({}, {}, { profileStore: {} }), /chat_id missing/);
});
