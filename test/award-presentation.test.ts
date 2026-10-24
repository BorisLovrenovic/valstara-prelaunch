import assert from 'node:assert/strict';
import test from 'node:test';

import { giveawayAwardCopy as copy } from '../src/copy/giveaway-award.ts';
import type { ActiveOwnAward } from '../src/server/giveaway/award.ts';
import {
  awardCardState,
  awardNotice,
  confirmedAwardMessage,
} from '../src/server/giveaway/award-presentation.ts';

function award(
  state: ActiveOwnAward['state'],
  substitutionState: ActiveOwnAward['substitutionState'] = 'none',
): ActiveOwnAward {
  return {
    id: 'award',
    state,
    substitutionState,
    responseDeadline: new Date('2099-01-01T00:00:00Z'),
    substitutionDeadline: null,
    country: null,
    replacements: [],
  };
}

test('every award outcome keeps its E7-06 message and gains an icon and tone', () => {
  assert.equal(awardNotice(null), null);
  assert.deepEqual(awardNotice('challenge_failed'), {
    message: copy.challengeFailed,
    icon: 'alert',
    tone: 'error',
  });
  assert.deepEqual(awardNotice('rate_limited'), {
    message: copy.rateLimited,
    icon: 'clock',
    tone: 'error',
  });
  for (const outcome of ['disabled', 'unavailable'] as const)
    assert.deepEqual(awardNotice(outcome), {
      message: copy.paused,
      icon: 'clock',
      tone: 'error',
    });
  assert.deepEqual(awardNotice('invalid_input'), {
    message: copy.invalidInput,
    icon: 'alert',
    tone: 'error',
  });
  assert.deepEqual(awardNotice('replaced'), {
    message: copy.replaced,
    icon: 'alert',
    tone: 'error',
  });
  for (const outcome of [
    'accepted',
    'confirmed',
    'substitution_offered',
  ] as const)
    assert.deepEqual(awardNotice(outcome), {
      message: copy.saved,
      icon: 'check',
      tone: 'success',
    });
});

test('the award card state follows the bearer’s own award', () => {
  assert.deepEqual(awardCardState(null), {
    state: 'unavailable',
    icon: 'alert',
  });
  assert.deepEqual(awardCardState({ id: 'award', state: 'replaced' }), {
    state: 'replaced',
    icon: 'alert',
  });
  assert.deepEqual(awardCardState(award('notified')), {
    state: 'checks',
    icon: 'shield',
  });
  assert.deepEqual(awardCardState(award('confirmed', 'offered')), {
    state: 'substitution',
    icon: 'shield',
  });
  for (const substitution of ['none', 'cash', 'replacement'] as const)
    assert.deepEqual(awardCardState(award('confirmed', substitution)), {
      state: 'confirmed',
      icon: 'check',
    });
  // Unchanged from E7-06: every other state renders the exhausted line.
  for (const state of ['exhausted', 'delivered'] as const)
    assert.deepEqual(awardCardState(award(state)), {
      state: 'exhausted',
      icon: 'alert',
    });
});

test('a confirmed award names its substitution outcome', () => {
  assert.equal(confirmedAwardMessage(award('confirmed')), copy.confirmed);
  assert.equal(confirmedAwardMessage(award('confirmed', 'cash')), copy.cash);
  assert.equal(
    confirmedAwardMessage(award('confirmed', 'replacement')),
    copy.replacement,
  );
  assert.equal(
    confirmedAwardMessage({ id: 'award', state: 'replaced' }),
    copy.replaced,
  );
});
