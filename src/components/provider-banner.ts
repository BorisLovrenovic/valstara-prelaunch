import type { Provider } from '../content/provider-showcase.ts';

// The wireframe's six tonal shapes. The catalogue cycles them across every
// banner in order; the hero stack draws t3, t1 and t2.
export const bannerShapes = ['t1', 't2', 't3', 't4', 't5', 't6'] as const;
export type BannerShape = (typeof bannerShapes)[number];
export type BannerTone = 'dark' | 'light' | 'ink';
export type BannerForeground = 'white' | 'ink';

/** One composed provider banner: its data, shape, computed colours and logo size. */
export interface ProviderBannerModel {
  provider: Provider;
  shape: BannerShape;
  tone: BannerTone;
  foreground: BannerForeground;
  chipTone: 'light' | 'dark';
  logoWidth: number;
  logoHeight: number;
}

const inkHex = '#101014';

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

/** The catalogue's shape for the banner at this position, cycling t1 to t6. */
export function catalogueShape(index: number): BannerShape {
  return bannerShapes[index % bannerShapes.length];
}

/**
 * Composes one banner for the catalogue or the hero. `logoSize` returns a
 * logo's intrinsic size, so each image reserves its box before it loads; a
 * logo without one (the square AION2 raster) is drawn in a square.
 */
export function composeBanner(
  provider: Provider,
  shape: BannerShape,
  logoSize: (logo: string) => { width: number; height: number } | null,
): ProviderBannerModel {
  const size = logoSize(provider.logo) ?? { width: 1, height: 1 };
  return {
    provider,
    shape,
    tone: bannerTone(provider.brandColor),
    foreground: bannerForeground(provider.brandColor),
    chipTone: provider.chipTone === 'dark' ? 'dark' : 'light',
    logoWidth: size.width,
    logoHeight: size.height,
  };
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
