import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { createFraudFlagRepository } from '../src/server/db/fraud-flag.ts';
import type { DatabasePool } from '../src/server/db/pool.ts';
import type { FlagService } from '../src/server/flags/types.ts';
import type { CurrentGiveawayRules } from '../src/server/giveaway/accrue.ts';
import type { WaitlistAgeSettings } from '../src/server/giveaway/age-policy.ts';
import { createGiveawayMemberEntryService } from '../src/server/giveaway/member-entry.ts';
import { createGiveawayEntryReconciliationJob } from '../src/server/giveaway/reconcile.ts';
import {
  createPartnerApplicationHandler,
  createPartnerSubmitService,
} from '../src/server/partner/application.ts';
import { partnerApplicationIpWindowMs } from '../src/server/partner/config.ts';
import { createPartnerConfirmationService } from '../src/server/partner/confirm.ts';
import { consumeRateLimit } from '../src/server/ratelimit/consume.ts';
import { createPartnerCodeRules } from '../src/server/referral/partner-code.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

import {
  ageFixture,
  boxRules,
  entriesOf,
  insertEdge,
  insertMember,
  insertToken,
  laterTime,
  legacyRules,
  signupTime,
  testSettings,
  verifyTime,
  type AgeFixture,
} from './helpers/waitlist-age-fixture.ts';

// E11.8-06: who holds giveaway entries once the waitlist opens at 13. Live
// accrual at verification (E7-03), the application's confirmation (D-050)
// and the E7-03 reconciliation apply one box rule, under real concurrency
// against a real database. Decisions 1, 2, 4, 6 and 8 are on the ticket.

const settingNo = testSettings(false);
const settingYes = testSettings(true);

interface Flags {
  readonly service: FlagService;
  age(on: boolean): Promise<void>;
}

async function openGiveaway(f: AgeFixture, ageThirteen: boolean) {
  const service = f.flags();
  await service.set('giveaway.open', true, 'e11-8-06-test');
  await service.set('waitlist.age_13', ageThirteen, 'e11-8-06-test');
  return {
    service,
    age: (on: boolean) => service.set('waitlist.age_13', on, 'e11-8-06-test'),
  } satisfies Flags;
}

function verifier(
  f: AgeFixture,
  flags: FlagService,
  options: {
    readonly rules?: CurrentGiveawayRules;
    readonly settings?: WaitlistAgeSettings;
    readonly clock?: Date;
  } = {},
) {
  return createVerificationCompletionService(f.app, {
    clock: () => options.clock ?? verifyTime,
    giveaway: {
      flags,
      currentRules: () => options.rules ?? legacyRules,
      settings: options.settings ?? settingNo,
    },
  });
}

function reconciliation(
  f: AgeFixture,
  flags: FlagService,
  options: {
    readonly rules?: CurrentGiveawayRules;
    readonly settings?: WaitlistAgeSettings;
  } = {},
) {
  return createGiveawayEntryReconciliationJob(
    f.app,
    flags,
    async () => options.rules ?? legacyRules,
    undefined,
    () => laterTime,
    undefined,
    options.settings ?? settingNo,
  );
}

function memberEntry(
  f: AgeFixture,
  flags: FlagService,
  settings: WaitlistAgeSettings = settingNo,
) {
  return createGiveawayMemberEntryService(f.app, {
    flags,
    currentRules: () => legacyRules,
    clock: () => laterTime,
    settings,
  });
}

/** A pending member with a live verification link. */
async function pending(
  owner: DatabasePool,
  input: Parameters<typeof insertMember>[1] = {},
): Promise<{ id: string; token: string }> {
  const id = await insertMember(owner, { ...input, status: 'pending' });
  return { id, token: await insertToken(owner, id) };
}

const methods = (rows: readonly { method: string }[]) =>
  rows.map((row) => row.method);

test('with the flag on, a base entry needs the 18+ box, and earlier members keep theirs', async () => {
  const f = await ageFixture('e11-8-06-base');
  try {
    // An earlier member, verified and entered while the waitlist was 18+.
    const earlier = await insertMember(f.owner, { verifiedAt: verifyTime });
    const flags = await openGiveaway(f, false);
    assert.deepEqual(methods(await entriesOf(f.owner, earlier)), ['base']);

    await flags.age(true);
    const ticked = await pending(f.owner, {
      admission: '13_plus',
      optIn: 'signup',
    });
    const skipped = await pending(f.owner, { admission: '13_plus' });
    // A pending 18+ row from before the flag, verifying after it.
    const before = await pending(f.owner, { admission: '18_plus' });
    const complete = verifier(f, flags.service);
    for (const member of [ticked, skipped, before]) {
      assert.equal((await complete(member.token)).outcome, 'verified');
    }
    assert.deepEqual(methods(await entriesOf(f.owner, ticked.id)), ['base']);
    assert.deepEqual(await entriesOf(f.owner, skipped.id), []);
    assert.deepEqual(await entriesOf(f.owner, before.id), []);

    // Reconciliation fills nothing for them, and touches no earlier entry.
    // It never even selects a member who needs the box, so they cannot fill
    // its batch and hold up the members behind them.
    const run = await reconciliation(f, flags.service).run(1_000);
    assert.deepEqual(run, { checked: 0, accrued: 0 });
    assert.deepEqual(await entriesOf(f.owner, skipped.id), []);
    assert.deepEqual(await entriesOf(f.owner, before.id), []);
    assert.deepEqual(methods(await entriesOf(f.owner, earlier)), ['base']);
    const voided = await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text FROM giveaway_entry WHERE voided_at IS NOT NULL`,
    });
    assert.equal(voided?.count, '0');
  } finally {
    await f.dispose();
  }
});

test('the referral-entry setting: at no, a referral by a member without the box earns nothing; at yes, it earns the referrer an entry', async () => {
  for (const [setting, expected] of [
    [settingNo, false],
    [settingYes, true],
  ] as const) {
    const f = await ageFixture('e11-8-06-referral');
    try {
      const flags = await openGiveaway(f, true);
      const referrer = await insertMember(f.owner, { optIn: 'signup' });
      const boxless = await insertMember(f.owner);
      const ticked = await pending(f.owner, {
        admission: '13_plus',
        optIn: 'signup',
      });
      const skipped = await pending(f.owner, { admission: '13_plus' });
      const tickedEdge = await insertEdge(f.owner, referrer, ticked.id);
      const skippedEdge = await insertEdge(f.owner, referrer, skipped.id);
      // A referrer without the box earns nothing, whatever the setting.
      const toBoxless = await pending(f.owner, {
        admission: '13_plus',
        optIn: 'signup',
      });
      await insertEdge(f.owner, boxless, toBoxless.id);

      const complete = verifier(f, flags.service, { settings: setting });
      for (const member of [ticked, skipped, toBoxless]) {
        assert.equal((await complete(member.token)).outcome, 'verified');
      }
      const referrals = (await entriesOf(f.owner, referrer))
        .filter((row) => row.method === 'referral')
        .map((row) => row.source_edge_id);
      assert.deepEqual(
        referrals.sort(),
        (expected ? [tickedEdge, skippedEdge] : [tickedEdge]).sort(),
        JSON.stringify(setting),
      );
      assert.deepEqual(await entriesOf(f.owner, boxless), []);
      // The referred member's own entry still follows their own box.
      assert.deepEqual(await entriesOf(f.owner, skipped.id), []);

      // Reconciliation applies the same condition: it adds the referrer's
      // own base entry (they joined after the giveaway opened) and no
      // referral entry live accrual refused.
      await reconciliation(f, flags.service, { settings: setting }).run(1_000);
      assert.deepEqual(
        (await entriesOf(f.owner, referrer))
          .filter((row) => row.method === 'referral')
          .map((row) => row.source_edge_id)
          .sort(),
        (expected ? [tickedEdge, skippedEdge] : [tickedEdge]).sort(),
      );
      assert.deepEqual(await entriesOf(f.owner, skipped.id), []);
      assert.deepEqual(
        methods(await entriesOf(f.owner, boxless)),
        [],
        'a referrer without the box holds nothing',
      );
    } finally {
      await f.dispose();
    }
  }
});

test('reconciliation restores exactly the entries live accrual would have written, for both setting values', async () => {
  for (const setting of [settingNo, settingYes]) {
    const f = await ageFixture('e11-8-06-reconcile');
    try {
      // Verified and confirmed while giveaway.open was off: entitlements only.
      const flagsOff = f.flags();
      await flagsOff.set('waitlist.age_13', true, 'e11-8-06-test');
      const referrer = await insertMember(f.owner, { optIn: 'signup' });
      const ticked = await insertMember(f.owner, {
        admission: '13_plus',
        optIn: 'signup',
      });
      const skipped = await insertMember(f.owner, { admission: '13_plus' });
      const lateTick = await insertMember(f.owner, {
        admission: '13_plus',
        optIn: 'member_status',
        optInAt: laterTime,
      });
      const legacyMember = await insertMember(f.owner, {
        admission: '18_plus',
      });
      const tickedEdge = await insertEdge(
        f.owner,
        referrer,
        ticked,
        verifyTime,
      );
      const skippedEdge = await insertEdge(
        f.owner,
        referrer,
        skipped,
        verifyTime,
      );
      const lateEdge = await insertEdge(
        f.owner,
        referrer,
        lateTick,
        verifyTime,
      );

      await flagsOff.set('giveaway.open', true, 'e11-8-06-test');
      await reconciliation(f, flagsOff, { settings: setting }).run(1_000);
      assert.deepEqual(methods(await entriesOf(f.owner, ticked)), ['base']);
      assert.deepEqual(methods(await entriesOf(f.owner, lateTick)), ['base']);
      assert.deepEqual(await entriesOf(f.owner, skipped), []);
      // The flag is on: an 18+ member without the box holds nothing new.
      assert.deepEqual(await entriesOf(f.owner, legacyMember), []);
      const referrals = (await entriesOf(f.owner, referrer))
        .filter((row) => row.method === 'referral')
        .map((row) => row.source_edge_id)
        .sort();
      assert.deepEqual(
        referrals,
        (setting.referralEntryWithoutGiveawayBox
          ? [tickedEdge, skippedEdge, lateEdge]
          : [tickedEdge]
        ).sort(),
      );
    } finally {
      await f.dispose();
    }
  }
});

test('an opt-in from /me after confirmation grants the member their own entries, not their referrer an entry (decision 4), in live accrual and reconciliation', async () => {
  for (const setting of [settingNo, settingYes]) {
    const f = await ageFixture('e11-8-06-late-opt-in');
    try {
      const flags = await openGiveaway(f, true);
      const referrer = await insertMember(f.owner, { optIn: 'signup' });
      const referred = await pending(f.owner, { admission: '13_plus' });
      const edge = await insertEdge(f.owner, referrer, referred.id);
      const complete = verifier(f, flags.service, { settings: setting });
      assert.equal((await complete(referred.token)).outcome, 'verified');
      assert.deepEqual(await entriesOf(f.owner, referred.id), []);

      const status = await insertToken(f.owner, referred.id, 'status');
      assert.equal(
        await memberEntry(f, flags.service, setting).enter({
          challengeTimedOut: false,
          ipPrefixHash: 'prefix-late',
          token: status,
        }),
        'accepted',
      );
      assert.deepEqual(methods(await entriesOf(f.owner, referred.id)), [
        'base',
      ]);
      await reconciliation(f, flags.service, { settings: setting }).run(1_000);
      assert.deepEqual(
        (await entriesOf(f.owner, referrer))
          .filter((row) => row.method === 'referral')
          .map((row) => row.source_edge_id),
        setting.referralEntryWithoutGiveawayBox ? [edge] : [],
      );
    } finally {
      await f.dispose();
    }
  }
});

test('rollback keeps the box requirement of members admitted at 13, and restores legacy entry only where the published rules permit it (decision 2)', async () => {
  const f = await ageFixture('e11-8-06-rollback');
  try {
    const flags = await openGiveaway(f, true);
    // Admitted at 13, still pending when the flag is switched off.
    const skipped = await pending(f.owner, { admission: '13_plus' });
    const ticked = await pending(f.owner, {
      admission: '13_plus',
      optIn: 'signup',
    });
    await flags.age(false);

    // Verification after rollback: the 13+ member without the box holds no
    // entry; the one who ticked it holds their base entry.
    const complete = verifier(f, flags.service);
    assert.equal((await complete(skipped.token)).outcome, 'verified');
    assert.equal((await complete(ticked.token)).outcome, 'verified');
    assert.deepEqual(await entriesOf(f.owner, skipped.id), []);
    assert.deepEqual(methods(await entriesOf(f.owner, ticked.id)), ['base']);

    // A new 18+ join after rollback: legacy entry under rules that permit
    // it, nothing under rules that make the box the way to enter.
    const legacyJoin = await pending(f.owner, { admission: '18_plus' });
    const boxRuleJoin = await pending(f.owner, { admission: '18_plus' });
    assert.equal((await complete(legacyJoin.token)).outcome, 'verified');
    assert.equal(
      (await verifier(f, flags.service, { rules: boxRules })(boxRuleJoin.token))
        .outcome,
      'verified',
    );
    assert.deepEqual(methods(await entriesOf(f.owner, legacyJoin.id)), [
      'base',
    ]);
    assert.deepEqual(await entriesOf(f.owner, boxRuleJoin.id), []);

    // A referral by the 13+ member without the box earns their 18+ referrer
    // nothing, even under legacy rules; one by the member who ticked does.
    const referrer = await insertMember(f.owner, { admission: '18_plus' });
    const viaSkipped = await pending(f.owner, { admission: '13_plus' });
    const viaTicked = await pending(f.owner, {
      admission: '13_plus',
      optIn: 'signup',
    });
    await insertEdge(f.owner, referrer, viaSkipped.id);
    const tickedEdge = await insertEdge(f.owner, referrer, viaTicked.id);
    for (const member of [viaSkipped, viaTicked]) {
      assert.equal((await complete(member.token)).outcome, 'verified');
    }

    // Reconciliation for the skipped 13+ members, under both rule states:
    // first under rules that make the box the way to enter, which also
    // leave the boxless 18+ join without an entry, then under rules that
    // permit legacy entry, which give that 18+ join theirs and still give
    // the members admitted at 13 nothing.
    await reconciliation(f, flags.service, { rules: boxRules }).run(1_000);
    assert.deepEqual(await entriesOf(f.owner, skipped.id), []);
    assert.deepEqual(await entriesOf(f.owner, viaSkipped.id), []);
    assert.deepEqual(await entriesOf(f.owner, boxRuleJoin.id), []);
    await reconciliation(f, flags.service, { rules: legacyRules }).run(1_000);
    assert.deepEqual(await entriesOf(f.owner, skipped.id), []);
    assert.deepEqual(await entriesOf(f.owner, viaSkipped.id), []);
    assert.deepEqual(methods(await entriesOf(f.owner, boxRuleJoin.id)), [
      'base',
    ]);
    assert.deepEqual(
      (await entriesOf(f.owner, referrer)).map((row) => row.source_edge_id),
      [null, tickedEdge],
    );

    // While the flag is off, /me offers no box; once it is back on and
    // entries are open, the member who still needs it can enter.
    const statusToken = await insertToken(f.owner, skipped.id, 'status');
    const entry = memberEntry(f, flags.service);
    assert.deepEqual(await entry.view(skipped.id), {
      notEntered: true,
      offerBox: false,
    });
    assert.equal(
      await entry.enter({
        challengeTimedOut: false,
        ipPrefixHash: 'prefix-rollback',
        token: statusToken,
      }),
      'disabled',
    );
    assert.deepEqual(await entriesOf(f.owner, skipped.id), []);
    await flags.age(true);
    assert.deepEqual(await entry.view(skipped.id), {
      notEntered: true,
      offerBox: true,
    });
    assert.equal(
      await entry.enter({
        challengeTimedOut: false,
        ipPrefixHash: 'prefix-rollback',
        token: statusToken,
      }),
      'accepted',
    );
    assert.deepEqual(methods(await entriesOf(f.owner, skipped.id)), ['base']);
  } finally {
    await f.dispose();
  }
});

interface ApplicationPath {
  apply(email: string): Promise<void>;
  confirm(email: string): Promise<string>;
}

/** The partner application, submitted and confirmed through its services. */
function applicationPath(
  f: AgeFixture,
  flags: FlagService,
  options: {
    readonly rules?: CurrentGiveawayRules;
    readonly settings?: WaitlistAgeSettings;
  } = {},
): ApplicationPath {
  const clock = () => signupTime;
  const handler = createPartnerApplicationHandler({
    verifyTurnstile: async () => 'verified',
    isEnabled: async () => true,
    hashIpPrefix: (address) =>
      createHash('sha256').update(`prefix:${address}`).digest(),
    consumeIpRateLimit: (prefixHash, now, strict) =>
      consumeRateLimit(
        f.app,
        `partner:apply:ip:${strict ? 'strict:' : ''}${prefixHash}`,
        partnerApplicationIpWindowMs,
        now,
      ),
    checkCode: (requested) => createPartnerCodeRules(f.app).check(requested),
    submit: createPartnerSubmitService(f.app, {
      clock,
      agePolicy: async () =>
        (await flags.isEnabled('waitlist.age_13')) ? '13_plus' : '18_plus',
      screenEmailDomain: async () => ({ flags: [] }),
      raiseFraudFlag: async () => undefined,
      async flagChallengeTimeout(subscriberId) {
        await createFraudFlagRepository(f.app).insertChallengeTimeoutFlag({
          id: randomUUID(),
          subscriberId,
        });
      },
    }),
    clock,
    monotonicClock: () => 0,
    sleep: async () => undefined,
  });
  const confirm = createPartnerConfirmationService(f.app, {
    clock: () => verifyTime,
    isEnabled: async () => true,
    consumeIpRateLimit: (prefixHash, now) =>
      consumeRateLimit(
        f.app,
        `partner:confirm:ip:${prefixHash}`,
        partnerApplicationIpWindowMs,
        now,
      ),
    giveaway: {
      flags,
      currentRules: () => options.rules ?? legacyRules,
      settings: options.settings ?? settingNo,
    },
  });
  let applications = 0;
  return {
    async apply(email) {
      applications += 1;
      const form = new FormData();
      for (const [key, value] of Object.entries({
        turnstile_token: 'turnstile-ok',
        full_name: 'Maya Example',
        email_address: email,
        country_of_residence: 'SE',
        partner_type: 'creator',
        channels: 'tiktok',
        handles: '@maya',
        audience_size: '10k_50k',
        promotion_plan: 'Short videos comparing subscription prices.',
        requested_code: `MAYA${applications}`,
        age_confirmed: 'yes',
        programme_terms_agreed: 'yes',
      }))
        form.append(key, value);
      assert.equal(
        (await handler(form, `192.0.2.${applications}`)).kind,
        'accepted',
      );
    },
    async confirm(email) {
      const row = await f.owner.readOne<{ token: string; id: string }>({
        text: `SELECT p.confirmation_token_id AS token, s.id::text AS id
               FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
               WHERE s.email_normalised = $1`,
        values: [email],
      });
      assert.ok(row);
      const token = deriveEmailToken(
        row.token,
        process.env.EMAIL_TOKEN_SECRET!,
      );
      assert.deepEqual(await confirm(token, `prefix-${email}`), {
        kind: 'confirmed',
      });
      return row.id;
    },
  };
}

async function admissionOf(owner: DatabasePool, id: string) {
  return (
    await owner.readOne<{ admission_age_policy: string; status: string }>({
      text: 'SELECT admission_age_policy, status FROM subscriber WHERE id = $1',
      values: [id],
    })
  )?.admission_age_policy;
}

test('with the flag on, an application joins the waitlist with no automatic entry; a pending signup that ticked the box is honoured (decisions 1 and 6)', async () => {
  const f = await ageFixture('e11-8-06-application-on');
  try {
    const flags = await openGiveaway(f, true);
    const path = applicationPath(f, flags.service);

    // A new applicant: verified and joined, admitted under the 13+ policy,
    // and holding no entry until they tick the box on /me.
    await path.apply('new@example.test');
    const created = await path.confirm('new@example.test');
    assert.equal(await admissionOf(f.owner, created), '13_plus');
    assert.deepEqual(await entriesOf(f.owner, created), []);
    const entry = memberEntry(f, flags.service);
    assert.deepEqual(await entry.view(created), {
      notEntered: true,
      offerBox: true,
    });
    assert.equal(
      await entry.enter({
        challengeTimedOut: false,
        ipPrefixHash: 'prefix-new',
        token: await insertToken(f.owner, created, 'status'),
      }),
      'accepted',
    );
    assert.deepEqual(methods(await entriesOf(f.owner, created)), ['base']);

    // The same pending member, signed up with and without the box, then
    // verified by the application's confirmation.
    const referrer = await insertMember(f.owner, { optIn: 'signup' });
    const signup = createSignupService(f.app, {
      clock: () => signupTime,
      raiseFraudFlag: async () => undefined,
      screenEmailDomain: async () => ({ flags: [] }),
      sendVerificationMail: async () => undefined,
    });
    const outcomes: Record<string, string> = {};
    for (const [email, giveawayOptIn] of [
      ['ticked@example.test', true],
      ['skipped@example.test', false],
    ] as const) {
      const signed = await signup({
        email,
        agePolicy: '13_plus',
        giveawayOptIn,
        verificationUrl: (token) =>
          `https://valstara.test/verify?token=${token}`,
      });
      assert.equal(signed.kind, 'created');
      if (signed.kind !== 'created') continue;
      outcomes[email] = await insertEdge(
        f.owner,
        referrer,
        signed.subscriber.id,
      );
      await path.apply(email);
      assert.equal(await path.confirm(email), signed.subscriber.id);
    }
    const ticked = await f.owner.readOne<{ id: string }>({
      text: `SELECT id::text FROM subscriber WHERE email_normalised = 'ticked@example.test'`,
    });
    const skipped = await f.owner.readOne<{ id: string }>({
      text: `SELECT id::text FROM subscriber WHERE email_normalised = 'skipped@example.test'`,
    });
    assert.deepEqual(methods(await entriesOf(f.owner, ticked!.id)), ['base']);
    assert.deepEqual(await entriesOf(f.owner, skipped!.id), []);
    // Referrer eligibility under decision 4 and the setting at no.
    assert.deepEqual(
      (await entriesOf(f.owner, referrer)).map((row) => row.source_edge_id),
      [outcomes['ticked@example.test']],
    );
    // Reconciliation applies the same condition: the referrer's own base
    // entry, and no entry for the member who skipped the box or from them.
    await reconciliation(f, flags.service).run(1_000);
    assert.deepEqual(await entriesOf(f.owner, skipped!.id), []);
    assert.deepEqual(
      (await entriesOf(f.owner, referrer)).map((row) => row.source_edge_id),
      [null, outcomes['ticked@example.test']],
    );
  } finally {
    await f.dispose();
  }
});

test('off-flag applications follow published rules and applicants who still need the box can enter after re-enable (decision 8)', async () => {
  for (const rules of [legacyRules, boxRules]) {
    const f = await ageFixture('e11-8-06-application-off');
    try {
      const flags = await openGiveaway(f, false);
      const path = applicationPath(f, flags.service, { rules });
      await path.apply('applicant@example.test');
      const id = await path.confirm('applicant@example.test');
      assert.equal(await admissionOf(f.owner, id), '18_plus');
      const status = await f.owner.readOne<{ status: string }>({
        text: 'SELECT status FROM subscriber WHERE id = $1',
        values: [id],
      });
      assert.equal(status?.status, 'verified');
      const referred = await pending(f.owner, {
        admission: '18_plus',
        optIn: 'signup',
      });
      await insertEdge(f.owner, id, referred.id);
      assert.equal(
        (await verifier(f, flags.service, { rules })(referred.token)).outcome,
        'verified',
      );
      const permitted = rules.entryRequiresGiveawayBox !== true;
      assert.deepEqual(
        methods(await entriesOf(f.owner, id)),
        permitted ? ['base', 'referral'] : [],
      );
      // Make the live entries missing in this fixture so reconciliation has
      // to apply the same rule to both methods.
      await f.owner.execute({
        text: 'DELETE FROM giveaway_entry WHERE subscriber_id = $1',
        values: [id],
      });
      await reconciliation(f, flags.service, { rules }).run(1_000);
      assert.deepEqual(
        methods(await entriesOf(f.owner, id)),
        permitted ? ['base', 'referral'] : [],
      );
      // An applicant admitted at 13 who is confirmed after rollback holds
      // nothing, under either rules state.
      await flags.age(true);
      await path.apply('admitted13@example.test');
      await flags.age(false);
      const admitted13 = await path.confirm('admitted13@example.test');
      assert.equal(await admissionOf(f.owner, admitted13), '13_plus');
      await reconciliation(f, flags.service, { rules }).run(1_000);
      assert.deepEqual(await entriesOf(f.owner, admitted13), []);

      const entry = createGiveawayMemberEntryService(f.app, {
        flags: flags.service,
        currentRules: () => rules,
        clock: () => laterTime,
      });
      const applicantsWhoNeedTheBox = permitted
        ? [admitted13]
        : [admitted13, id];
      for (const applicant of applicantsWhoNeedTheBox) {
        assert.deepEqual(await entry.view(applicant), {
          notEntered: true,
          offerBox: false,
        });
      }
      await flags.age(true);
      for (const [index, applicant] of applicantsWhoNeedTheBox.entries()) {
        assert.deepEqual(await entry.view(applicant), {
          notEntered: true,
          offerBox: true,
        });
        const statusToken = await insertToken(f.owner, applicant, 'status');
        assert.equal(
          await entry.enter({
            challengeTimedOut: false,
            ipPrefixHash: `application-rollback-${index}`,
            token: statusToken,
          }),
          'accepted',
        );
        assert.deepEqual(
          methods(await entriesOf(f.owner, applicant)),
          applicant === id ? ['base', 'referral'] : ['base'],
        );
      }
    } finally {
      await f.dispose();
    }
  }
});

test('under real concurrency, no member holds an entry without the box, and no referral entry comes from a referred member without it', async () => {
  const f = await ageFixture('e11-8-06-concurrency');
  try {
    const flags = await openGiveaway(f, true);
    const tickedReferrer = await insertMember(f.owner, { optIn: 'signup' });
    const boxlessReferrer = await insertMember(f.owner);
    const members: { id: string; token: string }[] = [];
    // Twelve members cover every combination of admission policy, box and
    // referrer.
    for (let index = 0; index < 12; index += 1) {
      const member = await pending(f.owner, {
        admission: index % 3 === 0 ? '18_plus' : '13_plus',
        ...(index % 2 === 0 ? { optIn: 'signup' as const } : {}),
      });
      await insertEdge(
        f.owner,
        index % 4 < 2 ? tickedReferrer : boxlessReferrer,
        member.id,
      );
      members.push(member);
    }
    const complete = verifier(f, flags.service);
    const reconcile = reconciliation(f, flags.service);
    // Every verification twice at once, with a reconciliation run racing
    // them, four members at a time so each batch fits the app role's pool.
    // The flag cache is warmed first, as a running server's is.
    assert.equal(await flags.service.isEnabled('waitlist.age_13'), true);
    for (let start = 0; start < members.length; start += 4) {
      await Promise.all([
        ...members
          .slice(start, start + 4)
          .flatMap((member) => [
            complete(member.token),
            complete(member.token),
          ]),
        reconcile.run(1_000),
      ]);
    }
    await reconcile.run(1_000);

    const violations = await f.owner.list<{ id: string }>(
      {
        text: `SELECT ge.id::text FROM giveaway_entry ge
               JOIN subscriber s ON s.id = ge.subscriber_id
               LEFT JOIN referral_edge e ON e.id = ge.source_edge_id
               LEFT JOIN subscriber referred ON referred.id = e.referred_id
               WHERE s.giveaway_opt_in_at IS NULL
                  OR (ge.method = 'referral' AND referred.giveaway_opt_in_at IS NULL)`,
      },
      100,
    );
    assert.deepEqual(violations, []);
    // Each member who ticked holds exactly one base entry, and the referrer
    // who ticked holds exactly one entry per referred member who ticked.
    for (const [index, member] of members.entries()) {
      assert.deepEqual(
        methods(await entriesOf(f.owner, member.id)),
        index % 2 === 0 ? ['base'] : [],
      );
    }
    const expectedReferrals = members.filter(
      (_, index) => index % 2 === 0 && index % 4 < 2,
    ).length;
    const referrerRows = (await entriesOf(f.owner, tickedReferrer)).filter(
      (row) => row.method === 'referral',
    );
    assert.equal(referrerRows.length, expectedReferrals);
    assert.equal(
      new Set(referrerRows.map((row) => row.source_edge_id)).size,
      expectedReferrals,
    );
    assert.deepEqual(await entriesOf(f.owner, boxlessReferrer), []);
  } finally {
    await f.dispose();
  }
});
