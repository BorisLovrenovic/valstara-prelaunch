// The coupon ladder and wave 1 in words (E11.7-04). Every figure is passed in
// from the referral configuration; no number is written here.

const referrals = (count: number) =>
  `${count} more confirmed ${count === 1 ? 'referral' : 'referrals'}`;

/** "21 and 39", "21, 39 and 57". */
const list = (values: readonly (number | string)[]) =>
  values.length < 2
    ? values.join('')
    : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;

export const referralLadderCopy = {
  separator: ' · ',
  coupon: (number: number, percent: number) => `Coupon ${number}: ${percent}%`,
  couponName: (number: number) => `Coupon ${number}`,
  percent: (percent: number) => `${percent}%`,
  /** The next step raises the coupon the member already holds. */
  nextPercent: (remaining: number, percent: number) =>
    `${referrals(remaining)} to ${percent}%`,
  /** The next step unlocks a new coupon. */
  nextCoupon: (remaining: number, number: number, percent: number) =>
    `${referrals(remaining)} to Coupon ${number} at ${percent}%`,
  complete: 'The ladder is complete',
  /** ADR-012's messaging rule: what makes a coupon usable, and for how long. */
  held: (expiryYears: number) =>
    `Coupons become usable once one of your referred friends places their first order, and last ${expiryYears} years after launch.`,
  heldShort:
    'Usable once one of your referred friends places their first order.',
  heldState: 'Held',
  nextAt: (target: number) => `At ${target} confirmed referrals`,
  // A drawn pill is one unbroken line, so the month is stated beside it.
  earlyAccessPill: 'Early access',
  partnerWelcome: {
    named: 'You joined through ',
    namedBenefits: (month: string, percent: number) =>
      `: early access from ${month} and ${percent}% off your first order.`,
    retained: (month: string, percent: number) =>
      `Your partner referral gives you early access from ${month} and ${percent}% off your first order.`,
  },
  waveOne: {
    firstMembers: (month: string, firstMembers: string) =>
      `You're in wave 1, with early access from ${month}, as one of the first ${firstMembers} verified members.`,
    referrals: (month: string, threshold: number) =>
      `You're in wave 1, with early access from ${month}, for reaching ${threshold} confirmed referrals.`,
    activePartner: (month: string) =>
      `You're in wave 1, with early access from ${month}, as an active partner.`,
    partnerReferral: (month: string) =>
      `You're in wave 1, with early access from ${month}, through a partner referral.`,
    other: (month: string) =>
      `You're in wave 1, with early access from ${month}.`,
    notYet: (month: string, remaining: number) =>
      `You don't have early access yet. ${referrals(remaining)} and you get early access in ${month}.`,
  },
  landing: {
    /** Read by assistive technology; the drawn equation is aria-hidden. */
    sentence: (
      threshold: number,
      percent: number,
      earlyAccessMonth: string | null,
    ) =>
      earlyAccessMonth === null
        ? `${threshold} confirmed referrals → a ${percent}% coupon`
        : `${threshold} confirmed referrals → early access in ${earlyAccessMonth} and a ${percent}% coupon`,
    couponLabel: 'coupon',
    steps: (
      stepPercent: number,
      stepReferrals: number,
      maximumPercent: number,
    ) =>
      `Each coupon rises ${stepPercent}% every ${stepReferrals} more confirmed referrals, up to ${maximumPercent}%.`,
    moreCoupons: (numbers: readonly number[], unlocks: readonly number[]) =>
      `Coupon${numbers.length === 1 ? '' : 's'} ${list(numbers)} ${numbers.length === 1 ? 'unlocks' : 'unlock'} at ${list(unlocks)}.`,
    /** The card's own, shorter statement of ADR-012's condition. */
    held: (expiryYears: number) =>
      `Coupons apply once a referred friend places a first order, for ${expiryYears} years after launch.`,
    waveOne: (threshold: number, month: string) =>
      `${threshold} confirmed referrals also give you early access in ${month}.`,
    earlyAccessOpens: (month: string) => `Early access opens in ${month}.`,
  },
} as const;
