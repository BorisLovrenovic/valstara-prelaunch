import {
  composeBanner,
  type BannerShape,
  type ProviderBannerModel,
} from '../components/provider-banner.ts';
import type { Provider } from './provider-showcase.ts';

// The banner colour and logo-size helpers moved to the shared provider banner
// module (E11.5-11d); they stay importable from here.
export {
  bannerForeground,
  bannerTone,
  relativeLuminance,
  svgIntrinsicSize,
} from '../components/provider-banner.ts';

/** The three hero providers: the stack back to front, and the small-width strip left to right. */
export interface LandingHeroList {
  stack: string[];
  strip: string[];
}

/** One composed hero banner, resolved from the showcase entry it names. */
export type HeroBanner = ProviderBannerModel;

// The wireframe draws the stack's three banners with the tonal shapes t3, t1
// and t2, back to front. A provider keeps its shape in the strip.
export const stackShapes = [
  't3',
  't1',
  't2',
] as const satisfies readonly BannerShape[];

const heroSize = stackShapes.length;

function names(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== heroSize ||
    !value.every((name) => typeof name === 'string' && name.trim() !== '')
  )
    throw new Error(`Landing hero ${label} must list ${heroSize} providers`);
  if (new Set(value).size !== value.length)
    throw new Error(`Landing hero ${label} repeats a provider`);
  return value as string[];
}

/** Fails the build when the hero list names a provider the showcase does not have. */
export function validateLandingHero(
  input: unknown,
  providers: readonly Pick<Provider, 'name'>[],
): LandingHeroList {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Landing hero must be an object');
  const entry = input as Record<string, unknown>;
  const stack = names(entry.stack, 'stack');
  const strip = names(entry.strip, 'strip');
  const showcase = new Set(providers.map((provider) => provider.name));
  for (const name of [...stack, ...strip]) {
    if (!showcase.has(name))
      throw new Error(`Landing hero provider is not in the showcase: ${name}`);
  }
  if (!strip.every((name) => stack.includes(name)))
    throw new Error('Landing hero strip must show the stack providers');
  return { stack, strip };
}

/**
 * Resolves the validated list against the showcase, composing each banner
 * with the shared catalogue function and its stack shape.
 */
export function resolveLandingHero(
  input: unknown,
  providers: readonly Provider[],
  logoSize: (logo: string) => { width: number; height: number } | null,
): { stack: HeroBanner[]; strip: HeroBanner[] } {
  const list = validateLandingHero(input, providers);
  const banner = (name: string): HeroBanner =>
    composeBanner(
      providers.find((entry) => entry.name === name)!,
      stackShapes[list.stack.indexOf(name)],
      logoSize,
    );
  return { stack: list.stack.map(banner), strip: list.strip.map(banner) };
}
