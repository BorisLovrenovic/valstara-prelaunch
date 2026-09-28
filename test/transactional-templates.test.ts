import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { QueuedEmailRow } from '../src/server/db/email.ts';
import { presentReferralStatus } from '../src/server/referral/status-presentation.ts';
import type { ReferralStatus } from '../src/server/referral/status.ts';
import { prepareDispatchMessage } from '../src/server/email/service.ts';
import { createTransactionalRenderers } from '../src/server/email/transactional-templates.ts';

const baseUrl = 'https://valstara.test';
const rulesVersion = 'VAL-GW-LAUNCH-20260925-r1';
const awardId = '11111111-1111-4111-8111-111111111111';
const deadline = new Date('2027-04-15T09:00:00.000Z');
const referralStatus: ReferralStatus = {
  accessWindow: 'wave-2',
  confirmedReferrals: 3,
  giveawayEntries: 6,
  ownRank: 4,
  referralLink: 'https://valstara.com/?ref=ABCDEF234567',
  rewards: [
    { kind: 'wave_upgrade', state: 'settled', tier: 1 },
    { kind: 'discount', state: 'held', tier: 1 },
    { kind: 'entries', state: 'held', tier: 1 },
  ],
  subscriberStatus: 'verified',
  tier: 1,
};
const renderers = createTransactionalRenderers({
  baseUrl,
  sendingDomain: 'send.valstara.com',
  data: {
    async referralStatus() {
      return referralStatus;
    },
    async receiptEntries() {
      return 6;
    },
    async winnerDetails() {
      return { deadline, rulesVersion };
    },
  },
});

const cases = [
  {
    template: 'verification_test',
    payload: { token_id: 'verify-id' },
    verified: false,
  },
  {
    template: 'verification_reminder',
    payload: { token_id: 'verify-id' },
    verified: false,
  },
  {
    template: 'welcome',
    payload: { status_token_id: 'status-id' },
    verified: true,
  },
  {
    template: 'milestone_reached',
    payload: { status_token_id: 'status-id', tier: 1 },
    verified: true,
  },
  {
    template: 'status_link',
    payload: { token_id: 'status-id' },
    verified: true,
  },
  {
    template: 'giveaway_entry_receipt',
    payload: { status_token_id: 'status-id', rules_version: rulesVersion },
    verified: true,
  },
  {
    template: 'giveaway_winner',
    payload: { token_id: 'status-id', award_id: awardId },
    verified: true,
  },
] as const;

function queuedRow(
  template: string,
  payload: Record<string, unknown>,
): QueuedEmailRow {
  return {
    id: 'send-id',
    subscriber_id: 'subscriber-id',
    template,
    provider: 'resend',
    business_key: `fixture:${template}`,
    payload,
    unsubscribe_token_id: 'unsubscribe-id',
    attempts: 0,
  };
}

const token = async (id: string): Promise<string> => {
  const tokens: Record<string, string> = {
    'verify-id': 'verify-signature',
    'status-id': 'status-signature',
    'unsubscribe-id': 'unsubscribe-signature',
  };
  const value = tokens[id];
  if (value === undefined) throw new Error('Fixture token missing.');
  return value;
};

test('E8-03 registers seven real transactional renderers with HTML and plain text', () => {
  assert.deepEqual(
    [...renderers.keys()],
    cases.map(({ template }) => template),
  );
  assert.ok(
    [...renderers.values()].every(
      (renderer) => renderer.kind === 'transactional',
    ),
  );
});

test('E8-03 required links and plain-text parity hold for each template', async () => {
  for (const { template, payload, verified } of cases) {
    const renderer = renderers.get(template);
    assert.ok(renderer, template);
    const { message, headers } = await prepareDispatchMessage({
      row: queuedRow(template, payload),
      recipient: 'reader@example.test',
      renderer,
      baseUrl,
      token,
    });
    assert.equal(message.to, 'reader@example.test');
    assert.match(message.from, /@send\.valstara\.com/u);
    assert.ok(message.subject.length > 8);
    assert.ok(message.html);
    const pageUrl = new URL('/unsubscribe', baseUrl);
    pageUrl.searchParams.set('t', 'unsubscribe-signature');
    assert.ok(message.text.includes(pageUrl.toString()), template);
    assert.ok(message.html.includes(`href="${pageUrl.toString()}"`), template);
    const headerValue = headers['List-Unsubscribe'];
    assert.ok(headerValue);
    const headerUrl = new URL(headerValue.slice(1, -1));
    assert.equal(headerUrl.pathname, '/api/unsubscribe');
    assert.equal(
      headerUrl.searchParams.get('token'),
      pageUrl.searchParams.get('t'),
    );
    assert.equal(
      headers['List-Unsubscribe-Post'],
      'List-Unsubscribe=One-Click',
    );
    for (const match of message.html.matchAll(/<a href="([^"]+)">/gu)) {
      const url = match[1].replaceAll('&amp;', '&');
      assert.ok(
        message.text.includes(url),
        `${template} plain text lost ${url}`,
      );
    }
    assert.equal(message.text.includes('/me?t='), verified, template);
    assert.equal(message.html.includes('/me?t='), verified, template);
    if (!verified) {
      assert.ok(message.text.includes('/verify?token=verify-signature'));
      assert.ok(message.html.includes('/verify?token=verify-signature'));
    }
  }
});

test('E8-03 verification begins with its purpose; milestone distinguishes held and settled rewards', async () => {
  const verification = await renderers.get('verification_test')!.render({
    email: 'reader@example.test',
    payload: { token_id: 'verify-id' },
    token,
    unsubscribePageUrl: `${baseUrl}/unsubscribe?t=unsubscribe-signature`,
  });
  assert.equal(
    verification.text.split('\n')[0],
    'Verify your Valstara email address.',
  );
  const milestone = await renderers.get('milestone_reached')!.render({
    email: 'reader@example.test',
    payload: { status_token_id: 'status-id', tier: 1 },
    token,
    unsubscribePageUrl: `${baseUrl}/unsubscribe?t=unsubscribe-signature`,
  });
  assert.match(milestone.subject, /Referral tier 1 reached/u);
  assert.match(milestone.text, /Access-wave upgrade — Settled/u);
  assert.match(milestone.text, /Launch discount — Held/u);
  assert.match(milestone.text, /Bonus entries — Held/u);
});

test('E8-03 welcome and milestone use the same referral presentation as /me', async () => {
  const view = presentReferralStatus(referralStatus);
  for (const template of ['welcome', 'milestone_reached']) {
    const message = await renderers.get(template)!.render({
      email: 'reader@example.test',
      payload: { status_token_id: 'status-id', tier: 1 },
      token,
      unsubscribePageUrl: `${baseUrl}/unsubscribe?t=unsubscribe-signature`,
    });
    for (const field of view.fields) {
      assert.ok(message.text.includes(`${field.label}: ${field.value}`));
      assert.ok(message.html?.includes(field.value));
    }
    for (const reward of view.rewards) {
      assert.ok(
        message.text.includes(
          `${reward.tier}: ${reward.label} — ${reward.state}`,
        ),
      );
    }
    assert.ok(message.text.includes(view.referralLink));
  }
  const memberPage = readFileSync('src/pages/me.astro', 'utf8');
  assert.match(memberPage, /presentReferralStatus\(dashboardStatus\)/u);
  for (const field of Object.keys(view.values)) {
    assert.ok(memberPage.includes(`dashboardView.values.${field}`));
  }
});

test('E8-03 receipt and winner use immutable rules links and the winner deadline', async () => {
  const receipt = await renderers.get('giveaway_entry_receipt')!.render({
    email: 'reader@example.test',
    payload: { status_token_id: 'status-id', rules_version: rulesVersion },
    token,
    unsubscribePageUrl: `${baseUrl}/unsubscribe?t=unsubscribe-signature`,
  });
  const winner = await renderers.get('giveaway_winner')!.render({
    email: 'reader@example.test',
    payload: { token_id: 'status-id', award_id: awardId },
    token,
    unsubscribePageUrl: `${baseUrl}/unsubscribe?t=unsubscribe-signature`,
  });
  for (const message of [receipt, winner]) {
    assert.ok(message.text.includes(`/giveaway/rules/${rulesVersion}`));
    assert.ok(message.html?.includes(`/giveaway/rules/${rulesVersion}`));
  }
  assert.match(receipt.text, /6 entries under rules version/u);
  assert.ok(winner.text.includes(deadline.toISOString()));
  assert.ok(winner.text.includes('/giveaway/award?'));
  assert.ok(winner.html?.includes('/giveaway/award?'));
});

test('E8-03 rendered subjects and bodies contain no forbidden copy', async () => {
  const policy = JSON.parse(
    readFileSync('scripts/forbidden-copy.json', 'utf8'),
  ) as {
    entries: { term: string }[];
  };
  for (const { template, payload } of cases) {
    const message = await renderers.get(template)!.render({
      email: 'reader@example.test',
      payload,
      token,
      unsubscribePageUrl: `${baseUrl}/unsubscribe?t=unsubscribe-signature`,
    });
    const copy =
      `${message.subject}\n${message.text}\n${message.html}`.toLowerCase();
    for (const { term } of policy.entries) {
      assert.doesNotMatch(
        copy,
        new RegExp(`\\b${term}\\b`, 'iu'),
        `${template}: ${term}`,
      );
    }
  }
});
