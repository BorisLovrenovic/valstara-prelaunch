import { getConfig } from '../config.ts';
import { getFlagService } from '../flags/app-service.ts';
import { createReferralCaptureService } from '../referral/capture.ts';

import {
  createRenderCache,
  priceRenderCacheMaxEntries,
  serveCachedRender,
  type RenderCacheDependencies,
  type RenderCacheRequest,
} from './render.ts';

let dependencies: RenderCacheDependencies | undefined;

/** The process-lifetime render cache the middleware serves through. */
export function serveRender(
  request: RenderCacheRequest,
  next: () => Promise<Response>,
): Promise<Response> {
  dependencies ??= {
    cache: createRenderCache(),
    priceCache: createRenderCache(priceRenderCacheMaxEntries),
    flags: () => getFlagService().list(),
    referral: createReferralCaptureService(getConfig().referralSigningSecret),
  };
  return serveCachedRender(request, next, dependencies);
}
