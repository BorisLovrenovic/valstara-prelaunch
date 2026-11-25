// E11.7-15: local sample data for the partner programme.
//
//   DATABASE_URL=<local app-role URL> EMAIL_TOKEN_SECRET=<the app's> \
//     npm run seed:partners -- [--json=<file>]
//
// For local use only. It refuses a database host other than this machine, a
// production environment, and a database it has already seeded. Every row is
// written through the domain services the site itself uses, with the same
// checks, audit records and queued (never dispatched) emails:
//
// - members at each stage of the coupon ladder (0, 2, 3, 7, 10, 21 and 39
//   confirmed referrals), with pending referrals, voids and an un-void;
// - partners of each type and in each lifecycle status, from an unconfirmed
//   application to an active, a paused, a terminated and a rejected partner;
// - partner referrals by `/r/{CODE}` link and by typed code, with retroactive
//   attribution, welcome discounts of 10%, 15% and 20% and the student
//   ambassador's 15% floor, pending and voided partner referrals, survey
//   answers for the dashboard's category breakdown, and the leaderboard.
//
// The first-signup band is narrowed to the first five verified members, so a
// sample of a few hundred shows members both inside and outside wave 1;
// production keeps ADR-025's 1,000. The verification-order window is written
// once at verification, so the narrowing stays consistent afterwards.
//
// The clock is the wall clock, strictly increasing, because the database
// stamps creation times itself (`subscriber.created_at`, `audit_log.at`) and
// every service timestamp must follow them. It prints, and with `--json`
// writes, the local links that open each sample state: they carry bearer
// tokens for sample people and are for this machine only.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPartnerDashboardRepository } from '../src/server/db/partner-dashboard.ts';
import { createPartnerSeedRepository } from '../src/server/db/partner-seed.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import { withTransaction } from '../src/server/db/transaction.ts';
import { createEmailQueue } from '../src/server/email/queue.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import { createPartnerActivationJob } from '../src/server/partner/activation.ts';
import { createPartnerSubmitService } from '../src/server/partner/application.ts';
import { createPartnerConfirmationService } from '../src/server/partner/confirm.ts';
import { createPartnerDashboardService } from '../src/server/partner/dashboard.ts';
import {
  emptyPartnerApplicationValues,
  parsePartnerApplication,
} from '../src/server/partner/fields.ts';
import { createPartnerLeaderboardJob } from '../src/server/partner/leaderboard.ts';
import { createPartnerFirstSignupJob } from '../src/server/partner/milestone-mail.ts';
import { partnerApplicationIpWindowMs } from '../src/server/partner/config.ts';
import { createPartnerReviewService } from '../src/server/partner/review.ts';
import { partnerShortLink } from '../src/server/partner/short-link.ts';
import { createPartnerWelcomeJob } from '../src/server/partner/welcome.ts';
import { consumeRateLimit } from '../src/server/ratelimit/consume.ts';
import {
  accessWindowBands,
  type AccessWindowBand,
} from '../src/server/referral/config.ts';
import { createPartnerCodeRules } from '../src/server/referral/partner-code.ts';
import { createReferralService } from '../src/server/referral/service.ts';
import { createReferralVoidService } from '../src/server/referral/void.ts';
import { createSignupService } from '../src/server/subscriber/signup.ts';
import { currentSurveyVersion } from '../src/server/survey/questions.ts';
import { createSurveyService } from '../src/server/survey/service.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { createVerificationService } from '../src/server/verification/service.ts';
import {
  deriveEmailToken,
  emailTokenSecret,
} from '../src/server/verification/token-derivation.ts';

/** The founder-command actor every seeded review decision records. */
export const seedActor = 'founder:local-seed';
/** The address domain of every sample person (RFC 6761's reserved `.test`). */
export const seedEmailDomain = 'partner-seed.example.test';
/** The verified members the narrowed first-signup band puts in wave 1. */
export const seedFirstWaveSize = 5;

const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Refuses anything but a database on this machine, outside production. */
export function assertLocalSeedTarget(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv,
): void {
  if (environment.NODE_ENV === 'production') {
    throw new Error('The partner seed never runs with NODE_ENV=production.');
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  if (!localHosts.has(host)) {
    throw new Error(
      `The partner seed runs only against a database on this machine, not ${host}.`,
    );
  }
}

// The band the seed verifies against: ADR-025's bands, with the first one
// narrowed so the sample includes members outside wave 1.
const seedBands: readonly AccessWindowBand[] = Object.freeze([
  { maximumVerificationOrder: seedFirstWaveSize, window: 'wave-1' },
  ...accessWindowBands.slice(1),
]);

const surveyCategories = [
  'ai',
  'subscriptions',
  'software',
  'gift_cards',
  'game_keys',
  'game_top_ups',
  'in_game_currency',
] as const;

export interface SeedLink {
  readonly label: string;
  readonly path: string;
}

export interface SeedManifest {
  readonly baseUrl: string;
  readonly members: readonly (SeedLink & {
    readonly key: string;
    readonly code: string;
  })[];
  readonly partners: readonly {
    readonly key: string;
    readonly label: string;
    readonly type: string;
    readonly status: string;
    readonly code: string | null;
    readonly dashboardPath: string | null;
    readonly flyerPath: string | null;
    readonly shortLinkPath: string | null;
  }[];
  readonly friends: readonly (SeedLink & { readonly key: string })[];
  readonly verifyReplays: readonly (SeedLink & { readonly key: string })[];
}

interface Verified {
  readonly id: string;
  readonly email: string;
  readonly verifyToken: string;
  readonly statusToken: string;
  readonly code: string;
}

/** Seeds the programme through the domain services; returns its links. */
export async function seedPartnerProgramme(
  database: DatabasePool,
  options: { readonly baseUrl: string },
): Promise<SeedManifest> {
  // The process's own secret, which the verification completion and every
  // other service here derive their tokens from, so each link opens.
  const tokenSecret = emailTokenSecret();
  let last = 0;
  // The wall clock, strictly increasing (see the header).
  const clock = () => {
    last = Math.max(last + 1, new Date().getTime());
    return new Date(last);
  };
  const flags = createFlagService(database);
  const referrals = createReferralService(database, { clock });
  const review = createPartnerReviewService(database, clock);
  const voids = createReferralVoidService(database, clock);
  const codeRules = createPartnerCodeRules(database);
  const seedRepository = createPartnerSeedRepository(database);
  const prefix = () => randomBytes(16).toString('hex');

  const pendingTokens = new Map<string, string>();
  const signup = createSignupService(database, {
    clock,
    attributeReferral: (referredId, code, allowAttribution, method) =>
      referrals.attribute(referredId, code, allowAttribution, method),
    isReferralEnabled: () => flags.isEnabled('referral.enabled'),
    raiseFraudFlag: async () => undefined,
    // Sample addresses use a reserved domain with no mail exchanger, so the
    // live MX screen is not consulted.
    screenEmailDomain: async () => ({ flags: [] }),
    sendVerificationMail: async (mail) => {
      pendingTokens.set(mail.businessKey, mail.verificationUrl);
    },
  });
  const complete = createVerificationCompletionService(database, {
    clock,
    accessWindowBands: seedBands,
  });
  const survey = createSurveyService(database, { clock, flags });

  let sequence = 0;
  const address = (role: string) => {
    sequence += 1;
    return `${role}-${String(sequence).padStart(3, '0')}@${seedEmailDomain}`;
  };

  /** A signup as the form makes it; returns the emailed verify token. */
  async function signUp(
    role: string,
    referral: {
      readonly code: string;
      readonly method: 'link' | 'code';
    } | null,
    marketing = false,
  ): Promise<{ id: string; email: string; verifyToken: string }> {
    const email = address(role);
    pendingTokens.clear();
    const outcome = await signup({
      email,
      marketingOptInVersion: marketing ? 'v1' : null,
      referralCode: referral?.code ?? null,
      referralMethod: referral?.method ?? 'link',
      hadSignedReferral: referral !== null,
      utm: null,
      signupIpPrefixHash: null,
      // The service hands the token to this callback; the queued mail keeps
      // only its id.
      verificationUrl: (token) => token,
    });
    if (outcome.kind !== 'created') {
      throw new Error(
        outcome.kind === 'existing' || outcome.kind === 'already_verified'
          ? 'This database already holds the partner seed; use a fresh one.'
          : `A sample signup was refused (${outcome.kind}).`,
      );
    }
    const [verifyToken] = [...pendingTokens.values()];
    if (verifyToken === undefined)
      throw new Error('A sample signup queued no verification link.');
    return { id: outcome.subscriber.id, email, verifyToken };
  }

  async function verify(pending: {
    id: string;
    email: string;
    verifyToken: string;
  }): Promise<Verified> {
    const completed = await complete(pending.verifyToken);
    if (
      completed.outcome !== 'verified' ||
      completed.statusToken === null ||
      completed.referralCode === null
    ) {
      throw new Error(`A sample verification ended ${completed.outcome}.`);
    }
    return {
      ...pending,
      statusToken: completed.statusToken,
      code: completed.referralCode,
    };
  }

  const member = async (role: string, marketing = false) =>
    verify(await signUp(role, null, marketing));

  let surveyIndex = 0;
  /**
   * A friend who signs up through `code` and, unless pending, verifies. A
   * partner's link is `/r/{CODE}`, followed as a visitor follows it: an
   * inactive code redirects with no referrer, and only a live one reaches
   * the signed capture. A member's link carries `?ref=` directly.
   */
  async function friend(
    code: string,
    settings: {
      readonly method?: 'link' | 'code';
      readonly partnerLink?: boolean;
      readonly pending?: boolean;
    } = {},
  ): Promise<{ id: string; verified: Verified | null }> {
    const method = settings.method ?? 'link';
    let referralCode: string | null = code;
    if (method === 'link' && settings.partnerLink === true) {
      const location = (await partnerShortLink(database, code)).headers.get(
        'location',
      );
      referralCode = new URL(location ?? '/', options.baseUrl).searchParams.get(
        'ref',
      );
    }
    const pending = await signUp(
      'friend',
      referralCode === null ? null : { code: referralCode, method },
    );
    if (settings.pending === true) return { id: pending.id, verified: null };
    const verified = await verify(pending);
    surveyIndex += 1;
    const outcome = await survey({
      token: verified.statusToken,
      ipPrefixHash: prefix(),
      version: currentSurveyVersion,
      answers: {
        category_preference: [
          surveyCategories[surveyIndex % surveyCategories.length]!,
        ],
        shopping_frequency: 'monthly',
      },
    });
    if (outcome !== 'saved')
      throw new Error(`A sample survey answer ended ${outcome}.`);
    return { id: verified.id, verified };
  }

  /** `count` friends, every third typing the code instead of the link. */
  async function friends(code: string, count: number, partnerLink = false) {
    const made = [];
    for (let index = 0; index < count; index += 1)
      made.push(
        await friend(code, {
          method: index % 3 === 2 ? 'code' : 'link',
          partnerLink,
        }),
      );
    return made;
  }

  async function voidReferral(referredId: string, reason: string) {
    await voids.voidReferral(referredId, reason, seedActor);
  }

  // ---------------------------------------------------------------------------
  // Partners: an application as the form submits it, confirmed by its link.
  const submit = createPartnerSubmitService(database, {
    clock,
    screenEmailDomain: async () => ({ flags: [] }),
    raiseFraudFlag: async () => undefined,
  });
  const confirm = createPartnerConfirmationService(database, {
    clock,
    isEnabled: () => flags.isEnabled('partners.enabled'),
    consumeIpRateLimit: (prefixHash, now) =>
      consumeRateLimit(
        database,
        `partner:confirm:ip:${prefixHash}`,
        partnerApplicationIpWindowMs,
        now,
      ),
    accessWindowBands: seedBands,
  });

  interface Application {
    readonly fullName: string;
    readonly type: 'standard' | 'student_ambassador' | 'creator';
    readonly code: string;
  }

  async function apply(
    application: Application,
    email: string,
    confirmed: boolean,
  ): Promise<{ partnerId: string; subscriberId: string }> {
    const check = await codeRules.check(application.code);
    const requestedCode =
      check.outcome === 'available' ? check.code : check.alternatives[0];
    if (requestedCode === undefined)
      throw new Error(`No sample code is available for ${application.code}.`);
    const parsed = parsePartnerApplication({
      ...emptyPartnerApplicationValues,
      fullName: application.fullName,
      email,
      countryOfResidence: 'SE',
      partnerType: application.type,
      channels: application.type === 'creator' ? ['tiktok', 'youtube'] : ['x'],
      handles: `@${requestedCode.toLowerCase()}`,
      audienceSize: application.type === 'creator' ? '10k_50k' : '1k_10k',
      promotionPlan: 'Short videos and a pinned link to the waitlist.',
      requestedCode,
      ageConfirmed: true,
      programmeTermsAgreed: true,
      university:
        application.type === 'student_ambassador' ? 'Sample University' : '',
    });
    if (!parsed.ok)
      throw new Error(
        `A sample application was refused: ${Object.keys(parsed.errors).join(', ')}.`,
      );
    const submitted = await submit({
      fields: parsed.fields,
      requestedCode,
      signupIpPrefixHash: null,
      challengeTimedOut: false,
    });
    if (submitted.kind !== 'accepted' || submitted.subscriberId === null)
      throw new Error(`A sample application ended ${submitted.kind}.`);
    const subscriberId = submitted.subscriberId;
    const unconfirmed =
      await seedRepository.unconfirmedApplication(subscriberId);
    if (unconfirmed === null)
      throw new Error('A sample application has no confirmation link.');
    if (confirmed) {
      const outcome = await confirm(
        deriveEmailToken(unconfirmed.confirmation_token_id, tokenSecret),
        prefix(),
      );
      if (outcome.kind !== 'confirmed')
        throw new Error(`A sample confirmation ended ${outcome.kind}.`);
    }
    return { partnerId: unconfirmed.id, subscriberId };
  }

  const contract = () => ({
    date: clock().toISOString().slice(0, 10),
    version: 'partner-v1',
    reference: 'sample-contract',
  });

  async function activate(partnerId: string): Promise<string> {
    const approved = await review.approve(partnerId, null, seedActor);
    if (approved.after.code === null)
      throw new Error('A sample approval registered no code.');
    await review.contractSent(partnerId, seedActor);
    await review.contractSigned(partnerId, contract(), seedActor);
    return approved.after.code;
  }

  // A dashboard link as the replacement request issues it: a new link
  // cancels every earlier one.
  async function dashboardLink(
    partnerId: string,
    subscriberId: string,
  ): Promise<string> {
    const issued = await withTransaction(database, async (connection) => {
      const link = await createVerificationService(connection, {
        clock,
        tokenSecret,
      }).issue(subscriberId, 'partner_dashboard');
      if (
        (await createPartnerDashboardRepository(connection).setCurrentLink(
          partnerId,
          link.id,
        )) !== 1
      )
        throw new Error('A sample dashboard link could not be set.');
      return link;
    });
    return issued.token;
  }

  const activation = createPartnerActivationJob(database, clock);
  async function drainActivation() {
    while ((await activation.run(100)) > 0) {
      // Each batch is capped; run until nothing is left.
    }
  }

  // ---------------------------------------------------------------------------
  // The run. The first five verified members fill the narrowed wave-1 band.
  const members: SeedManifest['members'][number][] = [];
  const statusPath = (token: string) => `/me?t=${encodeURIComponent(token)}`;
  const recordMember = (key: string, label: string, verified: Verified) =>
    members.push({
      key,
      label,
      code: verified.code,
      path: statusPath(verified.statusToken),
    });

  const early = [];
  for (let index = 0; index < seedFirstWaveSize; index += 1)
    early.push(await member('early'));
  recordMember(
    'first-signups-no-referrals',
    'Wave 1 as one of the first signups, no referrals',
    early[0]!,
  );

  const memberStages: readonly [string, string, number, boolean][] = [
    ['no-referrals', 'No referrals, not in wave 1', 0, false],
    ['two-referrals', '2 confirmed referrals: one more to wave 1', 2, false],
    ['three-referrals', '3 confirmed referrals: coupon 1 at 5%', 3, false],
    ['seven-referrals', '7 confirmed and 1 pending: coupon 1 at 10%', 7, false],
    [
      'ten-referrals',
      '10 confirmed with marketing consent: auto-invite candidate',
      10,
      true,
    ],
    [
      'twenty-one-referrals',
      '21 confirmed: coupon 1 at 30%, coupon 2 at 5%',
      21,
      false,
    ],
    ['thirty-nine-referrals', '39 confirmed: three coupons', 39, false],
  ];
  for (const [key, label, count, marketing] of memberStages) {
    const referrer = await member('member', marketing);
    await friends(referrer.code, count);
    if (key === 'seven-referrals')
      await friend(referrer.code, { pending: true });
    recordMember(key, label, referrer);
  }

  // Voids: 5 confirmed, 3 voided, so coupon 1 is void and wave 1 is lost.
  const voided = await member('member');
  const voidedFriends = await friends(voided.code, 5);
  for (const made of voidedFriends.slice(0, 3))
    await voidReferral(made.id, 'Sample void: one household');
  recordMember(
    'voided-below-threshold',
    '5 confirmed, 3 voided: coupon 1 void, below wave 1',
    voided,
  );
  // An un-void restores: 4 confirmed, 2 voided, 1 restored, back to 3.
  const restored = await member('member');
  const restoredFriends = await friends(restored.code, 4);
  for (const made of restoredFriends.slice(0, 2))
    await voidReferral(made.id, 'Sample void: under review');
  await voids.unvoidReferral(
    restoredFriends[0]!.id,
    'Sample un-void: review cleared',
    seedActor,
  );
  recordMember(
    'unvoided-restored',
    '4 confirmed, 2 voided, 1 restored: coupon 1 back at 5%',
    restored,
  );

  // ---------------------------------------------------------------------------
  // Partners.
  const partners: SeedManifest['partners'][number][] = [];
  const friendLinks: SeedManifest['friends'][number][] = [];
  const verifyReplays: SeedManifest['verifyReplays'][number][] = [];
  const live: { key: string; partnerId: string; subscriberId: string }[] = [];

  // The active creator: a member who referred three friends before applying,
  // so activation attributes those retroactively, then 41 partner friends,
  // which carries the welcome discount from 10% through 15% to 20%.
  const creator = await member('partner');
  const retroactive = await friends(creator.code, 3);
  const creatorApplication = await apply(
    { fullName: 'Maya Sample', type: 'creator', code: 'MAYASTUDIO' },
    creator.email,
    true,
  );
  const creatorCode = await activate(creatorApplication.partnerId);
  await drainActivation();
  const creatorFriends = [];
  for (let index = 0; index < 41; index += 1)
    creatorFriends.push(
      await friend(creatorCode, {
        method: index % 4 === 3 ? 'code' : 'link',
        partnerLink: true,
      }),
    );
  await friend(creatorCode, { partnerLink: true, pending: true });
  await friend(creatorCode, { partnerLink: true, pending: true });
  await voidReferral(creatorFriends[5]!.id, 'Sample void: repeated signup');
  await voidReferral(creatorFriends[6]!.id, 'Sample void: repeated signup');
  live.push({ key: 'active-creator', ...creatorApplication });
  friendLinks.push(
    {
      key: 'partner-friend-retroactive',
      label: 'Referred before the partner was approved: retroactive perks',
      path: statusPath(retroactive[0]!.verified!.statusToken),
    },
    {
      key: 'partner-friend-10',
      label: 'Joined through a partner at 10%',
      path: statusPath(creatorFriends[0]!.verified!.statusToken),
    },
    {
      key: 'partner-friend-15',
      label: 'Joined through a partner at 15%',
      path: statusPath(creatorFriends[25]!.verified!.statusToken),
    },
    {
      key: 'partner-friend-20',
      label: 'Joined through a partner at 20%',
      path: statusPath(creatorFriends[40]!.verified!.statusToken),
    },
    {
      key: 'partner-friend-voided',
      label: 'A voided partner referral: no perks',
      path: statusPath(creatorFriends[5]!.verified!.statusToken),
    },
  );
  verifyReplays.push(
    {
      key: 'verified-partner-friend',
      label:
        'Verification success for a partner-referred friend (replayed link)',
      path: `/verify?token=${encodeURIComponent(creatorFriends[40]!.verified!.verifyToken)}`,
    },
    {
      key: 'verified-member-friend',
      label:
        'Verification success for a member-referred friend (replayed link)',
      path: `/verify?token=${encodeURIComponent(voidedFriends[4]!.verified!.verifyToken)}`,
    },
  );

  // The active student ambassador: the 15% floor below 21 referrals.
  const ambassadorApplication = await apply(
    { fullName: 'Kai Sample', type: 'student_ambassador', code: 'KAICAMPUS' },
    address('partner'),
    true,
  );
  const ambassadorCode = await activate(ambassadorApplication.partnerId);
  const ambassadorFriends = await friends(ambassadorCode, 4, true);
  await voidReferral(
    ambassadorFriends[3]!.id,
    'Sample void: own second address',
  );
  live.push({ key: 'active-ambassador', ...ambassadorApplication });
  friendLinks.push({
    key: 'ambassador-friend-15',
    label: 'Joined through a student ambassador: the 15% floor',
    path: statusPath(ambassadorFriends[0]!.verified!.statusToken),
  });

  // The active standard partner.
  const standardApplication = await apply(
    { fullName: 'Lena Sample', type: 'standard', code: 'LENAPLAYS' },
    address('partner'),
    true,
  );
  const standardCode = await activate(standardApplication.partnerId);
  await friends(standardCode, 2, true);
  await friend(standardCode, { partnerLink: true, pending: true });
  live.push({ key: 'active-standard', ...standardApplication });

  // Paused: three partner friends, then a signup through the member's own
  // code after the pause, which is a plain member referral with no perks.
  const pausedMember = await member('partner');
  const pausedApplication = await apply(
    { fullName: 'River Sample', type: 'creator', code: 'RIVERNOTES' },
    pausedMember.email,
    true,
  );
  const pausedCode = await activate(pausedApplication.partnerId);
  await friends(pausedCode, 3, true);
  await review.pause(pausedApplication.partnerId, seedActor);
  await friend(pausedMember.code, { method: 'code' });
  live.push({ key: 'paused-creator', ...pausedApplication });

  // Terminated after one partner friend.
  const terminatedApplication = await apply(
    { fullName: 'Tomas Sample', type: 'standard', code: 'TOMASLIST' },
    address('partner'),
    true,
  );
  const terminatedCode = await activate(terminatedApplication.partnerId);
  await friends(terminatedCode, 1, true);
  // The link they held while active; termination cancels it, so it answers
  // as any cancelled link does.
  const terminatedBearer = await dashboardLink(
    terminatedApplication.partnerId,
    terminatedApplication.subscriberId,
  );
  await review.terminate(terminatedApplication.partnerId, seedActor);

  // The waiting statuses, and a rejection with its email.
  const approved = await apply(
    { fullName: 'Ivy Sample', type: 'standard', code: 'IVYPICKS' },
    address('partner'),
    true,
  );
  await review.approve(approved.partnerId, null, seedActor);
  const contractSent = await apply(
    { fullName: 'Noah Sample', type: 'student_ambassador', code: 'NOAHCAMPUS' },
    address('partner'),
    true,
  );
  await review.approve(contractSent.partnerId, null, seedActor);
  await review.contractSent(contractSent.partnerId, seedActor);
  const applied = await apply(
    { fullName: 'Zara Sample', type: 'creator', code: 'ZARAMAKES' },
    address('partner'),
    true,
  );
  const rejected = await apply(
    { fullName: 'Bruno Sample', type: 'creator', code: 'BRUNOCLIPS' },
    address('partner'),
    true,
  );
  await review.reject(rejected.partnerId, true, seedActor);
  const unconfirmed = await apply(
    { fullName: 'Ellie Sample', type: 'standard', code: 'ELLIEPICKS' },
    address('partner'),
    false,
  );

  // The jobs the maintenance worker runs: retroactive attribution, the
  // partner welcome, the first-signup email and the leaderboard snapshot.
  await drainActivation();
  const queue = createEmailQueue(database, clock);
  const welcome = createPartnerWelcomeJob(database, {
    clock,
    email: queue,
    tokenSecret,
  });
  while ((await welcome.run(100)) > 0) {
    // Capped batches until every live partner is welcomed.
  }
  const firstSignup = createPartnerFirstSignupJob(database, {
    clock,
    email: queue,
    tokenSecret,
  });
  while ((await firstSignup.run(100)) > 0) {
    // As above.
  }

  const dashboard = createPartnerDashboardService(database, {
    clock,
    isEnabled: () => flags.isEnabled('partners.enabled'),
    tokenSecret,
  });
  async function saveSettings(
    bearer: string,
    settings: {
      readonly displayName: string;
      readonly show: boolean;
      readonly optionalEmail: boolean;
    },
  ) {
    const read = await dashboard.read(bearer);
    if (read.kind !== 'authenticated')
      throw new Error(`A sample dashboard read ended ${read.kind}.`);
    const form = new FormData();
    form.set('settings_token', read.settingsToken);
    form.set('display_name', settings.displayName);
    if (settings.show) form.set('show_on_leaderboard', 'yes');
    if (settings.optionalEmail) form.set('nonessential_email_enabled', 'yes');
    const saved = await dashboard.save(form, prefix());
    if (saved.kind !== 'saved')
      throw new Error(`A sample settings save ended ${saved.kind}.`);
  }

  // A fresh link for each partner who can open the dashboard.
  const bearers = new Map<string, string>([
    ['terminated-standard', terminatedBearer],
  ]);
  for (const entry of live)
    bearers.set(
      entry.key,
      await dashboardLink(entry.partnerId, entry.subscriberId),
    );
  await saveSettings(bearers.get('active-creator')!, {
    displayName: 'Maya Studio',
    show: true,
    optionalEmail: true,
  });
  await saveSettings(bearers.get('active-ambassador')!, {
    displayName: 'Kai Campus',
    show: false,
    optionalEmail: true,
  });
  await createPartnerLeaderboardJob(
    database,
    () => flags.isEnabled('partners.enabled'),
    clock,
  ).run();

  const codes = new Map<string, string>([
    ['active-creator', creatorCode],
    ['active-ambassador', ambassadorCode],
    ['active-standard', standardCode],
    ['paused-creator', pausedCode],
    ['terminated-standard', terminatedCode],
  ]);
  const describe = [
    [
      'active-creator',
      'Active creator, 41 partner referrals',
      'creator',
      'active',
    ],
    [
      'active-ambassador',
      'Active student ambassador at the 15% floor',
      'student_ambassador',
      'active',
    ],
    ['active-standard', 'Active standard partner', 'standard', 'active'],
    ['paused-creator', 'Paused creator', 'creator', 'paused'],
    [
      'terminated-standard',
      'Terminated: the link held while active answers as a cancelled link',
      'standard',
      'terminated',
    ],
  ] as const;
  for (const [key, label, type, status] of describe) {
    const bearer = encodeURIComponent(bearers.get(key)!);
    const code = codes.get(key)!;
    partners.push({
      key,
      label,
      type,
      status,
      code,
      dashboardPath: `/partners/dashboard?t=${bearer}`,
      flyerPath: `/partners/dashboard/flyer?t=${bearer}`,
      shortLinkPath: `/r/${code}`,
    });
  }
  for (const [key, label, type, status] of [
    ['approved-standard', 'Approved, code inactive', 'standard', 'approved'],
    [
      'contract-sent-ambassador',
      'Contract sent',
      'student_ambassador',
      'contract_sent',
    ],
    ['applied-creator', 'Applied, waiting for review', 'creator', 'applied'],
    ['rejected-creator', 'Rejected, with the email', 'creator', 'rejected'],
    [
      'unconfirmed-standard',
      'Submitted, link not confirmed',
      'standard',
      'unconfirmed',
    ],
  ] as const)
    partners.push({
      key,
      label,
      type,
      status,
      code: null,
      dashboardPath: null,
      flyerPath: null,
      shortLinkPath: null,
    });
  // Keep the waiting partners' ids referenced, so a refactor that drops one
  // of them fails here rather than silently.
  for (const made of [approved, contractSent, applied, rejected, unconfirmed])
    if (made.partnerId === '') throw new Error('A sample partner has no id.');

  return {
    baseUrl: options.baseUrl,
    members,
    partners,
    friends: friendLinks,
    verifyReplays,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '')
    throw new Error(
      'DATABASE_URL is required (the app role, as the app uses).',
    );
  assertLocalSeedTarget(databaseUrl, process.env);
  const tokenSecret = process.env.EMAIL_TOKEN_SECRET;
  if (tokenSecret === undefined || tokenSecret.length < 32)
    throw new Error(
      "EMAIL_TOKEN_SECRET is required: the local app's own value, so the links open.",
    );
  // The queued emails' links and the printed links use the app's base URL.
  process.env.EMAIL_BASE_URL ??= 'http://localhost:4321';
  const baseUrl = process.env.EMAIL_BASE_URL;
  const json = process.argv
    .slice(2)
    .find((argument) => argument.startsWith('--json='))
    ?.slice('--json='.length);

  const database = createPool(databaseUrl);
  try {
    const manifest = await seedPartnerProgramme(database, { baseUrl });
    if (json !== undefined)
      await writeFile(json, `${JSON.stringify(manifest, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    const lines = [
      'Partner programme sample data seeded. Local links (this machine only):',
      ...manifest.members.map(
        (entry) => `  member  ${entry.label}: ${baseUrl}${entry.path}`,
      ),
      ...manifest.friends.map(
        (entry) => `  friend  ${entry.label}: ${baseUrl}${entry.path}`,
      ),
      ...manifest.partners.map((entry) =>
        entry.dashboardPath === null
          ? `  partner ${entry.label} (${entry.status})`
          : `  partner ${entry.label}: ${baseUrl}${entry.dashboardPath}`,
      ),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    await database.close();
  }
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  import.meta.url === pathToFileURL(resolve(invoked)).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
