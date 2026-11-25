import {
  partnerOptionalMailAudience,
  partnerOptionalMailUnsuppressed,
} from './partner-digest.ts';
import type { DatabaseConnection } from './pool.ts';

// E11.7-16: who receives a partner announcement, and which of them already
// have it. The audience is the digest's, exactly (E11.7-13, D-071): an active,
// unpurged partner with a verified member record, an unsuppressed address and
// optional programme email turned on. Nothing here returns an address.

export const maxPartnerAnnouncementBatch = 100;

export interface PartnerAnnouncementCandidate {
  readonly partner_id: string;
  readonly subscriber_id: string;
}

function assertLimit(limit: number): void {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > maxPartnerAnnouncementBatch
  )
    throw new RangeError('Partner announcement batch is out of range.');
}

/** The business keys of one announcement, as a LIKE prefix. */
function keyPrefix(announcementId: string): string {
  // Announcement ids are lowercase letters, digits and hyphens only, so the
  // prefix holds no LIKE wildcard.
  return `partner-announcement:${announcementId}:`;
}

const notYetQueued = `NOT EXISTS (SELECT 1 FROM email_send e
  WHERE e.business_key = $1 || p.id::text)`;

export function createPartnerAnnouncementRepository(db: DatabaseConnection) {
  return {
    /** Partners in the audience who do not have this announcement yet. */
    async countDue(announcementId: string): Promise<number> {
      const row = await db.readOne<{ count: number }>({
        text: `SELECT count(*)::int AS count
          FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
          WHERE ${partnerOptionalMailAudience} AND ${partnerOptionalMailUnsuppressed}
            AND ${notYetQueued}`,
        values: [keyPrefix(announcementId)],
      });
      return row?.count ?? 0;
    },

    /** Emails already queued for this announcement, by any earlier run. */
    async countQueued(announcementId: string): Promise<number> {
      const row = await db.readOne<{ count: number }>({
        text: `SELECT count(*)::int AS count FROM email_send
          WHERE business_key LIKE $1 || '%'`,
        values: [keyPrefix(announcementId)],
      });
      return row?.count ?? 0;
    },

    due(
      announcementId: string,
      limit: number,
    ): Promise<readonly PartnerAnnouncementCandidate[]> {
      assertLimit(limit);
      return db.list<PartnerAnnouncementCandidate>(
        {
          text: `SELECT p.id AS partner_id, p.subscriber_id
            FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
            WHERE ${partnerOptionalMailAudience} AND ${partnerOptionalMailUnsuppressed}
              AND ${notYetQueued}
            ORDER BY p.id`,
          values: [keyPrefix(announcementId)],
        },
        limit,
      );
    },
  };
}
