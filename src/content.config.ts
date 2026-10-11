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

const giveawayRules = defineCollection({
  loader: glob({
    base: './src/content/giveaway-rules',
    pattern: '*.md',
  }),
  schema: giveawayRulesSchema,
});

export const collections = { trust, legal, giveawayRules };
