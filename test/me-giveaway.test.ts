import assert from 'node:assert/strict';
import test from 'node:test';

import { memberStatusCopy } from '../src/copy/member-status.ts';
import { createGiveawayEntryRoute } from '../src/server/giveaway/member-entry-http.ts';
import type { DatabasePool } from '../src/server/db/pool.ts';
import type { FlagService } from '../src/server/flags/types.ts';
import {
  createGiveawayMemberEntryService,
  giveawayEntryIpLimit,
  type GiveawayMemberEntryInput,
} from '../src/server/giveaway/member-entry.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';

import {
  ageFixture,
  entriesClosed,
  entriesOf,
  insertEdge,
  insertMember,
  insertToken,
  laterTime,
  legacyRules,
  testSettings,
  verifyTime,
  type AgeFixture,
} from './helpers/waitlist-age-fixture.ts';

// E11.8-06: entering the giveaway later from /me (POST /api/me/giveaway).
// Turnstile first, audited, exactly the entries a tick at signup would have
// earned, nothing else changed, idempotent, and refused after entries close.

async function flagsOn(f: AgeFixture): Promise<FlagService> {
  const flags = f.flags();
  await flags.set('giveaway.open', true, 'e11-8-06-test');
  await flags.set('waitlist.age_13', true, 'e11-8-06-test');
  return flags;
}

function service(f: AgeFixture, flags: FlagService, now: Date = laterTime) {
  return createGiveawayMemberEntryService(f.app, {
    flags,
    currentRules: () => legacyRules,
    clock: () => now,
    settings: testSettings(false),
  });
}

const input = (
  token: string,
  ipPrefixHash = 'prefix-me',
): GiveawayMemberEntryInput => ({
  challengeTimedOut: false,
  ipPrefixHash,
  token,
});

/** Every column /me entry must leave alone, and the member's edges. */
async function snapshot(owner: DatabasePool, id: string) {
  return {
    subscriber: await owner.readOne({
      text: `SELECT status, admission_age_policy, marketing_consent_at,
                    marketing_consent_version, marketing_consent_source,
                    marketing_opt_in_pending, referred_by_id::text,
                    confirmed_referrals, access_window, referral_code
             FROM subscriber WHERE id = $1`,
      values: [id],
    }),
    edges: await owner.list(
      {
        text: `SELECT id::text, state, reward_state, confirmed_at, voided_at
               FROM referral_edge WHERE referrer_id = $1 OR referred_id = $1
               ORDER BY id`,
        values: [id],
      },
      100,
    ),
  };
}

async function optInAudits(owner: DatabasePool, id: string) {
  return owner.list<{ actor: string; detail: unknown }>(
    {
      text: `SELECT actor, detail FROM audit_log
             WHERE action = 'giveaway.opted_in' AND subject_id = $1`,
      values: [id],
    },
    10,
  );
}

const shape = (rows: readonly { method: string }[]) =>
  rows.map((row) => row.method).sort();

test('Turnstile is verified before anything else, and a rejected or missing challenge changes nothing', async () => {
  const calls: string[] = [];
  const route = createGiveawayEntryRoute({
    async verifyTurnstile() {
      calls.push('turnstile');
      return 'rejected';
    },
    async enter() {
      calls.push('enter');
      return 'accepted';
    },
    ipPrefixPepper: 'pepper',
  });
  const send = async (fields: Record<string, string>) => {
    const response = await route({
      clientAddress: '203.0.113.20',
      request: new Request('https://valstara.test/api/me/giveaway', {
        method: 'POST',
        body: new URLSearchParams(fields),
      }),
    } as never);
    return { status: response.status, body: await response.json() };
  };
  const refused = {
    status: 400,
    body: {
      error: {
        code: 'challenge_failed',
        message: memberStatusCopy.giveaway.challengeFailed,
      },
    },
  };
  assert.deepEqual(await send({ t: 'token', giveaway_opt_in: 'yes' }), refused);
  assert.deepEqual(calls, []);
  assert.deepEqual(
    await send({ t: 'token', giveaway_opt_in: 'yes', turnstile_token: 'bad' }),
    refused,
  );
  // An invalid body is refused only after the challenge, and never reaches
  // the service.
  assert.deepEqual(await send({ turnstile_token: 'bad' }), refused);
  assert.deepEqual(calls, ['turnstile', 'turnstile']);
});

test('entering grants exactly the entries a tick at signup earns, is audited, changes nothing else, and repeats change nothing', async () => {
  const f = await ageFixture('e11-8-06-me-entry');
  try {
    const flags = await flagsOn(f);
    // Two members with the same referrals: one ticked the box at signup and
    // was verified with it, one skipped it and enters from /me.
    const complete = createVerificationCompletionService(f.app, {
      clock: () => verifyTime,
      giveaway: {
        flags,
        currentRules: () => legacyRules,
        settings: testSettings(false),
      },
    });
    const build = async (tickedAtSignup: boolean) => {
      const member = await insertMember(f.owner, {
        status: 'pending',
        admission: '13_plus',
        ...(tickedAtSignup ? { optIn: 'signup' as const } : {}),
      });
      assert.equal(
        (await complete(await insertToken(f.owner, member))).outcome,
        'verified',
      );
      const ticked = await insertMember(f.owner, {
        status: 'pending',
        admission: '13_plus',
        optIn: 'signup',
      });
      const skipped = await insertMember(f.owner, {
        status: 'pending',
        admission: '13_plus',
      });
      await insertEdge(f.owner, member, ticked);
      await insertEdge(f.owner, member, skipped);
      for (const referred of [ticked, skipped])
        assert.equal(
          (await complete(await insertToken(f.owner, referred))).outcome,
          'verified',
        );
      return member;
    };
    const atSignup = await build(true);
    const fromMe = await build(false);
    assert.deepEqual(shape(await entriesOf(f.owner, atSignup)), [
      'base',
      'referral',
    ]);
    assert.deepEqual(await entriesOf(f.owner, fromMe), []);

    const before = await snapshot(f.owner, fromMe);
    const token = await insertToken(f.owner, fromMe, 'status');
    const entry = service(f, flags);
    assert.deepEqual(await entry.view(fromMe), {
      notEntered: true,
      offerBox: true,
    });
    assert.equal(await entry.enter(input(token)), 'accepted');

    const granted = await entriesOf(f.owner, fromMe);
    assert.deepEqual(shape(granted), shape(await entriesOf(f.owner, atSignup)));
    assert.ok(
      granted.every((row) => row.rules_version === legacyRules.rulesVersion),
    );
    assert.deepEqual(await snapshot(f.owner, fromMe), before);
    assert.deepEqual(await optInAudits(f.owner, fromMe), [
      { actor: 'subscriber', detail: { source: 'member_status' } },
    ]);
    const recorded = await f.owner.readOne<{
      giveaway_opt_in_at: Date;
      giveaway_opt_in_source: string;
    }>({
      text: `SELECT giveaway_opt_in_at, giveaway_opt_in_source FROM subscriber WHERE id = $1`,
      values: [fromMe],
    });
    assert.deepEqual(recorded, {
      giveaway_opt_in_at: laterTime,
      giveaway_opt_in_source: 'member_status',
    });
    assert.deepEqual(await entry.view(fromMe), {
      notEntered: false,
      offerBox: false,
    });

    // A repeat, sequential and concurrent, is the same success and changes
    // nothing: no second audit, no new entry, the same recorded time.
    const later = service(f, flags, new Date('2026-11-01T00:00:00.000Z'));
    const results = await Promise.all([
      later.enter(input(token, 'prefix-a')),
      later.enter(input(token, 'prefix-b')),
      later.enter(input(token, 'prefix-c')),
    ]);
    assert.deepEqual(results, ['accepted', 'accepted', 'accepted']);
    assert.deepEqual(await entriesOf(f.owner, fromMe), granted);
    assert.equal((await optInAudits(f.owner, fromMe)).length, 1);
    assert.deepEqual(
      await f.owner.readOne({
        text: `SELECT giveaway_opt_in_at, giveaway_opt_in_source FROM subscriber WHERE id = $1`,
        values: [fromMe],
      }),
      recorded,
    );
    // The member who ticked at signup is offered nothing, and entering
    // changes nothing for them.
    assert.deepEqual(await entry.view(atSignup), {
      notEntered: false,
      offerBox: false,
    });
    const signupToken = await insertToken(f.owner, atSignup, 'status');
    const atSignupEntries = await entriesOf(f.owner, atSignup);
    assert.equal(await entry.enter(input(signupToken, 'prefix-d')), 'accepted');
    assert.deepEqual(await entriesOf(f.owner, atSignup), atSignupEntries);
    assert.deepEqual(await optInAudits(f.owner, atSignup), []);
  } finally {
    await f.dispose();
  }
});

test('concurrent first submissions record the box once and grant each entry once', async () => {
  const f = await ageFixture('e11-8-06-me-concurrent');
  try {
    const flags = await flagsOn(f);
    const member = await insertMember(f.owner, { admission: '13_plus' });
    const token = await insertToken(f.owner, member, 'status');
    const entry = service(f, flags);
    assert.equal(await flags.isEnabled('waitlist.age_13'), true);
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((prefix) => entry.enter(input(token, prefix))),
    );
    assert.deepEqual(results, ['accepted', 'accepted', 'accepted', 'accepted']);
    assert.deepEqual(shape(await entriesOf(f.owner, member)), ['base']);
    assert.equal((await optInAudits(f.owner, member)).length, 1);
  } finally {
    await f.dispose();
  }
});

test('after entries close the box is not offered and the route refuses with the closed state', async () => {
  const f = await ageFixture('e11-8-06-me-closed');
  try {
    const flags = await flagsOn(f);
    const member = await insertMember(f.owner, { admission: '13_plus' });
    const token = await insertToken(f.owner, member, 'status');
    const closed = service(f, flags, entriesClosed);
    assert.deepEqual(await closed.view(member), {
      notEntered: true,
      offerBox: false,
    });
    const route = createGiveawayEntryRoute({
      verifyTurnstile: async () => 'verified',
      enter: (body) => closed.enter(body),
      ipPrefixPepper: 'pepper',
    });
    const response = await route({
      clientAddress: '203.0.113.21',
      request: new Request('https://valstara.test/api/me/giveaway', {
        method: 'POST',
        body: new URLSearchParams({
          t: token,
          giveaway_opt_in: 'yes',
          turnstile_token: 'ok',
        }),
      }),
    } as never);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: 'unavailable', message: memberStatusCopy.giveaway.closed },
    });
    // One instant before the close it is still open.
    const lastInstant = service(
      f,
      flags,
      new Date(entriesClosed.getTime() - 1),
    );
    assert.equal((await lastInstant.view(member)).offerBox, true);
    assert.deepEqual(await entriesOf(f.owner, member), []);
    assert.deepEqual(await optInAudits(f.owner, member), []);
  } finally {
    await f.dispose();
  }
});

test('the route answers saved, invalid input, rate limited and paused from the copy layer; an invalid link gets the saved answer and changes nothing', async () => {
  const f = await ageFixture('e11-8-06-me-route');
  try {
    const flags = await flagsOn(f);
    const member = await insertMember(f.owner, { admission: '13_plus' });
    const token = await insertToken(f.owner, member, 'status');
    const entry = service(f, flags);
    const route = createGiveawayEntryRoute({
      verifyTurnstile: async () => 'verified',
      enter: (body) => entry.enter(body),
      ipPrefixPepper: 'pepper',
    });
    const send = async (fields: Record<string, string>, address: string) => {
      const response = await route({
        clientAddress: address,
        request: new Request('https://valstara.test/api/me/giveaway', {
          method: 'POST',
          body: new URLSearchParams({ turnstile_token: 'ok', ...fields }),
        }),
      } as never);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      return { status: response.status, body: await response.json() };
    };
    const saved = {
      status: 200,
      body: { status: 'accepted', message: memberStatusCopy.giveaway.saved },
    };
    assert.deepEqual(await send({ t: token }, '203.0.113.30'), {
      status: 400,
      body: {
        error: {
          code: 'invalid_input',
          message: memberStatusCopy.giveaway.invalidInput,
        },
      },
    });
    assert.deepEqual(
      await send({ t: 'not-a-token', giveaway_opt_in: 'yes' }, '203.0.113.31'),
      saved,
    );
    assert.deepEqual(await entriesOf(f.owner, member), []);
    assert.deepEqual(
      await send({ t: token, giveaway_opt_in: 'yes' }, '203.0.113.31'),
      saved,
    );
    assert.deepEqual(shape(await entriesOf(f.owner, member)), ['base']);
    // The hashed IP prefix (all three addresses share one /24) is limited:
    // two attempts so far, three more pass, and the sixth is refused.
    for (let attempt = 3; attempt <= giveawayEntryIpLimit; attempt += 1)
      assert.deepEqual(
        await send({ t: token, giveaway_opt_in: 'yes' }, '203.0.113.32'),
        saved,
      );
    assert.deepEqual(
      await send({ t: token, giveaway_opt_in: 'yes' }, '203.0.113.32'),
      {
        status: 429,
        body: {
          error: {
            code: 'rate_limited',
            message: memberStatusCopy.giveaway.rateLimited,
          },
        },
      },
    );
  } finally {
    await f.dispose();
  }
});

test('flag off: the route reports paused and writes nothing, with waitlist.age_13, giveaway.open or member.dashboard off', async () => {
  const f = await ageFixture('e11-8-06-me-flag-off');
  try {
    const member = await insertMember(f.owner, { admission: '13_plus' });
    const token = await insertToken(f.owner, member, 'status');
    for (const off of [
      'waitlist.age_13',
      'giveaway.open',
      'member.dashboard',
    ] as const) {
      const flags = await flagsOn(f);
      await flags.set(off, false, 'e11-8-06-test');
      const entry = service(f, flags);
      assert.equal(
        await entry.enter(input(token, `prefix-${off}`)),
        'disabled',
        off,
      );
      assert.equal((await entry.view(member)).offerBox, false, off);
      const route = createGiveawayEntryRoute({
        verifyTurnstile: async () => 'verified',
        enter: (body) => entry.enter(body),
        ipPrefixPepper: 'pepper',
      });
      const response = await route({
        clientAddress: '203.0.113.40',
        request: new Request('https://valstara.test/api/me/giveaway', {
          method: 'POST',
          body: new URLSearchParams({
            t: token,
            giveaway_opt_in: 'yes',
            turnstile_token: 'ok',
          }),
        }),
      } as never);
      assert.equal(response.status, 503, off);
      assert.deepEqual(await response.json(), {
        error: {
          code: 'unavailable',
          message: memberStatusCopy.giveaway.paused,
        },
      });
    }
    assert.deepEqual(await entriesOf(f.owner, member), []);
    assert.deepEqual(await optInAudits(f.owner, member), []);
    const row = await f.owner.readOne<{ giveaway_opt_in_at: Date | null }>({
      text: 'SELECT giveaway_opt_in_at FROM subscriber WHERE id = $1',
      values: [member],
    });
    assert.equal(row?.giveaway_opt_in_at, null);
  } finally {
    await f.dispose();
  }
});
