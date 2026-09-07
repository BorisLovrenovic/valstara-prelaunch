/**
 * `geo` — turn Cloudflare's `CF-IPCountry` header into a **suggestion**, and
 * nothing more (`docs/modules/platform.md#geo`, ADR-018).
 *
 * The shape of this interface is the guardrail: there is exactly one export and
 * it returns a country code or `null`. **There is no method here that can decide
 * eligibility.** Detection prefills the country dropdown; the *confirmed* value
 * the person submits is what drives giveaway eligibility, the VAT story and the
 * access wave. Detection never decides silently.
 */

const CF_IP_COUNTRY_HEADER = 'CF-IPCountry';

// Cloudflare returns two-letter ISO 3166-1 alpha-2 codes, plus a few sentinels
// that are not countries: `XX` (unknown), `T1` (the client is on Tor). Neither
// is a place a person can be from, so both resolve to "no suggestion" and the
// selector renders unfilled rather than guessing.
const NON_COUNTRY_SENTINELS = new Set(['XX', 'T1']);

/**
 * Returns an uppercased ISO 3166-1 alpha-2 code when the header carries a
 * plausible country, or `null` when it is absent, a sentinel, or malformed. A
 * `null` result must render the selector unfilled — never a guessed default.
 *
 * The return is deliberately just the shape-valid code: membership of the
 * dropdown's country list is the caller's concern, so the module stays free of
 * any list it might be tempted to make a decision from.
 */
export function suggestCountry(headers: Headers): string | null {
  const raw = headers.get(CF_IP_COUNTRY_HEADER);
  if (raw === null) {
    return null;
  }

  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(code) || NON_COUNTRY_SENTINELS.has(code)) {
    return null;
  }

  return code;
}
