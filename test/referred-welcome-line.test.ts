// E11.8-04: the referral reminder in the welcome email. Three members join
// through real attribution and real verification against a real database: one
// through another member's link, one through a partner's code and one
// directly. The welcome email of the member-referred member alone carries the
// "a friend invited you" line, in both parts, directly before their own link;
// the partner-referred member keeps only the partner line; the direct member
// gets neither; no part of any email carries the referrer; and with
// `email.referred_welcome_line` off the email is exactly as before.
import assert from 'node:assert/strict';
import test from 'node:test';

import { emailCopy } from '../src/copy/email.ts';
import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import { createPartnerAttributionRepository } from '../src/server/db/partner-attribution.ts';
import { createTransactionalTemplateData } from '../src/server/email/transactional-template-data.ts';
import { createTransactionalRenderers } from '../src/server/email/transactional-templates.ts';
import { campaignFlagRegistry } from '../src/server/flags/registry.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { createVerificationService } from '../src/server/verification/service.ts';
import {
  createPartnerFixture,
  insertMember,
  insertPartner,
} from './helpers/partner-review-fixture.ts';

const clock = () => new Date('2026-12-02T10:00:00.000Z');
const actor = 'founder:referred-welcome-line-test';
const line = emailCopy.welcome.referredByMember;
const htmlLine = line.replaceAll("'", '&#39;');
const partnerLine =
  'You joined through MAYA: early access from September 2027 and 15% off your first order.';
const escapeRegExp = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

test('the flag is registered and defaults off', () => {
  assert.equal(campaignFlagRegistry['email.referred_welcome_line'], false);
});

test('the friend line reaches the member-referred member only, before their own link, in both parts, and names no one', async (t) => {
  const fixture = await createPartnerFixture('referred-welcome-line');
  t.after(() => fixture.dispose());
  const flags = createCampaignFlagRepository(fixture.app);
  const referrals = createReferralService(fixture.app);

  // The seeded referrer: every one of these must stay out of the email.
  const referrer = await insertMember(fixture, {
    email: 'Seeded.Referrer.Ingrid@example.test',
  });
  const referrerCode = await referrals.getReferralCode(referrer.id);
  assert.ok(referrerCode);
  const partner = await insertPartner(fixture, {
    status: 'active',
    code: 'MAYA',
    partnerType: 'student_ambassador',
    fullName: 'Partner Maya Seeded',
    email: 'seeded.partner.maya@example.test',
  });
  await createPartnerAttributionRepository(fixture.app).setCodeActive(
    partner.id,
    true,
  );

  async function join(label: string, code: string | null, method?: 'code') {
    const member = await insertMember(fixture, {
      email: `${label}@example.test`,
      status: 'pending',
    });
    if (code !== null) {
      assert.equal(
        (await referrals.attribute(member.id, code, true, method)).kind,
        'attributed',
        label,
      );
    }
    const { token } = await createVerificationService(fixture.app, {
      clock,
    }).issue(member.id, 'verify');
    const completion = await createVerificationCompletionService(fixture.app, {
      clock,
    })(token);
    assert.equal(completion.outcome, 'verified', label);
    return member.id;
  }

  const friend = await join('member-referred', referrerCode);
  const partnerFriend = await join('partner-referred', 'MAYA', 'code');
  const direct = await join('direct', null);

  const edges = await fixture.owner.list<{
    referred_id: string;
    state: string;
    partner_id: string | null;
  }>(
    {
      text: `SELECT referred_id::text, state, partner_id::text FROM referral_edge
        WHERE referred_id = ANY($1::uuid[]) ORDER BY referred_id`,
      values: [[friend, partnerFriend, direct]],
    },
    10,
  );
  assert.deepEqual(
    new Map(edges.map((edge) => [edge.referred_id, edge])),
    new Map([
      [friend, { referred_id: friend, state: 'confirmed', partner_id: null }],
      [
        partnerFriend,
        {
          referred_id: partnerFriend,
          state: 'confirmed',
          partner_id: partner.id,
        },
      ],
    ]),
    'one confirmed member edge, one confirmed partner edge, no edge for the direct member',
  );

  async function welcome(subscriberId: string) {
    const row = await fixture.owner.readOne<{
      payload: Record<string, unknown>;
      email: string;
    }>({
      text: `SELECT payload, email FROM email_send JOIN subscriber ON subscriber.id = subscriber_id
        WHERE business_key = $1 AND template = 'welcome'`,
      values: [`welcome:${subscriberId}`],
    });
    assert.ok(row, 'verification queued the welcome email');
    // A fresh data source per render, so no flag cache carries over.
    const renderer = createTransactionalRenderers({
      baseUrl: 'https://valstara.com',
      sendingDomain: 'send.valstara.com',
      data: createTransactionalTemplateData(fixture.app),
    }).get('welcome');
    assert.ok(renderer);
    const message = await renderer.render({
      email: row.email,
      payload: row.payload,
      token: async () => 'test-status-token',
      unsubscribePageUrl: 'https://valstara.com/unsubscribe?token=test',
    });
    assert.ok(message.html);
    const link = (await createReferralService(fixture.app).status(subscriberId))
      .referralLink;
    return { ...message, html: message.html, link };
  }

  // Flag off (the default): no one gets the line, and the email is unchanged.
  const off = {
    friend: await welcome(friend),
    partnerFriend: await welcome(partnerFriend),
    direct: await welcome(direct),
  };
  for (const message of Object.values(off)) {
    assert.ok(!message.text.includes(line));
    assert.ok(!message.html.includes(htmlLine));
  }

  await flags.set('email.referred_welcome_line', true, actor);
  const on = {
    friend: await welcome(friend),
    partnerFriend: await welcome(partnerFriend),
    direct: await welcome(direct),
  };

  // The member-referred member: once in each part, directly before their own
  // referral link.
  const mail = on.friend;
  assert.equal(mail.text.split(line).length, 2, 'once in the plain text');
  assert.ok(
    mail.text.includes(`${line}\n\n${emailCopy.referral}: ${mail.link}`),
    'plain text: the line directly precedes the member’s own link',
  );
  assert.equal(mail.html.split(htmlLine).length, 2, 'once in the HTML');
  assert.match(
    mail.html,
    new RegExp(
      `<p>${escapeRegExp(htmlLine)}</p></td></tr><tr><td class="v-text v-link"[^>]*><a href="${escapeRegExp(mail.link)}">${escapeRegExp(emailCopy.referral)}</a>`,
      'u',
    ),
    'HTML: the line’s row directly precedes the member’s own link',
  );
  assert.doesNotMatch(mail.text, /You joined through/u);

  // Off is exactly on minus the one paragraph.
  assert.equal(mail.subject, off.friend.subject);
  assert.equal(mail.text.replace(`${line}\n\n`, ''), off.friend.text);
  assert.equal(
    mail.html.replace(
      new RegExp(
        `<tr><td class="v-text"[^>]*><p>${escapeRegExp(htmlLine)}</p></td></tr>`,
        'u',
      ),
      '',
    ),
    off.friend.html,
  );

  // The partner-referred member keeps only the partner line; the direct
  // member gets neither. Both emails are what they were with the flag off.
  for (const [label, message] of [
    ['partner-referred', on.partnerFriend],
    ['direct', on.direct],
  ] as const) {
    assert.ok(!message.text.includes(line), label);
    assert.ok(!message.html.includes(htmlLine), label);
  }
  assert.ok(on.partnerFriend.text.includes(partnerLine));
  assert.ok(on.partnerFriend.html.includes(partnerLine));
  assert.doesNotMatch(on.direct.text, /You joined through/u);
  assert.deepEqual(on.partnerFriend, off.partnerFriend);
  assert.deepEqual(on.direct, off.direct);

  // No part of the member-referred member's email carries the referrer.
  const referrerData = [
    referrer.id,
    referrer.email,
    referrer.email.toLowerCase(),
    'Ingrid',
    referrerCode,
  ];
  for (const value of referrerData) {
    for (const part of [mail.subject, mail.text, mail.html]) {
      assert.ok(
        !part.toLowerCase().includes(value.toLowerCase()),
        `the welcome email carries the referrer's ${value}`,
      );
    }
  }
  // Nor does the partner-referred member's email carry the partner's person.
  for (const value of [partner.subscriberId, partner.email, 'Seeded']) {
    for (const part of [
      on.partnerFriend.subject,
      on.partnerFriend.text,
      on.partnerFriend.html,
    ]) {
      assert.ok(!part.toLowerCase().includes(value.toLowerCase()), value);
    }
  }

  // Only a confirmed, non-voided edge counts: a voided referral drops the line.
  const voids = createReferralVoidService(fixture.app, clock);
  await voids.voidReferral(friend, 'Referred welcome line test', actor);
  assert.ok(!(await welcome(friend)).text.includes(line));
  await voids.unvoidReferral(friend, 'Referred welcome line test', actor);
  assert.ok((await welcome(friend)).text.includes(line));

  // Switched off again, the line goes without a deploy.
  await flags.set('email.referred_welcome_line', false, actor);
  assert.deepEqual(await welcome(friend), off.friend);
});
