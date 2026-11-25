import type { APIRoute } from 'astro';

import { getFlagService } from '../../server/flags/app-service.ts';
import { bundledTrustLedger } from '../../server/trust-ledger/bundled.ts';
import {
  trustLedgerCacheControl,
  trustLedgerSitemapXml,
} from '../../server/trust-ledger/route.ts';

// `/sitemaps/trust-ledger.xml` (E11.8-01, founder decision D-076 Q1): the
// Trust Ledger's child sitemap, rendered on request so it follows
// `trust_ledger.page`. It lists `/trust-ledger` only while the flag is on and
// an entry is committed, and is an empty <urlset> otherwise. The static
// `/sitemap.xml` index always lists it (`childSitemaps` in src/server/seo.ts).
export const prerender = false;

export const GET: APIRoute = async () =>
  new Response(
    trustLedgerSitemapXml(await getFlagService().list(), bundledTrustLedger()),
    {
      status: 200,
      headers: {
        'Cache-Control': trustLedgerCacheControl,
        'Content-Type': 'application/xml; charset=utf-8',
      },
    },
  );
