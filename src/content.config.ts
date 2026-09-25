import { defineCollection } from 'astro/content/config';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const trust = defineCollection({
  loader: glob({
    base: './src/content',
    pattern: '{legit,guarantee,about}.md',
  }),
  schema: z.object({
    portTarget: z.enum(['/legit', '/guarantee', '/about']),
  }),
});

const legal = defineCollection({
  loader: glob({
    base: './src/content',
    pattern: '{terms,privacy}.md',
  }),
  schema: z.object({
    portTarget: z.enum(['/terms', '/privacy']),
  }),
});

export const collections = { trust, legal };
