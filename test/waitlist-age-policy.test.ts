import assert from 'node:assert/strict';
import test from 'node:test';

import {
  holdsOwnEntriesSql,
  referralEarnsEntrySql,
} from '../src/server/db/giveaway-entry.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { runFlagCommand } from '../src/server/flags/cli.ts';
import { campaignFlagRegistry } from '../src/server/flags/registry.ts';
import {
  agePolicyFor,
  giveawayBoxPolicy,
  holdsOwnEntries,
  needsGiveawayBox,
  referralEarnsEntry,
  validateWaitlistAgeSettings,
  waitlistAgeSettings,
  type GiveawayBoxFacts,
  type GiveawayBoxPolicy,
} from '../src/server/giveaway/age-policy.ts';
import { partnerMembershipLine } from '../src/server/partner/page-presentation.ts';
import { partnersCopy } from '../src/copy/partners.ts';

import {
  ageFixture,
  insertEdge,
  insertMember,
  laterTime,
  signupTime,
  verifyTime,
} from './helpers/waitlist-age-fixture.ts';

// E11.8-06: the server settings, the box rule, the enable-command refusal
// and the subscriber columns' constraints.

test('the flag is registered off, and the shipped settings are both false', () => {
  assert.equal(campaignFlagRegistry['waitlist.age_13'], false);
  assert.deepEqual(waitlistAgeSettings, {
    reviewedWordingInPlace: false,
    referralEntryWithoutGiveawayBox: false,
  });
  assert.ok(Object.isFrozen(waitlistAgeSettings));
  assert.equal(agePolicyFor(false), '18_plus');
  assert.equal(agePolicyFor(true), '13_plus');
});

test('the settings validator refuses anything but the two booleans', () => {
  assert.deepEqual(
    validateWaitlistAgeSettings({
      reviewedWordingInPlace: true,
      referralEntryWithoutGiveawayBox: true,
    }),
    { reviewedWordingInPlace: true, referralEntryWithoutGiveawayBox: true },
  );
  for (const value of [
    null,
    [],
    'no',
    {},
    { reviewedWordingInPlace: false },
    { referralEntryWithoutGiveawayBox: false },
    { reviewedWordingInPlace: 'false', referralEntryWithoutGiveawayBox: false },
    { reviewedWordingInPlace: false, referralEntryWithoutGiveawayBox: 0 },
    {
      reviewedWordingInPlace: false,
      referralEntryWithoutGiveawayBox: false,
      extra: false,
    },
  ]) {
    assert.throws(
      () => validateWaitlistAgeSettings(value),
      TypeError,
      JSON.stringify(value),
    );
  }
});

const legacy: GiveawayBoxPolicy = {
  boxRequiredForEveryone: false,
  referralEntryWithoutGiveawayBox: false,
};
const everyone: GiveawayBoxPolicy = {
  boxRequiredForEveryone: true,
  referralEntryWithoutGiveawayBox: false,
};
const member = (
  admissionAgePolicy: GiveawayBoxFacts['admissionAgePolicy'],
  source: GiveawayBoxFacts['giveawayOptInSource'] = null,
  at: Date | null = source === null ? null : signupTime,
): GiveawayBoxFacts => ({
  admissionAgePolicy,
  giveawayOptInAt: at,
  giveawayOptInSource: source,
});

test('the box policy follows the flag and the published rules', async () => {
  const flags = (on: boolean) => ({
    isEnabled: async (key: string) => key === 'waitlist.age_13' && on,
  });
  assert.deepEqual(await giveawayBoxPolicy(flags(false), {}), legacy);
  assert.deepEqual(await giveawayBoxPolicy(flags(true), {}), everyone);
  assert.deepEqual(
    await giveawayBoxPolicy(flags(false), { entryRequiresGiveawayBox: true }),
    everyone,
  );
  assert.deepEqual(
    await giveawayBoxPolicy(
      flags(false),
      {},
      {
        reviewedWordingInPlace: false,
        referralEntryWithoutGiveawayBox: true,
      },
    ),
    { ...legacy, referralEntryWithoutGiveawayBox: true },
  );
});

test('a member admitted at 13 always needs the box; one admitted at 18 only while everyone does', () => {
  assert.equal(needsGiveawayBox(member('13_plus'), legacy), true);
  assert.equal(needsGiveawayBox(member('18_plus'), legacy), false);
  assert.equal(needsGiveawayBox(member('18_plus'), everyone), true);
  // An unknown admission fails safe.
  assert.equal(needsGiveawayBox(member(null), legacy), true);
  assert.equal(holdsOwnEntries(member('13_plus'), legacy), false);
  assert.equal(holdsOwnEntries(member('13_plus', 'signup'), legacy), true);
  assert.equal(holdsOwnEntries(member('18_plus'), everyone), false);
  assert.equal(
    holdsOwnEntries(member('18_plus', 'member_status'), everyone),
    true,
  );
});

test('a referral earns its referrer an entry only if the referred member had opted in by confirmation, unless the setting says yes', () => {
  const confirmed = verifyTime;
  // Ticked at signup: opted in before the confirmation.
  assert.equal(
    referralEarnsEntry(member('13_plus', 'signup'), confirmed, everyone),
    true,
  );
  // Ticked on /me after the confirmation: not for the referrer (D-082 Q2).
  assert.equal(
    referralEarnsEntry(
      member('13_plus', 'member_status', laterTime),
      confirmed,
      everyone,
    ),
    false,
  );
  // Ticked on /me before a later confirmation.
  assert.equal(
    referralEarnsEntry(
      member('18_plus', 'member_status', signupTime),
      confirmed,
      everyone,
    ),
    true,
  );
  assert.equal(
    referralEarnsEntry(member('13_plus'), confirmed, everyone),
    false,
  );
  // The legacy flow: an 18+ member under rules that permit it.
  assert.equal(referralEarnsEntry(member('18_plus'), confirmed, legacy), true);
  // The setting at yes: the referred member's box does not matter.
  for (const referred of [
    member('13_plus'),
    member('13_plus', 'member_status', laterTime),
  ]) {
    assert.equal(
      referralEarnsEntry(referred, confirmed, {
        ...everyone,
        referralEntryWithoutGiveawayBox: true,
      }),
      true,
    );
  }
});

test('the application line follows the age flag and the published rules (D-050, decisions 1 and 8)', () => {
  const membership = partnersCopy.apply.membership;
  const line = (
    ageThirteen: boolean,
    giveawayOpen: boolean,
    rulesRequireBox: boolean,
  ) => partnerMembershipLine({ ageThirteen, giveawayOpen, rulesRequireBox });
  // Flag off, rules that permit entry by verification: D-050 unchanged.
  assert.deepEqual(line(false, true, false), {
    line: membership.waitlistAndGiveaway,
    ageStatement: true,
    giveawayDisclosure: true,
  });
  assert.deepEqual(line(false, false, false), {
    line: membership.waitlist,
    ageStatement: true,
    giveawayDisclosure: false,
  });
  // Flag off, rules that make the box the way to enter: waitlist only.
  assert.deepEqual(line(false, true, true), line(false, false, false));
  // Flag on: join the waitlist, enter from /me, the giveaway is 18+.
  for (const rulesRequireBox of [false, true]) {
    assert.deepEqual(line(true, true, rulesRequireBox), {
      line: membership.waitlistThenGiveaway,
      ageStatement: false,
      giveawayDisclosure: true,
    });
    assert.deepEqual(line(true, false, rulesRequireBox), {
      line: membership.waitlist,
      ageStatement: false,
      giveawayDisclosure: false,
    });
  }
  assert.match(membership.waitlistThenGiveaway, /18 and over/u);
  assert.match(membership.waitlistThenGiveaway, /status page/u);
  assert.doesNotMatch(membership.waitlistThenGiveaway, /enters you/u);
});

test('live accrual and reconciliation apply the same box rule, for every combination', async () => {
  const f = await ageFixture('e11-8-06-equivalence');
  try {
    const admissions = ['18_plus', '13_plus'] as const;
    const optIns = [
      [null, null],
      ['signup', signupTime],
      ['member_status', signupTime],
      ['member_status', laterTime],
    ] as const;
    const policies: GiveawayBoxPolicy[] = [
      legacy,
      everyone,
      { boxRequiredForEveryone: false, referralEntryWithoutGiveawayBox: true },
      { boxRequiredForEveryone: true, referralEntryWithoutGiveawayBox: true },
    ];
    let checked = 0;
    for (const admission of admissions) {
      for (const [source, at] of optIns) {
        const referrer = await insertMember(f.owner);
        const id = await insertMember(f.owner, {
          admission,
          ...(source === null ? {} : { optIn: source, optInAt: at }),
          verifiedAt: verifyTime,
        });
        await insertEdge(f.owner, referrer, id, verifyTime);
        const facts = member(admission, source, at);
        for (const policy of policies) {
          const row = await f.owner.readOne<{
            own: boolean;
            referral: boolean;
          }>({
            text: `SELECT ${holdsOwnEntriesSql('s', '$2::boolean')} AS own,
                            ${referralEarnsEntrySql('s', 'e', '$2::boolean', '$3::boolean')} AS referral
                     FROM subscriber s JOIN referral_edge e ON e.referred_id = s.id
                     WHERE s.id = $1`,
            values: [
              id,
              policy.boxRequiredForEveryone,
              policy.referralEntryWithoutGiveawayBox,
            ],
          });
          const label = JSON.stringify({ admission, source, at, policy });
          assert.equal(row?.own, holdsOwnEntries(facts, policy), label);
          assert.equal(
            row?.referral,
            referralEarnsEntry(facts, verifyTime, policy),
            label,
          );
          checked += 1;
        }
      }
    }
    assert.equal(checked, 32);
  } finally {
    await f.dispose();
  }
});

test('the enable command refuses waitlist.age_13 while the reviewed-wording setting is false, and audits the refusal', async () => {
  const f = await ageFixture('e11-8-06-enable');
  try {
    const shipped = f.flags(waitlistAgeSettings);
    const lines: string[] = [];
    await assert.rejects(
      runFlagCommand(
        ['set', 'waitlist.age_13', 'on', '--actor', 'founder'],
        shipped,
        { write: (line) => lines.push(line) },
      ),
      /waitlist_age_13_requires_reviewed_wording/u,
    );
    assert.equal(lines.length, 0);
    assert.equal(await shipped.isEnabled('waitlist.age_13'), false);
    const stored = await f.owner.readOne<{ count: string }>({
      text: `SELECT count(*)::text FROM campaign_flag WHERE key = 'waitlist.age_13'`,
    });
    assert.equal(stored?.count, '0');
    const audits = await f.owner.list<{
      action: string;
      actor: string;
      detail: unknown;
    }>(
      {
        text: `SELECT action, actor, detail FROM audit_log
               WHERE subject_id = 'waitlist.age_13' ORDER BY at`,
      },
      10,
    );
    assert.deepEqual(audits, [
      {
        action: 'flag.enable_refused',
        actor: 'founder',
        detail: { reason: 'reviewed_wording_not_in_place' },
      },
    ]);
    // Switching it off is never refused.
    await runFlagCommand(
      ['set', 'waitlist.age_13', 'off', '--actor', 'founder'],
      shipped,
      { write: (line) => lines.push(line) },
    );
    assert.equal(await shipped.isEnabled('waitlist.age_13'), false);

    // With the setting true (E11.8-07), the same command switches it on.
    const reviewed = f.flags({
      reviewedWordingInPlace: true,
      referralEntryWithoutGiveawayBox: false,
    });
    await runFlagCommand(
      ['set', 'waitlist.age_13', 'on', '--actor', 'founder'],
      reviewed,
      { write: (line) => lines.push(line) },
    );
    assert.equal(await reviewed.isEnabled('waitlist.age_13'), true);
    assert.match(lines.at(-1) ?? '', /waitlist\.age_13 is now on/u);
  } finally {
    await f.dispose();
  }
});

test('the database rejects a tick without a signup, rewrites of the box or the admission policy, and clears both on erasure', async () => {
  const f = await ageFixture('e11-8-06-constraints');
  try {
    const id = await insertMember(f.owner, { status: 'pending' });
    const row = async () =>
      f.owner.readOne<{
        admission_age_policy: string | null;
        giveaway_opt_in_at: Date | null;
        giveaway_opt_in_source: string | null;
      }>({
        text: `SELECT admission_age_policy, giveaway_opt_in_at, giveaway_opt_in_source
               FROM subscriber WHERE id = $1`,
        values: [id],
      });
    // A tick before the signup, a time without its source, an unknown
    // source, and a /me tick on a member who never verified.
    for (const [at, source] of [
      [new Date('2026-10-01T00:00:00.000Z'), 'signup'],
      [signupTime, null],
      [signupTime, 'elsewhere'],
      [signupTime, 'member_status'],
    ] as const) {
      await assert.rejects(
        f.app.execute({
          text: `UPDATE subscriber SET giveaway_opt_in_at = $2,
                   giveaway_opt_in_source = $3 WHERE id = $1`,
          values: [id, at, source],
        }),
        JSON.stringify([at, source]),
      );
    }
    await assert.rejects(
      f.owner.execute({
        text: `UPDATE subscriber SET admission_age_policy = 'unknown' WHERE id = $1`,
        values: [id],
      }),
    );
    // The application role cannot rewrite the admission policy at all.
    await assert.rejects(
      f.app.execute({
        text: `UPDATE subscriber SET admission_age_policy = '13_plus' WHERE id = $1`,
        values: [id],
      }),
      /permission denied/u,
    );
    await f.app.execute({
      text: `UPDATE subscriber SET giveaway_opt_in_at = $2,
               giveaway_opt_in_source = 'signup' WHERE id = $1`,
      values: [id, signupTime],
    });
    assert.equal((await row())?.giveaway_opt_in_source, 'signup');
    // Written once: never moved, re-sourced or cleared while the row lives.
    for (const [at, source] of [
      [laterTime, 'signup'],
      [signupTime, 'member_status'],
      [null, null],
    ] as const) {
      await assert.rejects(
        f.owner.execute({
          text: `UPDATE subscriber SET giveaway_opt_in_at = $2,
                   giveaway_opt_in_source = $3 WHERE id = $1`,
          values: [id, at, source],
        }),
        /write-once/u,
      );
    }
    await assert.rejects(
      f.owner.execute({
        text: `UPDATE subscriber SET admission_age_policy = '13_plus' WHERE id = $1`,
        values: [id],
      }),
      /write-once/u,
    );
    // Erasure clears all three through the existing identity erasure, in
    // the order the erasure job runs it.
    await withTransaction(f.owner, async (connection) => {
      await connection.execute({
        text: `INSERT INTO dsr_erasure (subscriber_id, requested_at, next_attempt_at)
               VALUES ($1, now(), now())`,
        values: [id],
      });
      await connection.execute({
        text: `UPDATE subscriber SET status = 'erasure_pending' WHERE id = $1`,
        values: [id],
      });
      await connection.readOne({
        text: 'SELECT erase_subscriber_identity($1)',
        values: [id],
      });
      await connection.execute({
        text: `INSERT INTO erasure_ledger (subscriber_id, erased_at)
               VALUES ($1, now())`,
        values: [id],
      });
      await connection.execute({
        text: `UPDATE dsr_erasure SET completed_at = now() WHERE subscriber_id = $1`,
        values: [id],
      });
    });
    assert.deepEqual(await row(), {
      admission_age_policy: null,
      giveaway_opt_in_at: null,
      giveaway_opt_in_source: null,
    });
  } finally {
    await f.dispose();
  }
});
