import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { createPartnerShortLinkRoute } from '../src/pages/r/[code].ts';
import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import { createPartnerAttributionRepository } from '../src/server/db/partner-attribution.ts';
import type { DatabaseConnection } from '../src/server/db/pool.ts';
import { createReferralCouponRepository } from '../src/server/db/referral-coupon.ts';
import { createReferralRepository } from '../src/server/db/referral.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { exportSubject } from '../src/server/dsr/export.ts';
import { createFraudReviewService } from '../src/server/fraud/review.ts';
import { createPartnerActivationJob } from '../src/server/partner/activation.ts';
import { createPartnerReviewService } from '../src/server/partner/review.ts';
import { partnerShortLink } from '../src/server/partner/short-link.ts';
import { createReferralCaptureService } from '../src/server/referral/capture.ts';
import { earlyAccess } from '../src/server/referral/ladder-presentation.ts';
import { partnerWelcomeDiscount } from '../src/server/referral/partner-perks.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';
import { createVerificationMaintenanceScheduler } from '../src/server/subscriber/maintenance.ts';

import {
  createPartnerFixture,
  insertMember,
  insertPartner,
  partnerErasure,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const actor = 'founder:test';
const clock = () => new Date('2026-11-22T10:00:00.000Z');
const contract = {
  date: '2026-11-22',
  version: 'partner-v1',
  reference: 'signfree-123',
};
const historyDay = '2026-11-10';

interface Edge {
  id: string;
  partner_id: string | null;
  referrer_id: string | null;
  referred_id: string | null;
  attribution_method: string;
  signup_confirmed_count: number | null;
  welcome_discount_pct: number | null;
}

async function edge(f: PartnerFixture, friendId: string): Promise<Edge> {
  const found = await f.app.readOne<Edge>({
    text: 'SELECT * FROM referral_edge WHERE referred_id=$1',
    values: [friendId],
  });
  assert.ok(found);
  return found;
}

async function setFlag(f: PartnerFixture, enabled: boolean) {
  await createCampaignFlagRepository(f.app).set(
    'partners.enabled',
    enabled,
    actor,
  );
}

async function memberCode(f: PartnerFixture, id: string) {
  const result = await createReferralService(f.app).getReferralCode(id);
  assert.ok(result);
  return result;
}

async function verified(
  f: PartnerFixture,
  id: string,
  window = 'wave-2' as const,
) {
  await f.owner.execute({
    text: "UPDATE subscriber SET status='verified', verified_at=$2 WHERE id=$1",
    values: [id, clock()],
  });
  assert.equal(
    await createReferralCouponRepository(f.app).assignVerificationOrderWindow(
      id,
      window,
    ),
    1,
  );
  await createReferralService(f.app).generateCode(id);
}

async function createFriend(f: PartnerFixture, code: string, confirm = true) {
  const friend = await insertMember(f, { status: 'pending' });
  const referrals = createReferralService(f.app);
  assert.deepEqual(await referrals.attribute(friend.id, code), {
    kind: 'attributed',
  });
  if (confirm) {
    await verified(f, friend.id);
    assert.notEqual(await referrals.confirm(friend.id, clock()), null);
  }
  return friend.id;
}

async function startPartner(f: PartnerFixture) {
  const partner = await insertPartner(f, { status: 'applied' });
  const review = createPartnerReviewService(f.app, clock);
  const approved = await review.approve(partner.id, null, actor);
  assert.ok(approved.after.code);
  await review.contractSent(partner.id, actor);
  return { ...partner, code: approved.after.code };
}

async function seedCounts(
  f: PartnerFixture,
  referrerId: string,
  count: number,
  confirmedAt = new Date('2026-11-01T00:00:00Z'),
) {
  await f.owner.execute({
    text: `INSERT INTO referral_edge(id,referrer_id,state,reward_state,confirmed_at)
      SELECT gen_random_uuid(), $1, 'confirmed', 'settled', $2 FROM generate_series(1,$3)`,
    values: [referrerId, confirmedAt, count],
  });
}

test('welcome discount boundaries and ambassador floor', () => {
  for (const [count, creator, ambassador] of [
    [0, 10, 15],
    [20, 10, 15],
    [21, 15, 15],
    [38, 15, 15],
    [39, 20, 20],
    [54, 20, 20],
  ]) {
    assert.equal(partnerWelcomeDiscount(count!, 'creator'), creator);
    assert.equal(
      partnerWelcomeDiscount(count!, 'student_ambassador'),
      ambassador,
    );
  }
});

test('short links reach signed capture only for live partner codes; pause preserves past perks', async (t) => {
  const f = await createPartnerFixture('partner-attribution-short-link');
  t.after(() => f.dispose());
  const referrals = createReferralService(f.app);
  const review = createPartnerReviewService(f.app, clock);
  const partner = await startPartner(f);
  const personalCode = await memberCode(f, partner.subscriberId);
  const capture = createReferralCaptureService('referral-signing-test-key', {
    clock,
  });
  const route = createPartnerShortLinkRoute(f.app);
  async function destination(code: string) {
    const response = await route({ params: { code } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), '');
    return response.headers.get('location');
  }
  assert.equal(await destination('UNKNOWN1'), '/');
  assert.equal(await destination('https://other.test/'), '/');
  assert.equal(await destination(partner.code), '/');
  await createReferralCouponRepository(f.app).assignVerificationOrderWindow(
    partner.subscriberId,
    'wave-2',
  );
  await review.contractSigned(partner.id, contract, actor);
  const location = await destination(partner.code.toLowerCase());
  assert.equal(location, '/?ref=' + partner.code);
  const signed = capture.signRef(
    capture.capture(new URL(location!, 'https://valstara.com')),
  );
  const code = capture.verifyRef(signed)?.ref;
  assert.equal(code, partner.code);
  assert.equal(await referrals.lookupCode(partner.code), partner.subscriberId);
  assert.equal(
    earlyAccess(await referrals.status(partner.subscriberId)).reason,
    'active_partner',
  );

  const pending = await createFriend(f, code!, false);
  assert.equal((await edge(f, pending)).welcome_discount_pct, 10);
  const perks = createPartnerAttributionRepository(f.app);
  assert.equal((await perks.findPerks(pending))?.welcome_discount_pct, null);
  const friend = await createFriend(f, personalCode);
  assert.equal((await edge(f, friend)).partner_id, partner.id);
  assert.equal((await edge(f, friend)).attribution_method, 'link');
  assert.equal((await referrals.status(friend)).accessWindow, 'wave-1');
  assert.equal(
    earlyAccess(await referrals.status(friend)).reason,
    'partner_referral',
  );
  await setFlag(f, false);
  assert.equal(await destination(partner.code), '/');
  assert.equal(await referrals.lookupCode(partner.code), null);
  const disabled = await insertMember(f, { status: 'pending' });
  assert.deepEqual(await referrals.attribute(disabled.id, partner.code), {
    kind: 'unattributed',
  });
  assert.equal(
    await f.app.readOne({
      text: 'SELECT id FROM referral_edge WHERE referred_id=$1',
      values: [disabled.id],
    }),
    null,
  );
  const memberFallback = await createFriend(f, personalCode, false);
  assert.equal((await edge(f, memberFallback)).partner_id, null);
  assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, 10);

  await review.pause(partner.id, actor);
  assert.equal(
    (await referrals.status(partner.subscriberId)).accessWindow,
    'wave-2',
  );
  await setFlag(f, true);
  assert.equal(await destination(partner.code), '/');
  assert.equal(await referrals.lookupCode(partner.code), null);
  const plain = await createFriend(f, personalCode);
  assert.equal((await edge(f, plain)).partner_id, null);
  assert.equal((await edge(f, plain)).welcome_discount_pct, null);
  assert.equal((await edge(f, plain)).signup_confirmed_count, 1);
  assert.equal((await referrals.status(plain)).accessWindow, 'wave-2');
  assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, 10);
  assert.equal((await referrals.status(friend)).accessWindow, 'wave-1');

  await review.terminate(partner.id, actor);
  assert.equal(await destination(partner.code), '/');
  const afterTermination = await createFriend(f, personalCode);
  assert.equal((await edge(f, afterTermination)).partner_id, null);
  assert.equal((await edge(f, friend)).partner_id, partner.id);
});

test('a fixed discount survives later counts and partner type; a void removes only its edge-derived perks', async (t) => {
  const f = await createPartnerFixture('partner-attribution-fixed');
  t.after(() => f.dispose());
  const partner = await startPartner(f);
  const review = createPartnerReviewService(f.app, clock);
  await review.contractSigned(partner.id, contract, actor);
  await seedCounts(f, partner.subscriberId, 20);
  const friend = await createFriend(f, partner.code);
  assert.equal((await edge(f, friend)).welcome_discount_pct, 10);
  const nextFriend = await createFriend(f, partner.code, false);
  assert.equal((await edge(f, nextFriend)).welcome_discount_pct, 15);
  await seedCounts(f, partner.subscriberId, 18);
  const lastFriend = await createFriend(f, partner.code, false);
  assert.equal((await edge(f, lastFriend)).welcome_discount_pct, 20);
  await review.setType(partner.id, 'student_ambassador', 'Test College', actor);
  assert.equal((await edge(f, friend)).welcome_discount_pct, 10);
  await assert.rejects(
    f.app.execute({
      text: 'UPDATE referral_edge SET welcome_discount_pct=15 WHERE referred_id=$1',
      values: [friend],
    }),
    /fixed after assignment/u,
  );
  await assert.rejects(
    f.owner.execute({
      text: 'UPDATE referral_edge SET signup_confirmed_count=21 WHERE referred_id=$1',
      values: [friend],
    }),
    /immutable/u,
  );
  await assert.rejects(
    f.app.execute({
      text: `INSERT INTO referral_edge(id,referrer_id,state,reward_state,welcome_discount_pct)
      VALUES(gen_random_uuid(),$1,'confirmed','settled',10)`,
      values: [partner.subscriberId],
    }),
    { constraint: 'referral_edge_partner_discount_pair' },
  );

  const voids = createReferralVoidService(f.app, clock);
  const referrals = createReferralService(f.app);
  const perks = createPartnerAttributionRepository(f.app);
  await voids.voidReferral(friend, 'Test void', actor);
  assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, null);
  assert.equal((await referrals.status(friend)).accessWindow, 'wave-2');
  await voids.unvoidReferral(friend, 'Test undo', actor);
  assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, 10);
  assert.equal((await referrals.status(friend)).accessWindow, 'wave-1');
  await seedCounts(f, friend, 3);
  await voids.voidReferral(friend, 'Repeat void', actor);
  assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, null);
  assert.equal((await referrals.status(friend)).accessWindow, 'wave-1');
});

test('flag-off lifecycle commands are audited and only current, bounded catch-up effects apply', async (t) => {
  const f = await createPartnerFixture('partner-attribution-deferred');
  t.after(() => f.dispose());
  await setFlag(f, false);
  const review = createPartnerReviewService(f.app, clock);
  const job = createPartnerActivationJob(f.app, clock);
  const referrals = createReferralService(f.app);
  const partner = await startPartner(f);
  const paused = await insertPartner(f, { status: 'paused' });
  const staysPaused = await insertPartner(f, { status: 'paused' });
  const terminated = await insertPartner(f, { status: 'paused' });
  const erased = await insertPartner(f, { status: 'paused' });
  const personalCode = await memberCode(f, partner.subscriberId);
  for (const subject of [partner, paused, staysPaused, terminated, erased]) {
    await createReferralCouponRepository(f.app).assignVerificationOrderWindow(
      subject.subscriberId,
      'wave-2',
    );
  }
  const friend = await createFriend(f, personalCode);
  // This friend signed up before approval, captured zero even while disabled.
  assert.equal((await edge(f, friend)).signup_confirmed_count, 0);
  const signed = await review.contractSigned(partner.id, contract, actor);
  assert.equal(signed.after.status, 'active');
  assert.equal(signed.after.contract_signed_at, contract.date);
  assert.equal(signed.after.contract_version, contract.version);
  assert.equal(signed.after.code_active, false);
  assert.equal(
    (
      await f.app.readOne<{ contract_reference: string }>({
        text: 'SELECT contract_reference FROM partner WHERE id=$1',
        values: [partner.id],
      })
    )?.contract_reference,
    contract.reference,
  );
  for (const subject of [paused, staysPaused, terminated, erased]) {
    const reactivated = await review.reactivate(subject.id, actor);
    assert.equal(reactivated.after.status, 'active');
    assert.equal(reactivated.after.code_active, false);
  }
  for (const [subject, action] of [
    [partner, 'partner.contract_signed'],
    [paused, 'partner.reactivated'],
  ] as const) {
    assert.deepEqual(
      await f.app.readOne({
        text: `SELECT actor, detail #>> '{after,status}' AS status,
        detail #>> '{after,code_active}' AS code_active
        FROM audit_log WHERE subject_id=$1 AND action=$2`,
        values: [subject.id, action],
      }),
      { actor, status: 'active', code_active: 'false' },
    );
  }

  await review.pause(staysPaused.id, actor);
  await review.terminate(terminated.id, actor);
  const dsr = partnerErasure(f, async () => {});
  await (
    await dsr.signedConfirmation(erased.subscriberId)
  )();
  await dsr.fulfil();
  const late = await insertMember(f, {
    status: 'pending',
    at: new Date('2026-11-23'),
  });
  assert.deepEqual(await referrals.attribute(late.id, personalCode), {
    kind: 'attributed',
  });
  await verified(f, late.id);
  await referrals.confirm(late.id, clock());
  assert.equal((await edge(f, late.id)).partner_id, null);
  assert.equal(await job.run(100), 0);
  assert.equal(
    (await referrals.status(partner.subscriberId)).accessWindow,
    'wave-2',
  );
  assert.equal((await edge(f, friend)).partner_id, null);

  await seedCounts(f, partner.subscriberId, 39, new Date('2026-10-01'));
  await setFlag(f, true);
  assert.equal(await job.run(1), 1);
  const codes = [partner.code, paused.code!];
  const initial = await Promise.all(
    codes.map(async (code) =>
      (await partnerShortLink(f.app, code)).headers.get('location'),
    ),
  );
  assert.equal(initial.filter((path) => path !== '/').length, 1);
  assert.equal(await job.run(1), 1);
  const noop = { run: async () => {} };
  const scheduler = createVerificationMaintenanceScheduler(
    {
      expiry: noop,
      ipPrefixRetention: noop,
      partnerActivation: job,
      rateLimitRetention: noop,
      referralCounterRepair: noop,
      reminder: noop,
      strandedReferral: noop,
      verificationRate: noop,
      verificationTokenRetention: noop,
    },
    { clock },
  );
  await scheduler.runCycle();
  assert.equal(await job.run(1), 0);
  for (const subject of [partner, paused]) {
    assert.equal(
      (await partnerShortLink(f.app, subject.code!)).headers.get('location'),
      '/?ref=' + subject.code,
    );
    assert.equal(
      (await referrals.status(subject.subscriberId)).accessWindow,
      'wave-1',
    );
  }
  for (const subject of [staysPaused, terminated, erased]) {
    assert.equal(
      (await partnerShortLink(f.app, subject.code!)).headers.get('location'),
      '/',
    );
  }
  const after = await edge(f, friend);
  assert.equal(after.attribution_method, 'retroactive');
  assert.equal(after.partner_id, partner.id);
  assert.equal(
    after.welcome_discount_pct,
    10,
    'zero snapshot beats the much higher historic count',
  );
  assert.equal((await referrals.status(friend)).accessWindow, 'wave-1');
  assert.equal((await edge(f, late.id)).partner_id, null);
  await assert.rejects(job.run(101), RangeError);
});

test('legacy catch-up uses strict confirmation times and inclusive recorded void intervals', async (t) => {
  const f = await createPartnerFixture('partner-attribution-legacy-history');
  t.after(() => f.dispose());
  const partner = await startPartner(f);
  const review = createPartnerReviewService(f.app, clock);
  await seedCounts(f, partner.subscriberId, 20);
  const special = randomUUID();
  const at = (time: string) => new Date(historyDay + 'T' + time + 'Z');
  await f.owner.execute({
    text: `INSERT INTO referral_edge(id,referrer_id,state,reward_state,confirmed_at,voided_at,void_reason,voided_by)
      VALUES($1,$2,'confirmed','settled',$3,$4,'Open test void',$5)`,
    values: [
      special,
      partner.subscriberId,
      at('09:00:00'),
      at('13:00:00'),
      actor,
    ],
  });
  async function record(
    action: 'voided' | 'unvoided',
    start: string,
    auditTime: string,
  ) {
    await f.owner.execute({
      text: `INSERT INTO audit_log(id,actor,action,subject_type,subject_id,detail,at)
        VALUES(gen_random_uuid(),$1,$2,'referral_edge',$3,$4,$5)`,
      values: [
        actor,
        'referral.' + action,
        special,
        {
          [action === 'voided' ? 'after' : 'before']: {
            voided_at: at(start).toISOString(),
          },
        },
        at(auditTime),
      ],
    });
  }
  await record('voided', '10:00:00', '10:00:00');
  await record('unvoided', '10:00:00', '11:00:00');
  await record('voided', '12:00:00', '12:00:00');
  await record('unvoided', '12:00:00', '11:59:00');
  await record('voided', '13:00:00', '13:00:00');
  const expected = [
    ['09:00:00', 10],
    ['09:00:01', 15],
    ['10:00:00', 10],
    ['10:30:00', 10],
    ['11:00:00', 10],
    ['11:00:01', 15],
    ['12:00:00', 10],
    ['12:00:01', 15],
    ['13:00:00', 10],
    ['14:00:00', 10],
  ] as const;
  const targets: { id: string; discount: number }[] = [];
  for (const [time, discount] of expected) {
    const friend = await insertMember(f, { at: at(time) });
    await createReferralCouponRepository(f.app).assignVerificationOrderWindow(
      friend.id,
      'wave-2',
    );
    await f.owner.execute({
      text: `INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state,confirmed_at)
        VALUES(gen_random_uuid(),$1,$2,'confirmed','settled',$3)`,
      values: [partner.subscriberId, friend.id, new Date('2026-11-11')],
    });
    targets.push({ id: friend.id, discount });
  }
  await review.contractSigned(partner.id, contract, actor);
  const job = createPartnerActivationJob(f.app, clock);
  assert.equal(await job.run(3), 3);
  assert.equal(await job.run(100), targets.length - 3);
  const snapshot = await Promise.all(
    targets.map(async ({ id, discount }) => {
      const actual = await edge(f, id);
      assert.equal(actual.welcome_discount_pct, discount);
      assert.equal(actual.attribution_method, 'retroactive');
      assert.equal(actual.signup_confirmed_count, null);
      return actual;
    }),
  );
  assert.equal(await job.run(100), 0);
  assert.deepEqual(
    await Promise.all(targets.map(({ id }) => edge(f, id))),
    snapshot,
  );
});

test('a real concurrent confirmation and signup snapshot agree on both sides of the serial order', async (t) => {
  const f = await createPartnerFixture('partner-attribution-concurrency');
  t.after(() => f.dispose());
  const partner = await startPartner(f);
  await createPartnerReviewService(f.app, clock).contractSigned(
    partner.id,
    contract,
    actor,
  );
  await seedCounts(f, partner.subscriberId, 20);

  async function serialOrder(confirmationFirst: boolean, expected: number) {
    const counted = await createFriend(f, partner.code, false);
    await verified(f, counted);
    const target = await insertMember(f, { status: 'pending' });
    const confirm = (db: DatabaseConnection) =>
      createReferralService(db).confirm(counted, clock());
    const attribute = (db: DatabaseConnection) =>
      createReferralService(db).attribute(target.id, partner.code);
    const [first, second] = confirmationFirst
      ? [confirm, attribute]
      : [attribute, confirm];
    const waiter = await f.app.connect();
    try {
      const backend = await waiter.readOne<{ pid: number }>({
        text: 'SELECT pg_backend_pid() AS pid',
      });
      assert.ok(backend);
      await waiter.execute({ text: 'BEGIN' });
      let pending: Promise<unknown> | undefined;
      try {
        await withTransaction(f.app, async (blocker) => {
          await first(blocker);
          pending = second(waiter);
          // Attach a handler immediately, then await the result after commit.
          void pending.catch(() => {});
          let waiting = false;
          for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
            waiting =
              (
                await f.owner.readOne<{ blocked: boolean }>({
                  text: 'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
                  values: [backend.pid],
                })
              )?.blocked ?? false;
            if (!waiting) await setTimeout(10);
          }
          assert.ok(
            waiting,
            'the second operation must wait on the first transaction',
          );
        });
      } finally {
        await pending;
      }
      await waiter.execute({ text: 'COMMIT' });
    } catch (error) {
      await waiter.execute({ text: 'ROLLBACK' });
      throw error;
    } finally {
      waiter.release();
    }
    const actual = await edge(f, target.id);
    assert.equal(actual.signup_confirmed_count, expected);
    assert.equal(actual.welcome_discount_pct, expected >= 21 ? 15 : 10);
    await createReferralVoidService(f.app, clock).voidReferral(
      counted,
      'Reset count',
      actor,
    );
  }

  await serialOrder(true, 21);
  await serialOrder(false, 20);
});

test('partner erasure preserves only a surviving verified friend’s earned entitlement and replay is safe', async (t) => {
  const f = await createPartnerFixture('partner-attribution-erasure');
  t.after(() => f.dispose());
  const partner = await startPartner(f);
  await createPartnerReviewService(f.app, clock).contractSigned(
    partner.id,
    contract,
    actor,
  );
  const friend = await createFriend(f, partner.code);
  const voided = await createFriend(f, partner.code);
  const pending = await createFriend(f, partner.code, false);
  const referrals = createReferralService(f.app);
  const perks = createPartnerAttributionRepository(f.app);
  await createReferralVoidService(f.app, clock).voidReferral(
    voided,
    'Not eligible',
    actor,
  );
  const edges = await Promise.all(
    [friend, voided, pending].map((id) => edge(f, id)),
  );
  const before = (await Array.fromAsync(exportSubject(f.app, friend))).join('');
  assert.equal(before.includes(partner.id), false);
  const linked = before
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((row) => row.table === 'referral_edge').data;
  assert.equal(linked.partner_id, null);
  assert.equal(linked.signup_confirmed_count, null);
  assert.equal(linked.welcome_discount_pct, 10);

  const deletions: string[] = [];
  const dsr = partnerErasure(f, async (email) => {
    deletions.push(email);
  });
  const erasePartner = await dsr.signedConfirmation(partner.subscriberId);
  await erasePartner();
  await dsr.fulfil();
  await erasePartner();
  await dsr.fulfil();
  assert.deepEqual(deletions, [partner.email]);
  for (const row of edges) {
    assert.deepEqual(
      await f.app.readOne({
        text: 'SELECT referrer_id,referred_id,partner_id,welcome_discount_pct FROM referral_edge WHERE id=$1',
        values: [row.id],
      }),
      {
        referrer_id: null,
        referred_id: null,
        partner_id: null,
        welcome_discount_pct: null,
      },
    );
  }
  await referrals.recomputeCounters(100);
  assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, 10);
  assert.equal((await referrals.status(friend)).accessWindow, 'wave-1');
  assert.equal((await perks.findPerks(voided))?.welcome_discount_pct, null);
  assert.equal((await referrals.status(voided)).accessWindow, 'wave-2');
  assert.equal((await perks.findPerks(pending))?.welcome_discount_pct, null);
  const exported = (await Array.fromAsync(exportSubject(f.app, friend))).join(
    '',
  );
  assert.equal(exported.includes(partner.id), false);
  assert.equal(exported.includes(partner.code), false);
  assert.equal(exported.includes(edges[0]!.id), false);
  const entitlement = exported
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.table === 'retained_partner_entitlement');
  assert.deepEqual(entitlement, [
    {
      table: 'retained_partner_entitlement',
      data: { subscriber_id: friend, wave_one: true, welcome_discount_pct: 10 },
    },
  ]);
  await (
    await dsr.signedConfirmation(friend)
  )();
  await dsr.fulfil();
  assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, null);
  assert.equal(
    await f.app
      .readOne({
        text: 'SELECT count(*)::int AS count FROM retained_partner_entitlement',
      })
      .then((row) => row?.count),
    0,
  );
});

test('a disqualified partner’s verified friend keeps earned perks through recomputation and erasure', async (t) => {
  const f = await createPartnerFixture('partner-attribution-disqualification');
  t.after(() => f.dispose());
  const partner = await startPartner(f);
  await createPartnerReviewService(f.app, clock).contractSigned(
    partner.id,
    contract,
    actor,
  );
  const friend = await createFriend(f, partner.code);
  const voided = await createFriend(f, partner.code);
  const pending = await createFriend(f, partner.code, false);
  const referrals = createReferralService(f.app);
  const perks = createPartnerAttributionRepository(f.app);
  await createReferralVoidService(f.app, clock).voidReferral(
    voided,
    'Not eligible',
    actor,
  );
  const flagId = randomUUID();
  await f.owner.execute({
    text: `INSERT INTO fraud_flag (id, subscriber_id, kind, detail, state, created_at)
      VALUES ($1, $2, 'duplicate_identity', '{}', 'open', $3)`,
    values: [flagId, partner.subscriberId, clock()],
  });
  await createFraudReviewService(f.app).review(flagId, 'upheld', actor);
  const linked = await f.app.readOne<{ id: string }>({
    text: `SELECT id FROM referral_edge WHERE referred_id=$1 AND state='rejected'
      AND rejected_reason='referrer_disqualified' AND state_before_rejection='confirmed'
      AND voided_at IS NULL`,
    values: [friend],
  });
  assert.ok(linked);
  assert.equal(
    await createReferralRepository(f.app).countConfirmedEdges(
      partner.subscriberId,
    ),
    0,
  );
  assert.equal(
    (await perks.findPerks(partner.subscriberId))?.active_partner,
    false,
  );

  async function assertFriendPerks() {
    await referrals.recomputeCounters(100);
    assert.equal((await perks.findPerks(friend))?.welcome_discount_pct, 10);
    assert.equal((await referrals.status(friend)).accessWindow, 'wave-1');
    assert.equal((await perks.findPerks(voided))?.welcome_discount_pct, null);
    assert.equal((await referrals.status(voided)).accessWindow, 'wave-2');
    assert.equal((await perks.findPerks(pending))?.welcome_discount_pct, null);
  }
  await assertFriendPerks();

  const dsr = partnerErasure(f, async () => {});
  await (
    await dsr.signedConfirmation(partner.subscriberId)
  )();
  await dsr.fulfil();
  assert.deepEqual(
    await f.app.readOne({
      text: 'SELECT referrer_id,referred_id,partner_id,welcome_discount_pct FROM referral_edge WHERE id=$1',
      values: [linked.id],
    }),
    {
      referrer_id: null,
      referred_id: null,
      partner_id: null,
      welcome_discount_pct: null,
    },
  );
  await assertFriendPerks();
});
