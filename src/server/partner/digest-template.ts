import { emailCopy } from '../../copy/email.ts';
import { partnersCopy } from '../../copy/partners.ts';
import { verificationCopy } from '../../copy/verification.ts';
import { createPartnerDigestRepository } from '../db/partner-digest.ts';
import { createPartnerLeaderboardRepository } from '../db/partner-leaderboard.ts';
import type { DatabaseConnection } from '../db/pool.ts';
import type { TemplateRenderer } from '../email/service.ts';
import { renderEmailDocument } from '../email/template-layout.ts';
import { currentSurveyVersion } from '../survey/questions.ts';

import { dashboardRecoveryPath } from './config.ts';
import {
  partnerDigestFlagsOn,
  partnerDigestPeriodRange,
  readPartnerDigestNote,
  type PeriodLabel,
} from './digest.ts';

// E11.7-13: the partner digest's renderer. It is optional programme mail, a
// broadcast from the Brevo domain (D-071), so dispatch sends it only while
// `email.broadcast` is on. Its own dispatch check replaces the marketing
// consent check: the digest flags, an active and unpurged partner, a verified
// member record and the partner's optional-email choice, read again for every
// send. The email service checks suppression first. The mail holds counts
// only and names no one; it issues no dashboard link, because that would
// cancel the partner's current one, and links the replacement request.

export interface PartnerDigestData {
  readonly confirmedInPeriod: number;
  readonly confirmedTotal: number;
  readonly rank:
    | { readonly kind: 'ranked'; readonly rank: number; readonly asOf: string }
    | { readonly kind: 'unranked'; readonly asOf: string }
    | { readonly kind: 'unavailable' };
  readonly categories: Readonly<Record<string, number>>;
  readonly waitlistVerifiedInPeriod: number;
  readonly waitlistVerifiedTotal: number;
}

export interface PartnerDigestRendererDependencies {
  readonly baseUrl: string;
  readonly sendingDomain: string;
  /** The counts for the partner behind the status token, for the period. */
  readonly data: (input: {
    readonly statusTokenId: string;
    readonly start: Date;
    readonly end: Date;
  }) => Promise<PartnerDigestData | null>;
  /** The digest's dispatch consent check, in the dispatch transaction. */
  readonly eligible?: (
    connection: DatabaseConnection,
    subscriberId: string,
  ) => Promise<boolean>;
  readonly note?: () => string | null;
}

/** Reads the digest's counts from the database at dispatch. */
export function partnerDigestData(connection: DatabaseConnection) {
  return async (input: {
    readonly statusTokenId: string;
    readonly start: Date;
    readonly end: Date;
  }): Promise<PartnerDigestData | null> => {
    const counts = await createPartnerDigestRepository(connection).counts({
      ...input,
      surveyVersion: currentSurveyVersion,
    });
    if (counts === null) return null;
    const ranking = await createPartnerLeaderboardRepository(connection)
      .readOwnRank(counts.partner_id)
      .catch(() => null);
    return {
      confirmedInPeriod: counts.confirmed_in_period,
      confirmedTotal: counts.confirmed_total,
      rank:
        ranking === null
          ? { kind: 'unavailable' }
          : ranking.rank === null
            ? { kind: 'unranked', asOf: ranking.as_of.toISOString() }
            : {
                kind: 'ranked',
                rank: ranking.rank,
                asOf: ranking.as_of.toISOString(),
              },
      categories: counts.categories,
      waitlistVerifiedInPeriod: counts.waitlist_verified_in_period,
      waitlistVerifiedTotal: counts.waitlist_verified_total,
    };
  };
}

/** The digest's own dispatch consent check (D-071). */
export async function partnerDigestDispatchEligible(
  connection: DatabaseConnection,
  subscriberId: string,
): Promise<boolean> {
  if (!(await partnerDigestFlagsOn(connection))) return false;
  return createPartnerDigestRepository(connection).dispatchEligible(
    subscriberId,
  );
}

function periodName(label: PeriodLabel): string {
  const copy = partnersCopy.email.digest;
  return label.kind === 'month'
    ? copy.monthLabel(copy.months[label.month]!, label.year)
    : copy.weekLabel(label.week, label.year);
}

function rankLine(rank: PartnerDigestData['rank']): string {
  const copy = partnersCopy.email.digest;
  switch (rank.kind) {
    case 'ranked':
      return copy.rank(rank.rank, rank.asOf);
    case 'unranked':
      return copy.unranked(rank.asOf);
    case 'unavailable':
      return copy.rankUnavailable;
  }
}

export function partnerDigestRenderer(
  dependencies: PartnerDigestRendererDependencies,
): TemplateRenderer {
  const origin = new URL(dependencies.baseUrl).origin;
  const from = `${emailCopy.senderName} <hello@${dependencies.sendingDomain}>`;
  const note = dependencies.note ?? (() => readPartnerDigestNote());
  const eligible = dependencies.eligible ?? partnerDigestDispatchEligible;
  return {
    kind: 'broadcast',
    dispatchConsent: ({ connection, subscriberId, recipient }) =>
      recipient.status === 'verified'
        ? eligible(connection, subscriberId)
        : Promise.resolve(false),
    async render({ email, payload, token, unsubscribePageUrl }) {
      const { period, status_token_id: statusTokenId } = payload;
      if (
        typeof period !== 'string' ||
        typeof statusTokenId !== 'string' ||
        statusTokenId === ''
      )
        throw new Error('email_template_reference_missing');
      const range = partnerDigestPeriodRange(period);
      const founderNote = note();
      if (founderNote === null) throw new Error('partner_digest_note_missing');
      const data = await dependencies.data({
        statusTokenId,
        start: range.start,
        end: range.end,
      });
      if (data === null) throw new Error('email_token_missing');
      const status = new URL('/me', origin);
      status.searchParams.set('t', await token(statusTokenId));
      const copy = partnersCopy.email.digest;
      const name = periodName(range.label);
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: copy.subject(name),
          preheader: copy.preheader,
          paragraphs: [
            copy.firstLine(name),
            copy.noteHeading,
            founderNote,
            copy.dashboard,
            copy.choice,
          ],
          facts: [
            copy.confirmedInPeriod(name, data.confirmedInPeriod),
            copy.confirmedTotal(data.confirmedTotal),
            rankLine(data.rank),
            copy.categories,
            ...verificationCopy.survey.categoryOptions.map(({ label, value }) =>
              copy.category(label, data.categories[value] ?? 0),
            ),
            copy.waitlistInPeriod(name, data.waitlistVerifiedInPeriod),
            copy.waitlistTotal(data.waitlistVerifiedTotal),
          ],
          links: [
            {
              label: copy.action,
              url: new URL(dashboardRecoveryPath, origin).toString(),
            },
            { label: emailCopy.status, url: status.toString() },
          ],
        },
      });
    },
  };
}
