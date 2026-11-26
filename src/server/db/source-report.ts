import type { DatabaseConnection } from './pool.ts';
import { countedSubscriberStatus } from './subscriber-maintenance.ts';

// E11.8-02: the per-platform signup report, as one aggregate query over the
// signups created in a range
// (docs/features/analytics.md#the-per-platform-signup-report-e118-02).
//
// The stored UTM values are visitor-supplied, so they are classified here, in
// the query, and only a label leaves the database: a source or medium on the
// convention list, a campaign matching the campaign pattern, `other` for any
// other value, or `(not set)` for an absent one. Values are trimmed of ASCII
// white space and lower-cased in the "C" collation, which changes only A–Z,
// so no non-ASCII character can be folded into a printable value. The query reads no row into
// the application one by one: it returns at most `limit` grouped rows of
// labels and counts, bounded by the `created_at` index.
//
// The regular expression is matched in the "C" collation too, so its ranges
// are ASCII ranges.
//
// Erased rows and pending erasures are not counted: an erased row holds no
// UTM, and a member who asked to be erased is not processed further.

/** Trimmed from both ends of a stored value: ASCII white space. */
const utmTrimmedCharacters = ' \t\n\v\f\r';

export interface SourceReportCounts {
  readonly signups: number;
  /** Signups whose subscriber is verified now (standing rule 2). */
  readonly verifiedSignups: number;
  /** Confirmed, non-voided referral edges those subscribers made. */
  readonly confirmedReferrals: number;
  /** Those subscribers who have answered the survey at least once. */
  readonly firstSurveyCompletions: number;
}

export interface SourceReportGroup extends SourceReportCounts {
  readonly withoutUtm: boolean;
  /** For a signup without UTM values: whether it carried a valid signed ref. */
  readonly signedRef: boolean | null;
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
}

interface GroupRow {
  readonly without_utm: boolean;
  readonly signed_ref: boolean | null;
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
  readonly signups: number;
  readonly verified_signups: number;
  readonly confirmed_referrals: number;
  readonly first_survey_completions: number;
}

export interface SourceReportQuery {
  /** The range's first instant, inclusive. */
  readonly start: Date;
  /** The instant after the range, exclusive. */
  readonly end: Date;
  readonly sources: readonly string[];
  readonly media: readonly string[];
  readonly campaignPattern: string;
  readonly labels: { readonly other: string; readonly notSet: string };
  /** The most grouped rows to return. */
  readonly limit: number;
}

export interface SourceReportRepository {
  groups(query: SourceReportQuery): Promise<readonly SourceReportGroup[]>;
}

export function createSourceReportRepository(
  database: DatabaseConnection,
): SourceReportRepository {
  return {
    async groups(query) {
      const rows = await database.list<GroupRow>(
        {
          text: `
            WITH signup AS (
              SELECT
                s.id,
                s.status,
                s.utm IS NULL AS without_utm,
                s.signup_had_ref,
                lower(btrim(s.utm->>'source', $9) COLLATE "C") COLLATE "default" AS source,
                lower(btrim(s.utm->>'medium', $9) COLLATE "C") COLLATE "default" AS medium,
                lower(btrim(s.utm->>'campaign', $9) COLLATE "C") COLLATE "default" AS campaign
              FROM subscriber s
              WHERE s.created_at >= $1 AND s.created_at < $2
                AND s.status NOT IN ('erasure_pending', 'erased')
            ),
            classified AS (
              SELECT
                sg.id,
                sg.status,
                sg.without_utm,
                CASE WHEN sg.without_utm THEN sg.signup_had_ref END
                  AS signed_ref,
                CASE
                  WHEN sg.without_utm THEN NULL
                  WHEN sg.source IS NULL OR sg.source = '' THEN $7
                  WHEN sg.source = ANY($3::text[]) THEN sg.source
                  ELSE $6
                END AS source,
                CASE
                  WHEN sg.without_utm THEN NULL
                  WHEN sg.medium IS NULL OR sg.medium = '' THEN $7
                  WHEN sg.medium = ANY($4::text[]) THEN sg.medium
                  ELSE $6
                END AS medium,
                CASE
                  WHEN sg.without_utm THEN NULL
                  WHEN sg.campaign IS NULL OR sg.campaign = '' THEN $7
                  WHEN sg.campaign COLLATE "C" ~ $5 THEN sg.campaign
                  ELSE $6
                END AS campaign
              FROM signup sg
            )
            SELECT
              c.without_utm,
              c.signed_ref,
              c.source,
              c.medium,
              c.campaign,
              count(*)::integer AS signups,
              count(*) FILTER (WHERE c.status = $8)::integer
                AS verified_signups,
              COALESCE(sum(r.confirmed), 0)::integer AS confirmed_referrals,
              count(*) FILTER (WHERE sr.first_answered_at IS NOT NULL)::integer
                AS first_survey_completions
            FROM classified c
            LEFT JOIN LATERAL (
              SELECT count(*) AS confirmed
              FROM referral_edge e
              WHERE e.referrer_id = c.id
                AND e.state = 'confirmed'
                AND e.voided_at IS NULL
            ) r ON true
            LEFT JOIN survey_response sr ON sr.subscriber_id = c.id
            GROUP BY c.without_utm, c.signed_ref, c.source, c.medium, c.campaign
            ORDER BY c.without_utm, signups DESC,
              c.source COLLATE "C", c.medium COLLATE "C",
              c.campaign COLLATE "C", c.signed_ref DESC
          `,
          values: [
            query.start,
            query.end,
            [...query.sources],
            [...query.media],
            query.campaignPattern,
            query.labels.other,
            query.labels.notSet,
            countedSubscriberStatus,
            utmTrimmedCharacters,
          ],
        },
        query.limit,
      );
      return rows.map((row) => ({
        withoutUtm: row.without_utm,
        signedRef: row.signed_ref,
        source: row.source,
        medium: row.medium,
        campaign: row.campaign,
        signups: row.signups,
        verifiedSignups: row.verified_signups,
        confirmedReferrals: row.confirmed_referrals,
        firstSurveyCompletions: row.first_survey_completions,
      }));
    },
  };
}
