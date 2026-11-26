import { defineCollection } from 'astro/content/config';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { giveawayRulesSchema } from './server/giveaway/rules.ts';

const trust = defineCollection({
  loader: glob({
    base: './src/content',
    pattern: '{legit,guarantee,about}.md',
  }),
  schema: z.object({
    portTarget: z.enum(['/legit', '/guarantee', '/about']),
    title: z.string().min(1),
    description: z.string().min(1),
  }),
});

const legal = defineCollection({
  loader: glob({
    base: './src/content',
    pattern: '{terms,privacy,privacy-storage}.md',
  }),
  schema: z.object({
    portTarget: z.enum(['/terms', '/privacy', '/privacy/storage']),
  }),
});

// E11.6-13: the price index's methodology, at its permanent URL. Every
// statement in it is reconciled with the code and configuration it
// describes (test/price-index/price-index-methodology.test.ts).
const priceIndex = defineCollection({
  loader: glob({
    base: './src/content',
    pattern: 'price-index-methodology.md',
  }),
  schema: z.object({
    portTarget: z.enum(['/price-index']),
    title: z.string().min(1),
    description: z.string().min(1),
  }),
});

// E11.8-01: the Trust Ledger's "How we count", P11 Part 1 as written. Its
// entries are data files in src/content/trust-ledger/, bundled and validated
// by src/server/trust-ledger/bundled.ts, not a collection: none is committed
// before December 2026, and an empty collection warns on every read.
const trustLedger = defineCollection({
  loader: glob({
    base: './src/content',
    pattern: 'trust-ledger-how-we-count.md',
  }),
  schema: z.object({
    portTarget: z.enum(['/trust-ledger']),
    title: z.string().min(1),
    description: z.string().min(1),
  }),
});

const giveawayRules = defineCollection({
  loader: glob({
    base: './src/content/giveaway-rules',
    pattern: '*.md',
  }),
  schema: giveawayRulesSchema,
});

export const collections = {
  trust,
  legal,
  priceIndex,
  trustLedger,
  giveawayRules,
};
