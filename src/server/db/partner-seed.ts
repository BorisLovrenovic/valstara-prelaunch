import type { DatabaseConnection } from './pool.ts';

// E11.7-15: the one read the local seed script (scripts/seed-partner-programme.ts)
// needs that no domain service returns. A partner application's confirmation
// link is issued inside the submit transaction and leaves it only in the
// queued email, so the seed reads the link's id back to confirm the
// application as its applicant would. Nothing in the application imports this.

export interface UnconfirmedApplication {
  readonly id: string;
  readonly confirmation_token_id: string;
}

export function createPartnerSeedRepository(database: DatabaseConnection) {
  return {
    /** The member's one unconfirmed application, with its link's id. */
    unconfirmedApplication(
      subscriberId: string,
    ): Promise<UnconfirmedApplication | null> {
      return database.readOne<UnconfirmedApplication>({
        text: `SELECT id, confirmation_token_id
          FROM partner
          WHERE subscriber_id = $1 AND status = 'unconfirmed'
            AND confirmation_token_id IS NOT NULL`,
        values: [subscriberId],
      });
    },
  };
}
