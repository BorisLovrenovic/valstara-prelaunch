/**
 * Email normalisation and the uniqueness rule (E3-01).
 *
 * The normalised form is the subscriber uniqueness key; the raw form is what is
 * displayed and mailed. Every write path MUST call this before any uniqueness
 * check — normalising after the check would let `user+a@gmail.com` and
 * `u.s.e.r@gmail.com` register as two people, which is the cheapest referral
 * attack the campaign has (`docs/modules/subscriber.md`,
 * `docs/features/fraud-review.md`).
 */

// Deliberately strict and deliberately not trimming: a surrounding-whitespace
// address is invalid, never silently repaired. Full schema validation and the
// closed error set are E3-02's; this is the shape gate normalisation relies on.
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

// Google delivers gmail.com and googlemail.com to the same mailbox and ignores
// dots in the local part. Dot-stripping is Gmail-family behaviour ONLY; every
// other provider keeps its dots. The family list is deliberately not extended
// into cross-domain canonicalisation (googlemail.com is not rewritten to
// gmail.com) — that behaviour is unspecified and out of scope.
const gmailFamilyDomains = new Set(['gmail.com', 'googlemail.com']);

export interface NormalisedEmail {
  /** Exactly as entered. What we display and mail to. */
  readonly raw: string;
  /** The uniqueness key. Lowercased, `+tag` stripped, Gmail-family dots removed. */
  readonly normalised: string;
  /** Denormalised, lowercased domain — for blocklist and analytics queries. */
  readonly domain: string;
}

/**
 * Returns the normalised representation of `raw`, or `null` when the address is
 * malformed. Never throws — Unicode and internationalised domains are handled
 * as ordinary text.
 */
export function normaliseEmail(raw: string): NormalisedEmail | null {
  if (!emailShape.test(raw)) {
    return null;
  }

  const atIndex = raw.lastIndexOf('@');
  // toLowerCase (not toLocaleLowerCase) is locale-independent, so a Turkish
  // locale cannot turn "I" into a dotless "ı" and split one mailbox in two.
  const domain = raw.slice(atIndex + 1).toLowerCase();
  let local = raw.slice(0, atIndex).toLowerCase();

  const plusIndex = local.indexOf('+');
  if (plusIndex !== -1) {
    local = local.slice(0, plusIndex);
  }

  if (gmailFamilyDomains.has(domain)) {
    local = local.replaceAll('.', '');
  }

  // Stripping a `+tag` or all dots can empty the local part (`+tag@gmail.com`,
  // `.@gmail.com`); there is no such mailbox, so the address is malformed.
  if (local === '') {
    return null;
  }

  return { raw, normalised: `${local}@${domain}`, domain };
}
