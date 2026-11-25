// E11.7-15 (D-074, audit finding C1): the partner dashboard and the partner
// digest show the snapshot time and every count as people read them. The
// time comes from the public leaderboard's own formatSnapshotTimestamp, and
// counts are grouped as /me groups figures, "1,830".
import assert from 'node:assert/strict';
import test from 'node:test';

import { partnerDashboardCopy } from '../src/copy/partner-dashboard.ts';
import { formatSnapshotTimestamp } from '../src/islands/leaderboard.ts';
import type { PartnerDashboardRow } from '../src/server/db/partner-dashboard.ts';
import {
  presentPartnerDashboard,
  presentSnapshotTime,
} from '../src/server/partner/dashboard-presentation.ts';
import {
  partnerDigestRenderer,
  type PartnerDigestData,
} from '../src/server/partner/digest-template.ts';

const asOf = '2026-11-24T08:00:00.000Z';

test('the dashboard shows the snapshot time in the public leaderboard’s format', () => {
  assert.equal(presentSnapshotTime(asOf), 'Nov 24, 2026, 08:00 AM UTC');
  assert.equal(presentSnapshotTime(asOf), formatSnapshotTimestamp(asOf));
  assert.doesNotMatch(presentSnapshotTime(asOf), /T08|\.000Z/u);
});

test('the dashboard groups every count it presents', () => {
  assert.equal(partnerDashboardCopy.count(0), '0');
  assert.equal(partnerDashboardCopy.count(999), '999');
  assert.equal(partnerDashboardCopy.count(1_830), '1,830');
  assert.equal(partnerDashboardCopy.count(1_234_567), '1,234,567');
  // Only the fields the counts read; rewards stay off.
  const row = {
    status: 'active',
    active_code: true,
    code: 'FIGURES2345',
    confirmed: 1_830,
    pending: 1_001,
    voided: 12,
    categories: { ai: 2_500, software: 3 },
  } as unknown as PartnerDashboardRow;
  const presentation = presentPartnerDashboard(row, false);
  assert.deepEqual(
    presentation.counts.map(({ count }) => count),
    ['1,830', '1,001', '12'],
  );
  const categories = Object.fromEntries(
    presentation.categories.map(({ label, count }) => [label, count]),
  );
  assert.equal(categories['AI tools'], '2,500');
  assert.equal(categories['Software'], '3');
});

async function renderDigest(rank: PartnerDigestData['rank']) {
  const renderer = partnerDigestRenderer({
    baseUrl: 'https://valstara.com',
    sendingDomain: 'mail.valstara.com',
    note: () => 'A note.',
    eligible: async () => true,
    async data() {
      return {
        confirmedInPeriod: 1_204,
        confirmedTotal: 12_345,
        rank,
        categories: { ai: 1_000, software: 7 },
        waitlistVerifiedInPeriod: 4_120,
        waitlistVerifiedTotal: 18_300,
      };
    },
  });
  const message = await renderer.render({
    email: 'partner@example.test',
    payload: { period: '2026-10', status_token_id: 'status-token' },
    token: async () => 'signed',
    unsubscribePageUrl: 'https://valstara.com/unsubscribe?t=x',
  } as Parameters<typeof renderer.render>[0]);
  return message.text;
}

test('the digest prints its rank time for people and groups every count', async () => {
  const ranked = await renderDigest({ kind: 'ranked', rank: 2, asOf });
  for (const line of [
    'Confirmed signups in October 2026: 1,204',
    'Confirmed signups in total: 12,345',
    'Your partner leaderboard rank: 2 (as of Nov 24, 2026, 08:00 AM UTC)',
    'AI tools: 1,000',
    'Software: 7',
    'People who confirmed their place on the waitlist in October 2026: 4,120',
    'People with a confirmed place on the waitlist: 18,300',
  ])
    assert.ok(ranked.includes(line), line);
  assert.doesNotMatch(ranked, /2026-11-24T|\.000Z|12345|18300/u);

  const unranked = await renderDigest({ kind: 'unranked', asOf });
  assert.ok(
    unranked.includes(
      'You do not have a rank in the partner leaderboard (as of Nov 24, 2026, 08:00 AM UTC).',
    ),
  );
  assert.doesNotMatch(unranked, /2026-11-24T/u);
});
