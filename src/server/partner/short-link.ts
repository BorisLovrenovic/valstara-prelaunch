import { DatabaseUnavailableError } from '../db/errors.ts';
import { createPartnerAttributionRepository } from '../db/partner-attribution.ts';
import type { DatabaseConnection } from '../db/pool.ts';
import { normaliseReferralCodeForLookup } from '../referral/code-registry.ts';
import { partnerAttributionEnabled } from '../referral/partner-perks.ts';

export async function partnerShortLink(
  database: DatabaseConnection,
  rawCode: string,
): Promise<Response> {
  const code = normaliseReferralCodeForLookup(rawCode);
  let location = '/';
  try {
    if (
      /^[A-Z0-9]{4,16}$/u.test(code) &&
      (await partnerAttributionEnabled(database))
    ) {
      const live =
        await createPartnerAttributionRepository(database).findLiveShortCode(
          code,
        );
      if (live !== null)
        location = '/?' + new URLSearchParams({ ref: live.code });
    }
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
  }
  return new Response(null, {
    status: 302,
    headers: { 'Cache-Control': 'no-store', Location: location },
  });
}
