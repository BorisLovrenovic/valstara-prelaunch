import type { Provider } from './provider-showcase.ts';

/** The three hero providers: the stack back to front, and the small-width strip left to right. */
export interface LandingHeroList {
  stack: string[];
  strip: string[];
}

/** One composed hero banner, resolved from the showcase entry it names. */
export interface HeroBanner {
  provider: Provider;
  shape: HeroShape;
  tone: BannerTone;
  foreground: BannerForeground;
  logoWidth: number;
  logoHeight: number;
}

// The wireframe draws the stack's three banners with the tonal shapes t3, t1
// and t2, back to front. A provider keeps its shape in the strip.
export const stackShapes = ['t3', 't1', 't2'] as const;
export type HeroShape = (typeof stackShapes)[number];
export type BannerTone = 'dark' | 'light' | 'ink';
export type BannerForeground = 'white' | 'ink';

const heroSize = stackShapes.length;
const inkHex = '#101014';

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

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [red, green, blue] = [value >> 16, (value >> 8) & 255, value & 255];
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** White or ink, whichever has the higher contrast on the brand colour. */
export function bannerForeground(brandColor: string): BannerForeground {
  const luminance = relativeLuminance(brandColor);
  const white = 1.05 / (luminance + 0.05);
  const ink = (luminance + 0.05) / (relativeLuminance(inkHex) + 0.05);
  return white >= ink ? 'white' : 'ink';
}

/** The tonal layer: white at 13% on near-black, white at 16% under white text, else ink at 10%. */
export function bannerTone(brandColor: string): BannerTone {
  if (relativeLuminance(brandColor) < 0.03) return 'dark';
  return bannerForeground(brandColor) === 'white' ? 'light' : 'ink';
}

/** The intrinsic width and height an SVG logo declares on its root element. */
export function svgIntrinsicSize(
  svg: string,
): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/u.exec(svg)?.[0] ?? '';
  const width = Number(/\bwidth="([\d.]+)"/u.exec(root)?.[1]);
  const height = Number(/\bheight="([\d.]+)"/u.exec(root)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Resolves the validated list against the showcase. `logoSize` returns a
 * logo's intrinsic size, so each image reserves its box before it loads; a
 * logo without one is drawn in a square.
 */
export function resolveLandingHero(
  input: unknown,
  providers: readonly Provider[],
  logoSize: (logo: string) => { width: number; height: number } | null,
): { stack: HeroBanner[]; strip: HeroBanner[] } {
  const list = validateLandingHero(input, providers);
  const banner = (name: string): HeroBanner => {
    const provider = providers.find((entry) => entry.name === name)!;
    const size = logoSize(provider.logo) ?? { width: 1, height: 1 };
    return {
      provider,
      shape: stackShapes[list.stack.indexOf(name)],
      tone: bannerTone(provider.brandColor),
      foreground: bannerForeground(provider.brandColor),
      logoWidth: size.width,
      logoHeight: size.height,
    };
  };
  return { stack: list.stack.map(banner), strip: list.strip.map(banner) };
}
