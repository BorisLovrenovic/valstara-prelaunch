import { readFile } from 'node:fs/promises';
import { validateLandingFinal } from '../../src/content/landing-final.ts';
import { validateLandingHero } from '../../src/content/landing-hero.ts';
import { validateProviderShowcase } from '../../src/content/provider-showcase.ts';

const entries: unknown = JSON.parse(
  await readFile('src/content/provider-showcase.json', 'utf8'),
);
const providers = await validateProviderShowcase(entries);
// E11.5-11c: the hero's three providers must be showcase entries.
validateLandingHero(
  JSON.parse(await readFile('src/content/landing-hero.json', 'utf8')),
  providers,
);
// E11.5-11p: so must the final call to action's three banners.
validateLandingFinal(
  JSON.parse(await readFile('src/content/landing-final.json', 'utf8')),
  providers,
);
