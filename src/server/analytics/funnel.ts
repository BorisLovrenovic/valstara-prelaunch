import type { UtmParameters } from '../referral/capture.ts';
import type { EventProps } from './registry.ts';

type SourceBucket = EventProps<'signup_submitted'>['source_bucket'];

const mediumBuckets: Readonly<Record<string, SourceBucket>> = {
  email: 'email',
  newsletter: 'email',
  social: 'social',
  cpc: 'paid',
  ppc: 'paid',
  paid: 'paid',
  paid_social: 'paid',
  display: 'paid',
  organic: 'organic',
  referral: 'referral',
};

/** Classify only the signed server capture; never emit a raw UTM value. */
export function sourceBucket(
  utm: UtmParameters | null,
  hasValidRef: boolean,
): SourceBucket {
  const medium = utm?.medium?.trim().toLowerCase();
  if (medium) return mediumBuckets[medium] ?? 'other';
  if (hasValidRef) return 'referral';
  if (utm !== null && Object.keys(utm).length > 0) return 'other';
  return 'direct';
}

export function hoursToVerifyBucket(
  createdAt: Date,
  verifiedAt: Date,
): EventProps<'verified'>['hours_to_verify_bucket'] {
  const hours =
    Math.max(0, verifiedAt.getTime() - createdAt.getTime()) / 3_600_000;
  if (hours < 1) return 'under_1';
  if (hours < 24) return '1_to_24';
  if (hours < 72) return '24_to_72';
  return 'over_72';
}

export function referrerTierBucket(
  tier: number,
): EventProps<'referral_confirmed'>['referrer_tier_bucket'] {
  if (tier < 1) return 'none';
  if (tier === 1) return 'tier_1';
  return 'tier_2_or_higher';
}
