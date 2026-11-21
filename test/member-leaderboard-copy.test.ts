import assert from 'node:assert/strict';
import test from 'node:test';

import {
  leaderboardCopy,
  leaderboardPanelCopy,
} from '../src/copy/leaderboard.ts';
import { marketingOptInCopy } from '../src/copy/marketing.ts';
import { memberStatusCopy } from '../src/copy/member-status.ts';
import { referralLadderCopy } from '../src/copy/referral-ladder.ts';
import { landingLadder } from '../src/server/referral/ladder-presentation.ts';
import { presentReferralStatus } from '../src/server/referral/status-presentation.ts';
import { computeReferralStatus } from '../src/server/referral/status.ts';

const words = (text: string) => text.trim().split(/\s+/u).length;

// docs/brand/copy-rules.md#never-build, as wording: a retention plea, a
// confirmation maze, manufactured urgency or scarcity, or a position claim.
const neverBuild = [
  /are you sure/iu,
  /miss out/iu,
  /sad to see/iu,
  /before you go/iu,
  /don['’]t go/iu,
  /we['’]ll miss/iu,
  /you['’]ll lose/iu,
  /reconsider/iu,
  /last chance/iu,
  /hurry/iu,
  /countdown/iu,
  /only \d+ (?:left|spots?|places?)/iu,
  /spots? (?:left|remaining)/iu,
  /expires? (?:in|soon)/iu,
  /you['’]re #/iu,
];

function neverBuildMatches(strings: readonly string[]): string[] {
  return strings.filter((text) =>
    neverBuild.some((pattern) => pattern.test(text)),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  // A wording function is scanned with a sample argument for each parameter.
  if (typeof value === 'function') {
    const wording = value as (...parameters: string[]) => unknown;
    return strings(
      wording(...Array.from({ length: wording.length }, () => '3')),
    );
  }
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(strings);
  return [];
}

test('E11.5-08 the shared presentation keys every field and coupon without changing a value', () => {
  const view = presentReferralStatus(
    computeReferralStatus(25, 'KEYS23456789', {
      accessWindow: 'wave-1',
      giveawayEntries: 5,
      ownRank: 7,
      verificationOrderWindow: 'wave-3',
    }),
  );
  // E11.7-04: the retired referral tier is no longer a fact.
  assert.deepEqual(
    view.fields.map(({ key, value }) => [key, value]),
    [
      [
        'subscriberStatus',
        memberStatusCopy.authenticated.statusValues.verified,
      ],
      ['confirmedReferrals', '25'],
      ['ownRank', '7'],
      ['accessWindow', 'wave-1'],
      ['giveawayEntries', '5'],
    ],
  );
  assert.deepEqual(
    view.coupons.map(({ label, percent, state }) => [label, percent, state]),
    [
      ['Coupon 1', '30%', referralLadderCopy.heldState],
      ['Coupon 2', '10%', referralLadderCopy.heldState],
    ],
  );
  // The founder's form (2026-11-17).
  assert.equal(
    view.ladder.line,
    'Coupon 1: 30% · Coupon 2: 10% · 2 more confirmed referrals to 15%.',
  );
  for (const coupon of view.coupons)
    assert.match(coupon.condition, /first order/u);
});

test('E11.5-08 the wave badge reads the stored wave', () => {
  assert.equal(memberStatusCopy.authenticated.waveBadge('wave-2'), 'Wave 2');
  // The badge reads the whole wave number and never invents one for a value
  // in another format.
  assert.equal(memberStatusCopy.authenticated.waveBadge('wave-12'), 'Wave 12');
  assert.equal(memberStatusCopy.authenticated.waveBadge('early-3'), 'early-3');
});

test('E11.5-08 leave and marketing copy carries no never-build pattern', () => {
  const surfaces = [
    ...strings(memberStatusCopy.leave),
    ...strings(memberStatusCopy.left),
    ...strings(memberStatusCopy.marketing),
    marketingOptInCopy.wording,
  ];
  assert.ok(surfaces.length > 10);
  assert.deepEqual(neverBuildMatches(surfaces), []);
  // The whole member and leaderboard copy is held to the same rule.
  assert.deepEqual(
    neverBuildMatches([
      ...strings(memberStatusCopy),
      ...strings(leaderboardCopy),
      ...strings(leaderboardPanelCopy),
      // The ladder wording /me shows; the landing card's takes lists, so
      // it is scanned as rendered from the configuration.
      ...strings({ ...referralLadderCopy, landing: null }),
      ...strings(landingLadder()),
    ]),
    [],
  );
  // Leaving is one plain action: one submit label, no confirmation step.
  assert.equal(
    Object.keys(memberStatusCopy.leave).filter((key) => /confirm/iu.test(key))
      .length,
    0,
  );
});

test('E11.5-08 the never-build scan catches a planted retention plea and urgency', () => {
  assert.deepEqual(
    neverBuildMatches([
      'Are you sure? You will miss out on launch access.',
      'Only 3 spots left — hurry!',
      'Leave the waitlist',
    ]),
    [
      'Are you sure? You will miss out on launch access.',
      'Only 3 spots left — hurry!',
    ],
  );
});

test('E11.5-08 member and leaderboard copy stays within the E11.5 copy budget', () => {
  const headings = [
    memberStatusCopy.authenticated.heading,
    memberStatusCopy.referral.heading,
    memberStatusCopy.rewards.heading,
    memberStatusCopy.preferences.heading,
    memberStatusCopy.survey.heading,
    memberStatusCopy.marketing.heading,
    memberStatusCopy.dataRights.heading,
    memberStatusCopy.leave.heading,
    memberStatusCopy.left.heading,
    memberStatusCopy.disabled.heading,
    memberStatusCopy.recovery.heading,
    leaderboardCopy.heading,
    leaderboardPanelCopy.counts.heading,
    leaderboardPanelCopy.cta.heading,
  ];
  const cardText = [
    memberStatusCopy.authenticated.waveBadge('wave-1'),
    memberStatusCopy.referral.copy,
    memberStatusCopy.referral.share,
    memberStatusCopy.referral.copied,
    memberStatusCopy.referral.copyFailed,
    memberStatusCopy.rewards.empty(3),
    referralLadderCopy.coupon(1, 30),
    referralLadderCopy.heldState,
    referralLadderCopy.heldShort,
    referralLadderCopy.nextAt(39),
    referralLadderCopy.earlyAccessPill('July 2027'),
    memberStatusCopy.survey.submit,
    memberStatusCopy.marketing.turnOn,
    memberStatusCopy.marketing.turnOff,
    memberStatusCopy.leave.submit,
    memberStatusCopy.recovery.submit,
    leaderboardPanelCopy.cta.join,
    leaderboardCopy.rank(10),
    leaderboardCopy.confirmedReferrals(12),
  ];
  const supportingLines = [
    memberStatusCopy.authenticated.body,
    referralLadderCopy.held(5),
    // The longest progress line: three coupons and the next step.
    `${[referralLadderCopy.coupon(1, 30), referralLadderCopy.coupon(2, 30), referralLadderCopy.coupon(3, 25), referralLadderCopy.nextPercent(3, 30)].join(referralLadderCopy.separator)}.`,
    `${[referralLadderCopy.coupon(1, 30), referralLadderCopy.coupon(2, 30), referralLadderCopy.coupon(3, 30), referralLadderCopy.complete].join(referralLadderCopy.separator)}.`,
    referralLadderCopy.waveOne.firstMembers('September 2027', '1,000'),
    referralLadderCopy.waveOne.referrals('September 2027', 3),
    referralLadderCopy.waveOne.notYet('September 2027', 3),
    memberStatusCopy.marketing.wording,
    memberStatusCopy.leave.body,
    memberStatusCopy.left.body,
    memberStatusCopy.disabled.body,
    memberStatusCopy.recovery.body,
    memberStatusCopy.recovery.sent,
    leaderboardCopy.introduction,
    ...leaderboardPanelCopy.counts.lines,
    leaderboardPanelCopy.cta.member,
    leaderboardCopy.empty,
    leaderboardCopy.unavailable,
  ];
  for (const heading of headings) assert.ok(words(heading) <= 7, heading);
  for (const text of cardText) assert.ok(words(text) <= 15, text);
  for (const line of supportingLines) assert.ok(words(line) <= 20, line);
  assert.equal(leaderboardPanelCopy.counts.lines.length, 2);
});

test('E11.5-08 leaderboard figures compose back to the copy-layer wording', () => {
  for (const count of [0, 1, 7]) {
    assert.equal(
      `${count} ${leaderboardCopy.confirmedReferralsLabel(count)}`,
      leaderboardCopy.confirmedReferrals(count),
    );
  }
  assert.equal(leaderboardCopy.confirmedReferrals(1), '1 confirmed referral');
  assert.equal(`${leaderboardCopy.rankLabel} ${4}`, leaderboardCopy.rank(4));
});
