import { campaignFlagRegistry } from '../flags/registry.ts';
import type { Flag } from '../flags/types.ts';
import { urlsetXml } from '../seo.ts';

import type { TrustLedger } from './ledger.ts';

// E11.8-01, founder decision 1 (D-076 Q1): `/trust-ledger` and its child
// sitemap follow `trust_ledger.page` on every request. The page answers 404
// while the flag is off or while no entry is committed, so an empty Ledger is
// never shown; the sitemap lists the page only while it would answer 200.
// The flag is read through the flag service, whose lookup failure returns the
// code default (off): a failure hides the page, never shows it.

export const trustLedgerPath = '/trust-ledger';

export function trustLedgerPageEnabled(flags: readonly Flag[]): boolean {
  return (
    flags.find((flag) => flag.key === 'trust_ledger.page')?.enabled ??
    campaignFlagRegistry['trust_ledger.page']
  );
}

/** Whether `/trust-ledger` answers 200: the flag is on and an entry exists. */
export function trustLedgerVisible(
  flags: readonly Flag[],
  ledger: Pick<TrustLedger, 'published'>,
): boolean {
  return trustLedgerPageEnabled(flags) && ledger.published;
}

// The page is shown only with its default-off flag on, a non-default flag
// state, which the site always serves `private, no-store`; and so an
// incident switch-off takes effect within the flag cache's five seconds,
// with nothing left in an edge cache.
export const trustLedgerCacheControl = 'private, no-store';

/** `/sitemaps/trust-ledger.xml`: the page while visible, else empty. */
export function trustLedgerSitemapXml(
  flags: readonly Flag[],
  ledger: Pick<TrustLedger, 'published'>,
): string {
  return urlsetXml(
    trustLedgerVisible(flags, ledger) ? [{ path: trustLedgerPath }] : [],
  );
}
