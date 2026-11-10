import {
  composeBanner,
  type BannerShape,
  type ProviderBannerModel,
} from '../components/provider-banner.ts';
import type { Provider } from './provider-showcase.ts';

/** The final call to action's three logo-only banners, left to right (E11.5-11p). */
export interface LandingFinalList {
  banners: string[];
}

// Main.dc.html draws the three banners with the tonal compositions t5, t2
// and t1, left to right.
export const finalShapes = [
  't5',
  't2',
  't1',
] as const satisfies readonly BannerShape[];

/** Fails the build when the list is not three distinct showcase providers. */
export function validateLandingFinal(
  input: unknown,
  providers: readonly Pick<Provider, 'name'>[],
): LandingFinalList {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Landing final banners must be an object');
  const banners = (input as Record<string, unknown>).banners;
  if (
    !Array.isArray(banners) ||
    banners.length !== finalShapes.length ||
    !banners.every((name) => typeof name === 'string' && name.trim() !== '')
  )
    throw new Error(
      `Landing final banners must list ${finalShapes.length} providers`,
    );
  if (new Set(banners).size !== banners.length)
    throw new Error('Landing final banners repeat a provider');
  const showcase = new Set(providers.map((provider) => provider.name));
  for (const name of banners as string[]) {
    if (!showcase.has(name))
      throw new Error(`Landing final provider is not in the showcase: ${name}`);
  }
  return { banners: banners as string[] };
}

/**
 * Resolves the validated list against the showcase, composing each banner
 * with the shared catalogue function and its canvas composition.
 */
export function resolveLandingFinal(
  input: unknown,
  providers: readonly Provider[],
  logoSize: (logo: string) => { width: number; height: number } | null,
): ProviderBannerModel[] {
  return validateLandingFinal(input, providers).banners.map((name, index) =>
    composeBanner(
      providers.find((entry) => entry.name === name)!,
      finalShapes[index],
      logoSize,
    ),
  );
}
