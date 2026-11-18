import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MergeError,
  mergePriceIndex,
  retirableOverrides,
} from '../../packages/price-index/src/pipeline/index.ts';
import { isPublishable } from '../../packages/price-index/src/publish/index.ts';
import type { PriceRecord } from '../../packages/price-index/src/schema/index.ts';
import {
  decision,
  gap,
  mergeSingle,
  notOffered,
  observation,
  official,
  priceOverride,
  record,
  runTime,
  scraper,
  settings,
  singleInput,
  sweden,
} from '../helpers/price-index-merge.ts';

// E11.6-06: every row of the status rules in
// docs/features/price-index.md#validation-merge-and-the-publish-gate, and
// every case of the founder decisions of 2026-11-18 (D-028), is a named case
// here with explicit inputs: Spotify Premium — Individual in Sweden, with a
// previous record, this run's observation or gap, a manual entry and the
// decisions in approvals.json. Time comes from an injected clock.

function lines(result: PriceRecord): string[] {
  return result.notes === null ? [] : result.notes.split('\n');
}

function assertNote(result: PriceRecord, pattern: RegExp) {
  assert.ok(
    lines(result).some((line) => pattern.test(line)),
    `no note matches ${pattern}: ${JSON.stringify(result.notes)}`,
  );
}

// --- A first observation, and the record's fields -------------------------

test('a first observation with nothing before it is ok, with every field from the run', () => {
  assert.deepEqual(mergeSingle({ observation: observation() }), {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '149.00',
    price_source_text: 'kr 149',
    currency: 'SEK',
    price_usd_source: '15.79',
    source: scraper,
    source_url: sweden,
    observed_at: runTime,
    source_verified_at: '2026-11-28',
    status: 'ok',
    missing_reason: null,
    notes: null,
  });
});

test('the built latest.json is stamped with the injected clock', () => {
  const latest = mergePriceIndex(
    singleInput({ observation: observation(), now: '2026-12-02T08:00:00Z' }),
  );
  assert.equal(latest.built_at, '2026-12-02T08:00:00.000Z');
});

// --- Precedence -----------------------------------------------------------

test('precedence: a manual override fills a gap the scraper leaves', () => {
  const result = mergeSingle({
    gap: gap({ reason: 'not_on_source' }),
    entry: priceOverride({ price_usd_source: '15.79', note: 'Checked.' }),
  });
  assert.deepEqual(result, {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: '149.00',
    price_source_text: null,
    currency: 'SEK',
    price_usd_source: '15.79',
    source: 'manual',
    source_url: official,
    observed_at: null,
    source_verified_at: '2026-11-30',
    status: 'manual_override',
    missing_reason: null,
    notes: 'Checked.',
  });
  assert.equal(isPublishable(result), true);
});

test('precedence: the scraper agreeing with an override is ok, and the override is retirable', () => {
  const input = singleInput({
    observation: observation({ price_local: '149.00' }),
    entry: priceOverride({ price_local: '149.00' }),
  });
  const latest = mergePriceIndex(input);
  const [result] = latest.records;
  assert.equal(result!.status, 'ok');
  assert.equal(result!.source, scraper);
  assertNote(result!, /matches the manual override, which can be retired/);
  assert.deepEqual(retirableOverrides(latest, input.overrides), [
    priceOverride({ price_local: '149.00' }),
  ]);
});

test('precedence: the scraper disagreeing with an override is a conflict, with both values in the record', () => {
  const result = mergeSingle({
    previous: record({ price_local: '149.00' }),
    observation: observation({ price_local: '149.00' }),
    entry: priceOverride({ price_local: '159.00' }),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.price_local, '149.00');
  assert.equal(result.source, scraper);
  assertNote(result, /the manual override says 159\.00 SEK/);
  assert.equal(isPublishable(result), false);
});

test('a disagreement is never resolved without an approval, whichever value is older', () => {
  for (const previous of [
    undefined,
    record({ price_local: '149.00' }),
    record({
      price_local: '159.00',
      source: 'manual',
      status: 'manual_override',
      price_source_text: null,
    }),
  ]) {
    const result = mergeSingle({
      previous,
      observation: observation({ price_local: '149.00' }),
      entry: priceOverride({ price_local: '159.00' }),
    });
    assert.equal(result.status, 'conflict');
    assert.equal(isPublishable(result), false);
  }
});

test('a conflict approved: the scraper value publishes as ok', () => {
  const result = mergeSingle({
    observation: observation({ price_local: '149.00' }),
    entry: priceOverride({ price_local: '159.00' }),
    approvals: [decision({ decision: 'approve', price_local: '149.00' })],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.price_local, '149.00');
  assert.equal(result.source, scraper);
});

test('a conflict rejected: the override publishes as manual_override when within 40% of the last published value', () => {
  const result = mergeSingle({
    previous: record({ price_local: '149.00' }),
    observation: observation({ price_local: '139.00' }),
    entry: priceOverride({ price_local: '159.00' }),
    approvals: [decision({ decision: 'reject', price_local: '139.00' })],
  });
  assert.equal(result.status, 'manual_override');
  assert.equal(result.price_local, '159.00');
  assert.equal(result.source, 'manual');
  assertNote(result, /scraped 139\.00 SEK was rejected/);
});

test('a conflict rejected: an override more than 40% from the last published value is needs_review until approved', () => {
  const spec = {
    previous: record({ price_local: '100.00' }),
    observation: observation({ price_local: '139.00' }),
    entry: priceOverride({ price_local: '150.00' }),
  };
  const rejected = decision({ decision: 'reject', price_local: '139.00' });
  const held = mergeSingle({ ...spec, approvals: [rejected] });
  assert.equal(held.status, 'needs_review');
  assert.equal(held.price_local, '150.00');
  assert.equal(held.source, 'manual');

  const approved = mergeSingle({
    ...spec,
    approvals: [
      rejected,
      decision({
        decision: 'approve',
        price_local: '150.00',
        source: 'manual',
      }),
    ],
  });
  assert.equal(approved.status, 'manual_override');
  assert.equal(approved.price_local, '150.00');
});

test('an approval of one conflicting value does not approve a later, different value', () => {
  const result = mergeSingle({
    observation: observation({ price_local: '155.00' }),
    entry: priceOverride({ price_local: '159.00' }),
    approvals: [decision({ decision: 'approve', price_local: '149.00' })],
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.price_local, '155.00');
});

test('an approval binds to the source too: a manual approval does not approve the scraper', () => {
  const result = mergeSingle({
    observation: observation({ price_local: '149.00' }),
    entry: priceOverride({ price_local: '159.00' }),
    approvals: [decision({ price_local: '149.00', source: 'manual' })],
  });
  assert.equal(result.status, 'conflict');
});

test('the last decision for a value counts', () => {
  const spec = {
    observation: observation({ price_local: '149.00' }),
    entry: priceOverride({ price_local: '159.00' }),
  };
  const approve = decision({ decision: 'approve', price_local: '149.00' });
  const reject = decision({ decision: 'reject', price_local: '149.00' });
  assert.equal(
    mergeSingle({ ...spec, approvals: [approve, reject] }).status,
    'manual_override',
  );
  assert.equal(
    mergeSingle({ ...spec, approvals: [reject, approve] }).status,
    'ok',
  );
});

// --- not_offered ----------------------------------------------------------

test('not_offered: the source saying "no price" never makes a plan not_offered; it stays missing', () => {
  for (const reason of ['source_no_price', 'not_on_source'] as const) {
    const result = mergeSingle({
      gap: gap({ reason, note: 'Not available here' }),
    });
    assert.equal(result.status, 'missing');
    assert.equal(result.missing_reason, reason);
    assert.equal(result.notes, 'Not available here');
  }
});

test('not_offered: only a founder-confirmed manual entry sets it, with its official URL', () => {
  const result = mergeSingle({
    gap: gap({ reason: 'not_on_source' }),
    entry: notOffered(),
  });
  assert.deepEqual(result, {
    market: 'SE',
    service_id: 'spotify',
    plan_id: 'individual',
    billing_period: 'month',
    price_local: null,
    price_source_text: null,
    currency: null,
    price_usd_source: null,
    source: 'manual',
    source_url: official,
    observed_at: null,
    source_verified_at: '2026-11-30',
    status: 'not_offered',
    missing_reason: null,
    notes: null,
  });
  assert.equal(isPublishable(result), false);
});

test('not_offered: a scraped price against the entry is a conflict showing both', () => {
  const result = mergeSingle({
    observation: observation(),
    entry: notOffered(),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.price_local, '149.00');
  assertNote(result, /the manual entry says this plan is not offered/);
  assert.equal(isPublishable(result), false);
});

test('not_offered conflict approved: the scraped price publishes as ok', () => {
  const result = mergeSingle({
    observation: observation(),
    entry: notOffered(),
    approvals: [decision({ decision: 'approve' })],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.price_local, '149.00');
});

test('not_offered conflict rejected: the plan stays not_offered', () => {
  const result = mergeSingle({
    observation: observation(),
    entry: notOffered(),
    approvals: [decision({ decision: 'reject' })],
  });
  assert.equal(result.status, 'not_offered');
  assert.equal(result.price_local, null);
});

// --- The checks -----------------------------------------------------------

test('the currency check: a value in another currency is needs_review, named in notes, and never approvable', () => {
  const eur = observation({
    price_local: '13.99',
    price_source_text: '€13.99',
    currency: 'EUR',
  });
  const result = mergeSingle({
    observation: eur,
    approvals: [decision({ price_local: '13.99', currency: 'EUR' })],
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.currency, 'EUR');
  assertNote(result, /Breaks the currency check: EUR is not SEK/);
  assertNote(result, /No approval can publish it/);
});

test('the price check: a price of zero is needs_review, named in notes, and never approvable', () => {
  const result = mergeSingle({
    observation: observation({
      price_local: '0.00',
      price_source_text: 'kr 0',
    }),
    approvals: [decision({ price_local: '0.00' })],
  });
  assert.equal(result.status, 'needs_review');
  assertNote(result, /Breaks the price check/);
});

test('a value that breaks a check is set aside when a manual override fills the gap', () => {
  const result = mergeSingle({
    observation: observation({ price_local: '0.00' }),
    entry: priceOverride({ price_local: '149.00' }),
  });
  assert.equal(result.status, 'manual_override');
  assert.equal(result.price_local, '149.00');
  assertNote(result, /scraped 0\.00 SEK was set aside/);
});

test('the billing-period check: an observation for a tracked plan in another billing period is refused', () => {
  assert.throws(
    () =>
      mergeSingle({
        observation: observation({ billing_period: 'year' }),
      }),
    (error: unknown) =>
      error instanceof MergeError && error.code === 'billing_period',
  );
  assert.throws(
    () => mergeSingle({ entry: priceOverride({ billing_period: 'year' }) }),
    (error: unknown) =>
      error instanceof MergeError && error.code === 'billing_period',
  );
});

test('an override in another currency than its market is refused, so nothing is built', () => {
  assert.throws(
    () =>
      mergeSingle({
        entry: priceOverride({ price_local: '13.99', currency: 'EUR' }),
      }),
    (error: unknown) =>
      error instanceof MergeError && error.code === 'override_currency',
  );
});

// --- The ±40% threshold ---------------------------------------------------

test('±40%: a change within 40% of the last published value is ok', () => {
  const result = mergeSingle({
    previous: record({ price_local: '129.00' }),
    observation: observation({ price_local: '149.00' }),
  });
  assert.equal(result.status, 'ok');
});

test('±40%: exactly 40% passes, and anything more is needs_review, up or down', () => {
  const cases: [string, PriceRecord['status']][] = [
    ['140.00', 'ok'],
    ['140.01', 'needs_review'],
    ['60.00', 'ok'],
    ['59.99', 'needs_review'],
  ];
  for (const [price, status] of cases) {
    const result = mergeSingle({
      previous: record({ price_local: '100.00' }),
      observation: observation({ price_local: price }),
    });
    assert.equal(result.status, status, price);
  }
  const flagged = mergeSingle({
    previous: record({ price_local: '100.00' }),
    observation: observation({ price_local: '140.01' }),
  });
  assertNote(
    flagged,
    /more than 40% from the last published value, 100\.00 SEK/,
  );
});

test('±40%: the threshold is configurable', () => {
  const result = mergeSingle({
    previous: record({ price_local: '100.00' }),
    observation: observation({ price_local: '115.00' }),
    settings: settings({ change_threshold_percent: 10 }),
  });
  assert.equal(result.status, 'needs_review');
  assertNote(result, /more than 10%/);
});

test('±40% approved: the new value publishes as ok', () => {
  const result = mergeSingle({
    previous: record({ price_local: '100.00' }),
    observation: observation({ price_local: '199.00' }),
    approvals: [decision({ price_local: '199.00' })],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.price_local, '199.00');
});

test('±40% rejected: the new value stays unpublished and the old value is not put back', () => {
  const result = mergeSingle({
    previous: record({ price_local: '100.00' }),
    observation: observation({ price_local: '199.00' }),
    approvals: [decision({ decision: 'reject', price_local: '199.00' })],
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.price_local, '199.00');
  assertNote(result, /rejected on 2026-12-01, so it stays unpublished/);
});

test('±40%: a value is compared only with an ok, manual_override or stale record', () => {
  const baselines: [PriceRecord, PriceRecord['status']][] = [
    [record({ price_local: '100.00', status: 'ok' }), 'needs_review'],
    [
      record({
        price_local: '100.00',
        status: 'manual_override',
        source: 'manual',
        price_source_text: null,
      }),
      'needs_review',
    ],
    [record({ price_local: '100.00', status: 'stale' }), 'needs_review'],
    [
      record({
        price_local: null,
        price_source_text: null,
        currency: null,
        price_usd_source: null,
        status: 'missing',
        missing_reason: 'not_on_source',
      }),
      'ok',
    ],
  ];
  for (const [previous, status] of baselines) {
    const result = mergeSingle({
      previous,
      observation: observation({ price_local: '199.00' }),
    });
    assert.equal(result.status, status, previous.status);
  }
});

test('±40%: a stale record keeps its value, which stays the baseline', () => {
  const previous = record({ price_local: '100.00', status: 'stale' });
  assert.equal(
    mergeSingle({
      previous,
      observation: observation({ price_local: '120.00' }),
    }).status,
    'ok',
  );
  assert.equal(
    mergeSingle({
      previous,
      observation: observation({ price_local: '150.00' }),
    }).status,
    'needs_review',
  );
});

test('a flagged value followed by a later scraped value stays needs_review, even back within 40%', () => {
  const flagged = record({
    price_local: '199.00',
    status: 'needs_review',
    notes: 'Changed by more than 40%.',
  });
  for (const price of ['199.00', '205.00', '100.00']) {
    const result = mergeSingle({
      previous: flagged,
      observation: observation({ price_local: price }),
    });
    assert.equal(result.status, 'needs_review', price);
    assertNote(result, /previous record was needs_review/);
  }
});

test('after a conflict, a new scraped value with no override left stays needs_review until approved', () => {
  const previous = record({ price_local: '149.00', status: 'conflict' });
  const held = mergeSingle({
    previous,
    observation: observation({ price_local: '149.00' }),
  });
  assert.equal(held.status, 'needs_review');
  const approved = mergeSingle({
    previous,
    observation: observation({ price_local: '149.00' }),
    approvals: [decision({ price_local: '149.00' })],
  });
  assert.equal(approved.status, 'ok');
});

test('an approval of the flagged value does not approve the different value a later run sees', () => {
  const result = mergeSingle({
    previous: record({ price_local: '199.00', status: 'needs_review' }),
    observation: observation({ price_local: '205.00' }),
    approvals: [decision({ price_local: '199.00' })],
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.price_local, '205.00');
});

test('an override within 40% of the last published value is manual_override with no approval', () => {
  const result = mergeSingle({
    previous: record({ price_local: '129.00' }),
    gap: gap(),
    entry: priceOverride({ price_local: '149.00' }),
  });
  assert.equal(result.status, 'manual_override');
  assert.equal(isPublishable(result), true);
});

test('an override with nothing to compare with is manual_override with no approval', () => {
  const result = mergeSingle({
    gap: gap(),
    entry: priceOverride({ price_local: '9999.00' }),
  });
  assert.equal(result.status, 'manual_override');
});

test('an override more than 40% from the last published value is needs_review, and review approve publishes it', () => {
  const spec = {
    previous: record({ price_local: '100.00' }),
    gap: gap(),
    entry: priceOverride({ price_local: '149.00' }),
  };
  const held = mergeSingle(spec);
  assert.equal(held.status, 'needs_review');
  assert.equal(held.price_local, '149.00');
  assert.equal(held.source, 'manual');
  assert.equal(isPublishable(held), false);

  const scraperApproval = mergeSingle({
    ...spec,
    approvals: [decision({ price_local: '149.00' })],
  });
  assert.equal(scraperApproval.status, 'needs_review');

  const approved = mergeSingle({
    ...spec,
    approvals: [decision({ price_local: '149.00', source: 'manual' })],
  });
  assert.equal(approved.status, 'manual_override');
});

test('a flagged override does not publish itself on a later build: it stays needs_review until approved', () => {
  const entry = priceOverride({ price_local: '149.00' });
  const flagged = mergeSingle({
    previous: record({ price_local: '100.00' }),
    gap: gap(),
    entry,
  });
  assert.equal(flagged.status, 'needs_review');
  for (const state of [
    { gap: gap() },
    { gap: gap({ reason: 'market_failed' }) },
  ]) {
    const later = mergeSingle({ previous: flagged, entry, ...state });
    assert.equal(later.status, 'needs_review');
    assert.equal(later.price_local, '149.00');
    assertNote(
      later,
      /previous record was needs_review, so a new value needs an approval/,
    );
  }
  const approved = mergeSingle({
    previous: flagged,
    gap: gap(),
    entry,
    approvals: [decision({ price_local: '149.00', source: 'manual' })],
  });
  assert.equal(approved.status, 'manual_override');
});

test('after a flagged record that shows a value, a new override needs an approval', () => {
  const previous = record({ price_local: '199.00', status: 'needs_review' });
  const held = mergeSingle({
    previous,
    gap: gap(),
    entry: priceOverride({ price_local: '149.00' }),
  });
  assert.equal(held.status, 'needs_review');
  assert.equal(held.source, 'manual');
  assert.equal(
    mergeSingle({
      previous,
      gap: gap(),
      entry: priceOverride({ price_local: '149.00' }),
      approvals: [decision({ price_local: '149.00', source: 'manual' })],
    }).status,
    'manual_override',
  );
});

test('a conflict whose scraped value then disappears does not publish the override without an approval', () => {
  const result = mergeSingle({
    previous: record({ price_local: '149.00', status: 'conflict' }),
    gap: gap({ reason: 'not_on_source' }),
    entry: priceOverride({ price_local: '159.00' }),
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.price_local, '159.00');
  assert.equal(isPublishable(result), false);
});

test('a conflict carried from an earlier build and then rejected leaves the override waiting for its own approval', () => {
  const spec = {
    previous: record({ price_local: '149.00', status: 'conflict' }),
    observation: observation({ price_local: '149.00' }),
    entry: priceOverride({ price_local: '159.00' }),
  };
  const reject = decision({ decision: 'reject', price_local: '149.00' });
  const held = mergeSingle({ ...spec, approvals: [reject] });
  assert.equal(held.status, 'needs_review');
  assert.equal(held.price_local, '159.00');
  assertNote(held, /scraped 149\.00 SEK was rejected/);
  const approved = mergeSingle({
    ...spec,
    approvals: [reject, decision({ price_local: '159.00', source: 'manual' })],
  });
  assert.equal(approved.status, 'manual_override');
});

test('after a flag, the scraper agreeing with an override still waits for an approval', () => {
  const spec = {
    previous: record({ price_local: '149.00', status: 'conflict' }),
    observation: observation({ price_local: '159.00' }),
    entry: priceOverride({ price_local: '159.00' }),
  };
  assert.equal(mergeSingle(spec).status, 'needs_review');
  assert.equal(
    mergeSingle({ ...spec, approvals: [decision({ price_local: '159.00' })] })
      .status,
    'ok',
  );
});

test('a value in another currency than the last published one needs an approval', () => {
  const result = mergeSingle({
    previous: record({ price_local: '1290', currency: 'ISK' }),
    observation: observation({ price_local: '149.00' }),
  });
  assert.equal(result.status, 'needs_review');
  assertNote(result, /in another currency/);
});

test('the scraper agreeing with an override more than 40% away is needs_review until approved', () => {
  const spec = {
    previous: record({ price_local: '100.00' }),
    observation: observation({ price_local: '149.00' }),
    entry: priceOverride({ price_local: '149.00' }),
  };
  assert.equal(mergeSingle(spec).status, 'needs_review');
  assert.equal(
    mergeSingle({ ...spec, approvals: [decision({ price_local: '149.00' })] })
      .status,
    'ok',
  );
});

// --- Staleness ------------------------------------------------------------

test('staleness: a scraped value goes stale 45 days after observed_at, and keeps its value', () => {
  const previous = record({ observed_at: '2026-11-01T09:30:00.000Z' });
  const failed = gap({ reason: 'market_failed' });
  const fresh = mergeSingle({
    previous,
    gap: failed,
    now: '2026-12-16T09:30:00.000Z',
  });
  assert.equal(fresh.status, 'ok');
  const stale = mergeSingle({
    previous,
    gap: failed,
    now: '2026-12-16T09:30:00.001Z',
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.price_local, '129.00');
  assert.equal(stale.observed_at, '2026-11-01T09:30:00.000Z');
  assertNote(stale, /not refreshed within 45 days/);
  assert.equal(isPublishable(stale), false);
});

test('staleness: a manual override goes stale 90 days after verified_at', () => {
  const entry = priceOverride({ verified_at: '2026-09-01' });
  assert.equal(
    mergeSingle({ gap: gap(), entry, now: '2026-11-30T23:59:59.999Z' }).status,
    'manual_override',
  );
  const stale = mergeSingle({
    gap: gap(),
    entry,
    now: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.price_local, '149.00');
  assertNote(stale, /not refreshed within 90 days/);
});

test('staleness: a not_offered entry goes stale 90 days after verified_at', () => {
  const stale = mergeSingle({
    gap: gap(),
    entry: notOffered({ verified_at: '2026-09-01' }),
    now: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.price_local, null);
});

test('staleness: the limits are configurable', () => {
  const result = mergeSingle({
    previous: record({ observed_at: '2026-11-01T09:30:00.000Z' }),
    gap: gap({ reason: 'market_failed' }),
    now: '2026-11-12T09:30:00.000Z',
    settings: settings({ stale_after_days: { scraped: 10, manual: 90 } }),
  });
  assert.equal(result.status, 'stale');
  assertNote(result, /within 10 days/);
});

test('staleness: needs_review, conflict and missing never go stale, so an open flag stays visible', () => {
  const long = '2027-06-01T00:00:00.000Z';
  const failed = gap({ reason: 'market_failed' });
  assert.equal(
    mergeSingle({
      previous: record({ status: 'needs_review' }),
      gap: failed,
      now: long,
    }).status,
    'needs_review',
  );
  assert.equal(
    mergeSingle({
      previous: record({ status: 'conflict' }),
      gap: failed,
      entry: priceOverride({
        price_local: '159.00',
        verified_at: '2027-05-30',
      }),
      now: long,
    }).status,
    'conflict',
  );
  assert.equal(
    mergeSingle({ gap: gap({ reason: 'not_on_source' }), now: long }).status,
    'missing',
  );
});

// --- Disappearance --------------------------------------------------------

test('disappearance: a plan the source no longer prices becomes needs_review with its last value in notes, never deleted', () => {
  for (const reason of ['not_on_source', 'source_no_price'] as const) {
    const result = mergeSingle({
      previous: record({ price_local: '129.00' }),
      gap: gap({ reason }),
    });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.price_local, null);
    assert.equal(result.source, scraper);
    assert.equal(
      result.notes,
      'Disappeared from the source; the last value was 129.00 SEK, observed 2026-11-01T09:30:00.000Z.',
    );
  }
});

test('disappearance stays open across builds, keeping its last value', () => {
  const first = mergeSingle({ previous: record(), gap: gap() });
  const second = mergeSingle({ previous: first, gap: gap() });
  assert.deepEqual(second, first);
  const failedRun = mergeSingle({
    previous: first,
    gap: gap({ reason: 'market_failed' }),
  });
  assert.equal(failedRun.status, 'needs_review');
  assert.equal(failedRun.notes, first.notes);
});

test('disappearance approved: the record becomes missing', () => {
  const result = mergeSingle({
    previous: record(),
    gap: gap({ reason: 'not_on_source' }),
    approvals: [decision({ price_local: null, currency: null })],
  });
  assert.equal(result.status, 'missing');
  assert.equal(result.missing_reason, 'not_on_source');
});

test('disappearance rejected: the record stays needs_review', () => {
  const result = mergeSingle({
    previous: record(),
    gap: gap(),
    approvals: [
      decision({ decision: 'reject', price_local: null, currency: null }),
    ],
  });
  assert.equal(result.status, 'needs_review');
  assertNote(result, /The disappearance was rejected/);
});

test('disappearance resolved by a manual entry: the override fills the gap', () => {
  const disappeared = mergeSingle({ previous: record(), gap: gap() });
  const result = mergeSingle({
    previous: disappeared,
    gap: gap(),
    entry: priceOverride({ price_local: '129.00' }),
  });
  assert.equal(result.status, 'manual_override');
  assert.equal(result.price_local, '129.00');
  const notOfferedNow = mergeSingle({
    previous: disappeared,
    gap: gap(),
    entry: notOffered(),
  });
  assert.equal(notOfferedNow.status, 'not_offered');
});

test('disappearance: the plan coming back ends it, and its value stays needs_review until approved', () => {
  const disappeared = mergeSingle({ previous: record(), gap: gap() });
  const back = mergeSingle({
    previous: disappeared,
    observation: observation({ price_local: '129.00' }),
  });
  assert.equal(back.status, 'needs_review');
  assert.equal(back.price_local, '129.00');
  const approved = mergeSingle({
    previous: disappeared,
    observation: observation({ price_local: '129.00' }),
    approvals: [decision({ price_local: '129.00' })],
  });
  assert.equal(approved.status, 'ok');
});

test('no disappearance where there was no scraped value before', () => {
  for (const previous of [
    undefined,
    record({
      price_local: null,
      price_source_text: null,
      currency: null,
      price_usd_source: null,
      status: 'missing',
      missing_reason: 'source_no_price',
    }),
    record({
      status: 'manual_override',
      source: 'manual',
      price_source_text: null,
    }),
  ]) {
    const result = mergeSingle({
      previous,
      gap: gap({ reason: 'not_on_source' }),
    });
    assert.equal(result.status, 'missing', previous?.status ?? 'none');
  }
});

// --- A failed page --------------------------------------------------------

test('a failed page keeps the previous scraped value with its old observed_at', () => {
  for (const reason of ['market_failed', 'parse_failed'] as const) {
    const result = mergeSingle({
      previous: record(),
      gap: gap({ reason, source_url: sweden }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.price_local, '129.00');
    assert.equal(result.observed_at, '2026-11-01T09:30:00.000Z');
    assertNote(result, new RegExp(`could not read the page \\(${reason}\\)`));
  }
});

test('a failed page keeps an open conflict, so the override never wins because a market failed', () => {
  const result = mergeSingle({
    previous: record({ price_local: '149.00', status: 'conflict' }),
    gap: gap({ reason: 'market_failed' }),
    entry: priceOverride({ price_local: '159.00' }),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.price_local, '149.00');
  assertNote(result, /the manual override says 159\.00 SEK/);
});

test('a failed page keeps an open needs_review flag', () => {
  const result = mergeSingle({
    previous: record({ price_local: '199.00', status: 'needs_review' }),
    gap: gap({ reason: 'parse_failed' }),
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.price_local, '199.00');
});

test("a retired override's value is not kept when the market fails", () => {
  const result = mergeSingle({
    previous: record({
      status: 'manual_override',
      source: 'manual',
      price_source_text: null,
    }),
    gap: gap({ reason: 'market_failed' }),
  });
  assert.equal(result.status, 'missing');
  assert.equal(result.missing_reason, 'market_failed');
});

test('a failed page with no previous value is missing with the failure as its reason', () => {
  const result = mergeSingle({ gap: gap({ reason: 'parse_failed' }) });
  assert.equal(result.status, 'missing');
  assert.equal(result.missing_reason, 'parse_failed');
  assert.equal(result.observed_at, null);
});

test('a plan the run has neither an observation nor a gap for is treated as a failed market', () => {
  assert.equal(mergeSingle({ previous: record() }).status, 'ok');
  const none = mergeSingle({});
  assert.equal(none.status, 'missing');
  assert.equal(none.missing_reason, 'market_failed');
});

// --- Inputs ---------------------------------------------------------------

test('a second observation, gap or manual entry for one record is refused', () => {
  const twice = (input: ReturnType<typeof singleInput>) =>
    assert.throws(
      () => mergePriceIndex(input),
      (error: unknown) =>
        error instanceof MergeError && error.code === 'duplicate_input',
    );
  const base = singleInput({});
  twice({
    ...base,
    run: { ...base.run, observations: [observation(), observation()] },
  });
  twice({ ...base, run: { ...base.run, gaps: [gap(), gap()] } });
  twice({
    ...base,
    run: { ...base.run, observations: [observation()], gaps: [gap()] },
  });
});

test('an invalid input file is refused before anything is merged', () => {
  const base = singleInput({});
  assert.throws(
    () =>
      mergePriceIndex({
        ...base,
        approvals: { approvals: [{ ...decision(), actor: '' }] },
      }),
    (error: unknown) =>
      error instanceof MergeError && error.code === 'invalid_input',
  );
  assert.throws(
    () =>
      mergePriceIndex({
        ...base,
        run: {
          ...base.run,
          observations: [observation({ price_local: '149' })],
        },
      }),
    (error: unknown) =>
      error instanceof MergeError && error.code === 'invalid_input',
  );
});

test('the merge is pure: the same input gives the same output and is not changed', () => {
  const input = singleInput({
    previous: record(),
    observation: observation({ price_local: '199.00' }),
    approvals: [decision({ decision: 'reject', price_local: '199.00' })],
  });
  const { clock, ...data } = input;
  const before = structuredClone(data);
  const first = mergePriceIndex(input);
  const second = mergePriceIndex({ ...data, clock });
  assert.deepEqual(first, second);
  assert.deepEqual(data, before);
});
