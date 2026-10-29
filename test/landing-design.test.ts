import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { landingCopy } from '../src/copy/landing.ts';
import { resendVerificationCopy } from '../src/copy/resend-verification.ts';
import { signupCopy, signupFormCopy } from '../src/copy/signup.ts';
import { milestoneTiers } from '../src/server/referral/config.ts';

const words = (value: string): number => value.trim().split(/\s+/u).length;

test('landing marketing copy stays inside its heading, line, card and FAQ budgets', () => {
  const rulesSource = readFileSync(
    new URL(
      '../src/content/giveaway-rules/VAL-GW-LAUNCH-20261009-r1.md',
      import.meta.url,
    ),
    'utf8',
  );
  const prizeCount = Number(/^prizeCount: (\d+)$/mu.exec(rulesSource)?.[1]);
  const prizeApproxRetailValueEur = Number(
    /^prizeApproxRetailValueEur: (\d+)$/mu.exec(rulesSource)?.[1],
  );
  assert.ok(Number.isFinite(prizeCount));
  assert.ok(Number.isFinite(prizeApproxRetailValueEur));
  const headings = [
    landingCopy.hero.heading,
    landingCopy.paused.heading,
    landingCopy.catalogue.heading,
    landingCopy.how.heading,
    landingCopy.rewards.heading,
    landingCopy.rewards.accessHeading,
    landingCopy.rewards.referralHeading,
    landingCopy.rewards.giveawayHeading,
    landingCopy.trust.heading,
    landingCopy.trustLinks.heading,
    landingCopy.faq.heading,
    landingCopy.final.heading,
    ...landingCopy.trust.promises.map((promise) => promise.title),
    ...landingCopy.trustLinks.items.map((item) => item.heading),
  ];
  for (const heading of headings) assert.ok(words(heading) <= 7, heading);

  const lines = [
    landingCopy.hero.body,
    landingCopy.paused.body,
    landingCopy.catalogue.body,
    landingCopy.rewards.accessBody,
    landingCopy.rewards.held,
    landingCopy.trust.intro,
    ...landingCopy.trust.promises.map((promise) => promise.line),
  ];
  for (const line of lines) assert.ok(words(line) <= 20, line);

  const cards = [
    ...landingCopy.hero.facts.map((fact) => fact.text),
    ...landingCopy.how.steps,
    ...landingCopy.trustLinks.items.map((item) => item.line),
    landingCopy.rewards.accessBody,
    ...[1, 2, 3, 4].map(landingCopy.rewards.waveLabel),
    ...milestoneTiers
      .filter((tier) => tier.enabled)
      .map(landingCopy.rewards.tier),
    landingCopy.rewards.held,
    landingCopy.rewards.verifiedOnly,
    landingCopy.rewards.prize({ prizeCount, prizeApproxRetailValueEur }),
    `${landingCopy.rewards.freeEntry} · ${landingCopy.rewards.age}`,
    landingCopy.rewards.rulesLink,
  ];
  for (const card of cards) assert.ok(words(card) <= 15, card);
  for (const item of landingCopy.faq.items) {
    assert.ok(words(item.question) <= 7, item.question);
    assert.ok(words(item.answer) <= 45, item.answer);
  }
});

// E11.5-11g: the signup states' copy, by key, under the marketing-surface
// budgets: a heading at most 7 words, every other line at most 20.
const signupStateHeadings = {
  'signupFormCopy.successHeading': signupFormCopy.successHeading,
} as const;
const signupStateLines = {
  'signupFormCopy.emailRequired': signupFormCopy.emailRequired,
  'signupCopy.invalidEmail': signupCopy.invalidEmail,
  'signupCopy.blockedDomain': signupCopy.blockedDomain,
  'signupFormCopy.challengePending': signupFormCopy.challengePending,
  'signupFormCopy.submitting': signupFormCopy.submitting,
  'signupCopy.challengeFailed': signupCopy.challengeFailed,
  'signupFormCopy.connection': signupFormCopy.connection,
  'signupCopy.unavailable': signupCopy.unavailable,
  'signupCopy.rateLimitedWait': signupCopy.rateLimitedWait(15),
  'signupFormCopy.successStep': signupFormCopy.successStep,
  'signupFormCopy.differentAddress': signupFormCopy.differentAddress,
  'signupFormCopy.resendLink': signupFormCopy.resendLink,
  'resendVerificationCopy.accepted': resendVerificationCopy.accepted,
  'signupFormCopy.javaScriptRequired': signupFormCopy.javaScriptRequired,
} as const;
// Founder-authorised 2026-10-26: the success-panel body is 21 words. It is
// the only exception, and only to the line budget.
const signupStateBudgetExceptions = ['signupFormCopy.successStep'];

function signupStateOverBudget(exceptions: readonly string[]): string[] {
  return [
    ...Object.entries(signupStateHeadings).filter(
      ([, heading]) => words(heading) > 7,
    ),
    ...Object.entries(signupStateLines).filter(
      ([key, line]) => words(line) > 20 && !exceptions.includes(key),
    ),
  ].map(([key]) => key);
}

test('signup state copy stays inside its budgets, with one named exception', () => {
  assert.deepEqual(signupStateOverBudget(signupStateBudgetExceptions), []);
});

test('the signup copy-budget exception is narrow: without it the success body fails', () => {
  assert.deepEqual(signupStateBudgetExceptions, ['signupFormCopy.successStep']);
  assert.equal(words(signupFormCopy.successStep), 21);
  assert.deepEqual(signupStateOverBudget([]), ['signupFormCopy.successStep']);
});

test('referral and prize copy derives its figures from injected source values', () => {
  const tier = milestoneTiers.find((candidate) => candidate.enabled);
  assert.ok(tier);
  const renderedTier = landingCopy.rewards.tier(tier);
  assert.match(renderedTier, new RegExp(`\\b${tier.threshold}\\b`, 'u'));
  assert.match(renderedTier, new RegExp(`${tier.discountPercent}%`, 'u'));
  assert.notEqual(
    landingCopy.rewards.tier({
      ...tier,
      threshold: tier.threshold + 2,
      discountPercent: tier.discountPercent + 7,
    }),
    renderedTier,
  );
  const rules = { prizeCount: 5, prizeApproxRetailValueEur: 300 };
  const renderedPrize = landingCopy.rewards.prize(rules);
  assert.match(renderedPrize, /5 prizes/u);
  assert.match(renderedPrize, /€300/u);
  assert.notEqual(
    landingCopy.rewards.prize({
      ...rules,
      prizeCount: 7,
      prizeApproxRetailValueEur: 400,
    }),
    renderedPrize,
  );
});

test('landing copy and markup carry no countdown, scarcity, position or exit-intent mechanic', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/copy/landing.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/index.astro', import.meta.url), 'utf8'),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /countdown|limited spots|spots left|your position|exit.intent/iu,
    );
  }
});
