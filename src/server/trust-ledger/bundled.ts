import { createTrustLedger, type TrustLedger } from './ledger.ts';

// E11.8-01: the Trust Ledger entries bundled into the build. The site renders
// from these copies only, so an entry reaches the page, the sitemap and the
// links only through a merge and a deploy. Every page that calls this module
// at build (the prerendered pages, through the footer) validates the whole
// ledger, so an entry that fails its schema fails the build; the prebuild
// check (scripts/ci/trust-ledger-check.ts) reports the same problems first.
// No entry is committed until the founder's first, in December 2026.
const entryModules = import.meta.glob<unknown>(
  '/src/content/trust-ledger/*.json',
  { eager: true, import: 'default' },
);

let ledger: TrustLedger | undefined;

/** The build's Trust Ledger, validated once per process. */
export function bundledTrustLedger(): TrustLedger {
  ledger ??= createTrustLedger(
    Object.fromEntries(
      Object.entries(entryModules).map(([path, entry]) => [
        path.slice(path.lastIndexOf('/') + 1),
        entry,
      ]),
    ),
  );
  return ledger;
}
