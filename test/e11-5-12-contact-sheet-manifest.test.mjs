import assert from 'node:assert/strict';
import test from 'node:test';

import { campaignFlagRegistry } from '../src/server/flags/registry.ts';
import { designWidths } from '../scripts/design/layout-checks.mjs';
import { emailPreviewRenderers } from '../scripts/design/email-previews.ts';
import {
  buildEmailManifest,
  buildManifest,
  coverageGaps,
  dockWidths,
  entryPath,
  flagAnalysis,
  landingFlags,
  placeholderContext,
  recordingWidths,
  rulesRoutesOf,
} from '../scripts/design/full-contact-sheet.mjs';
import { sourcePagePaths } from './helpers/page-inventory.mjs';

// E11.5-12 build item 1: the full contact sheet's manifest is complete, every
// page and every state, none sampled. Browser-free: it checks the manifest the
// capture script runs, against the E11-05 rendered-page inventory.

const { routes } = await sourcePagePaths();
const manifest = buildManifest({ rulesRoutes: rulesRoutesOf(routes) });
const labelsOf = (kind) =>
  manifest.filter((entry) => entry.kind === kind).map((entry) => entry.label);

test('every route in the E11-05 inventory is covered, and nothing outside it', () => {
  assert.deepEqual(coverageGaps(manifest, routes), {
    uncovered: [],
    unknown: [],
  });
  // Every published rules revision is in the inventory and on the sheet.
  const revisions = routes.filter((route) =>
    route.startsWith('/giveaway/rules/'),
  );
  assert.ok(revisions.length >= 3);
  for (const route of revisions)
    assert.ok(
      manifest.some((entry) => entry.covers === route),
      `${route} is captured`,
    );
});

test('a route dropped from the manifest, or one the inventory lacks, is reported', () => {
  // Planted drift in each direction, so the equality above cannot pass over
  // a gap.
  assert.deepEqual(
    coverageGaps(
      manifest.filter((entry) => entry.covers !== '/dsr'),
      routes,
    ),
    { uncovered: ['/dsr'], unknown: [] },
  );
  assert.deepEqual(
    coverageGaps(
      manifest.filter((entry) => entry.kind !== 'error'),
      routes,
    ),
    { uncovered: ['/404', '/500'], unknown: [] },
  );
  assert.deepEqual(
    coverageGaps(
      [...manifest, { label: 'retired', covers: '/retired' }],
      routes,
    ),
    { uncovered: [], unknown: ['/retired'] },
  );
  // A rules revision published later joins the inventory: the manifest built
  // without it is reported incomplete.
  const later = '/giveaway/rules/VAL-GW-LAUNCH-20991231-r1';
  assert.deepEqual(coverageGaps(manifest, [...routes, later].sort()), {
    uncovered: [later],
    unknown: [],
  });
});

test('each entry opens the page it says it covers, with a unique, filename-safe label', () => {
  const labels = manifest.map((entry) => entry.label);
  assert.equal(new Set(labels).size, labels.length, 'labels are unique');
  const context = placeholderContext();
  for (const entry of manifest) {
    assert.match(entry.label, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, entry.label);
    assert.ok(routes.includes(entry.covers), `${entry.label} covers a route`);
    const url = new URL(entryPath(entry, context), 'http://sheet.test');
    if (entry.kind === 'error') continue;
    assert.equal(url.pathname, entry.covers, `${entry.label} opens its route`);
    for (const key of Object.keys(entry.flags ?? {}))
      assert.ok(Object.hasOwn(campaignFlagRegistry, key), key);
    if (entry.widths !== undefined)
      for (const width of entry.widths) assert.ok(designWidths.includes(width));
  }
  // The error pages: an unknown URL answers the 404 page with its status,
  // and the prerendered 500 page is opened at /500 with its status.
  const errors = manifest.filter((entry) => entry.kind === 'error');
  assert.deepEqual(
    errors.map((entry) => [
      entry.covers,
      entryPath(entry, context),
      entry.status,
    ]),
    [
      ['/404', '/not-a-page', 404],
      ['/500', '/500', 500],
    ],
  );
  assert.ok(!routes.includes('/not-a-page'));
});

test('the landing page is captured in every combination of the four flags it reads', () => {
  // Every registered flag is analysed, and the landing variants are exactly
  // the flags the analysis names as landing variants.
  assert.deepEqual(
    Object.keys(flagAnalysis).sort(),
    Object.keys(campaignFlagRegistry).sort(),
  );
  assert.deepEqual(
    Object.entries(flagAnalysis)
      .filter(([, why]) => why.startsWith('landing variant'))
      .map(([key]) => key)
      .sort(),
    [...landingFlags].sort(),
  );
  const landing = manifest.filter((entry) => entry.kind === 'landing-flag');
  assert.equal(landing.length, 2 ** landingFlags.length);
  const combinations = new Set(
    landing.map((entry) => {
      assert.deepEqual(
        Object.keys(entry.flags).sort(),
        [...landingFlags].sort(),
      );
      assert.equal(entry.path, '/');
      assert.equal(entry.widths, undefined, 'every width');
      return landingFlags.map((key) => entry.flags[key]).join();
    }),
  );
  assert.equal(combinations.size, 2 ** landingFlags.length);
});

test('all 17 signup states, and every sticky-bar state at the widths the bar exists', () => {
  assert.deepEqual(labelsOf('signup'), [
    'signup-01-idle',
    'signup-02-focused',
    'signup-03-inline-error-empty',
    'signup-04-inline-error-invalid',
    'signup-05-blocked-domain',
    'signup-06-security-check-in-progress',
    'signup-07-submitting',
    'signup-08-security-check-visible',
    'signup-09-check-failed',
    'signup-10-network-error',
    'signup-11-unavailable',
    'signup-12-rate-limited',
    'signup-13-success-first-60-seconds',
    'signup-14-success-after-60-seconds',
    'signup-15-success-re-sent',
    'signup-16-javascript-disabled',
    'signup-17-signups-paused',
  ]);
  for (const entry of manifest.filter((item) => item.kind === 'signup'))
    assert.equal(entry.widths, undefined, `${entry.label} at every width`);
  const signup = Object.fromEntries(
    manifest
      .filter((entry) => entry.kind === 'signup')
      .map((entry) => [entry.label, entry]),
  );
  assert.equal(
    signup['signup-16-javascript-disabled'].javaScriptEnabled,
    false,
  );
  assert.equal(
    signup['signup-17-signups-paused'].flags['signup.enabled'],
    false,
  );
  assert.equal(
    signup['signup-06-security-check-in-progress'].turnstile,
    'pending',
  );
  assert.equal(
    signup['signup-08-security-check-visible'].turnstile,
    'interactive',
  );

  // The bar shows below 48rem only (the sticky-bar suite's visibility matrix).
  assert.deepEqual(dockWidths, [320, 360, 390]);
  assert.deepEqual(labelsOf('signup-sticky'), [
    'signup-sticky-entry',
    'signup-sticky-focus-while-tabbing',
    'signup-sticky-inline-error',
    'signup-sticky-checking',
    'signup-sticky-submitting',
    'signup-sticky-success',
    'signup-sticky-footer-in-view-bar-hidden',
    'signup-sticky-entry-giveaway-off',
  ]);
  for (const entry of manifest.filter(
    (item) => item.kind === 'signup-sticky',
  )) {
    assert.deepEqual(entry.widths, dockWidths, entry.label);
    assert.equal(
      entry.fullPage,
      false,
      `${entry.label}: the viewport it docks to`,
    );
  }
});

test('every /verify, /me, leaderboard, task and error state is on the sheet', () => {
  assert.deepEqual(labelsOf('verify'), [
    'verify-confirm',
    'verify-success',
    'verify-success-link-copied-survey-saved',
    'verify-success-copy-failed-survey-skipped',
    'verify-success-survey-answers-selected',
    'verify-success-survey-invalid-option',
    'verify-success-survey-server-error',
    'verify-success-referral-off',
    'verify-success-survey-off',
    'verify-success-referral-and-survey-off',
    'verify-invalid',
    'verify-invalid-new-link-sent',
    'verify-invalid-new-link-check-failed',
    'verify-invalid-new-link-network-error',
    'verify-invalid-javascript-disabled',
  ]);
  assert.deepEqual(labelsOf('me'), [
    'me-dashboard',
    'me-zero',
    'me-no-giveaway-entries',
    'me-preferences-saved-survey-open',
    'me-marketing-error',
    'me-copy-failed',
    'me-share-available',
    'me-survey-off',
    'me-recovery',
    'me-recovery-javascript-disabled',
    'me-recovery-sent',
    'me-recovery-check-failed',
    'me-left-waitlist',
    'me-dashboard-unavailable',
  ]);
  assert.deepEqual(labelsOf('leaderboard'), [
    'leaderboard-ten-rows',
    'leaderboard-three-rows',
    'leaderboard-empty',
    'leaderboard-loading',
    'leaderboard-unavailable',
    'leaderboard-paused-poll',
    'leaderboard-paused-flag-off',
  ]);
  assert.deepEqual(labelsOf('task'), [
    'dsr-export-request',
    'dsr-delete-request',
    'dsr-export-confirm',
    'dsr-delete-confirm',
    'dsr-export-accepted',
    'dsr-export-check-failed',
    'dsr-export-unavailable',
    'dsr-export-invalid-link',
    'dsr-export-link-used',
    'dsr-delete-pending',
    'dsr-delete-rate-limited',
    'unsubscribe-confirm',
    'unsubscribe-invalid-link',
    'unsubscribe-invalid-post',
    'unsubscribe-unavailable',
    'unsubscribe-complete',
    'unsubscribe-rate-limited',
    'award-checks',
    'award-checks-country-error',
    'award-no-link-unavailable',
    'award-exhausted',
    'award-replaced',
    'award-substitution',
    'award-substitution-invalid',
    'award-confirmed',
  ]);
  assert.deepEqual(labelsOf('error'), [
    'error-404-not-found',
    'error-500-server-error',
  ]);
  // The trust and legal pages, and the current and archived rules.
  assert.deepEqual(
    manifest
      .filter((entry) => entry.kind === 'document')
      .map((entry) => entry.covers),
    [
      '/legit',
      '/guarantee',
      '/about',
      '/terms',
      '/privacy',
      '/privacy/storage',
    ],
  );
  assert.deepEqual(
    manifest
      .filter((entry) => entry.kind === 'rules')
      .map((entry) => entry.covers),
    rulesRoutesOf(routes),
  );
  // The flag-off states are captured with their flag off.
  const flagged = Object.fromEntries(
    manifest.map((entry) => [entry.label, entry.flags ?? {}]),
  );
  assert.equal(flagged['me-dashboard-unavailable']['member.dashboard'], false);
  assert.equal(flagged['me-survey-off']['survey.enabled'], false);
  assert.equal(
    flagged['leaderboard-paused-flag-off']['leaderboard.public'],
    false,
  );
  assert.equal(
    flagged['verify-success-referral-off']['referral.enabled'],
    false,
  );
  for (const label of labelsOf('task').filter((name) =>
    name.startsWith('award-'),
  ))
    assert.equal(flagged[label]['giveaway.open'], true, label);
});

test('the motion review records one page per inventory route, at 390 and 1440', () => {
  assert.deepEqual(recordingWidths, [390, 1440]);
  const recorded = manifest.filter((entry) => entry.record);
  assert.deepEqual(
    recorded.map((entry) => entry.covers).sort(),
    [...routes].sort(),
  );
});

test('every registered email template has a preview on the sheet', () => {
  const emails = buildEmailManifest();
  assert.deepEqual(
    emails.map((entry) => entry.template).sort(),
    [...emailPreviewRenderers('https://valstara.com').keys()].sort(),
  );
  assert.ok(emails.length >= 10);
  const labels = [...manifest, ...emails].map((entry) => entry.label);
  assert.equal(new Set(labels).size, labels.length);
});
