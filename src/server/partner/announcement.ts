import { createAuditService } from '../audit/service.ts';
import { createCampaignFlagRepository } from '../db/campaign-flags.ts';
import {
  createPartnerAnnouncementRepository,
  maxPartnerAnnouncementBatch,
} from '../db/partner-announcement.ts';
import { createPartnerDigestRepository } from '../db/partner-digest.ts';
import type { DatabaseConnection, DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { createEmailQueue } from '../email/queue.ts';
import type { QueueEmailInput } from '../email/service.ts';
import { campaignFlagRegistry, type FlagKey } from '../flags/registry.ts';
import { partnerAttributionEnabledForWrite } from '../referral/partner-perks.ts';
import { createVerificationService } from '../verification/service.ts';

import {
  PartnerAnnouncementError,
  readPartnerAnnouncement,
} from './announcement-content.ts';
import {
  partnerAnnouncementBusinessKey,
  partnerAnnouncementTemplate,
} from './config.ts';

// E11.7-16: the founder's `partners announce --id <id> [--dry-run]`, behind
// the admin API (E5-03a). A run queues one email per eligible partner, in
// batches of at most 100, under `partner-announcement:{id}:{partner_id}`, so a
// repeat run or a run after a restart queues only the partners still due and
// never sends twice. Each queue re-checks the flags and the digest's audience
// inside its own transaction, under the subscriber, programme-flag-row and
// partner locks the digest takes. A run stops after a bounded number of
// batches and reports how many partners remain; running the command again
// continues. Every run, dry or not, is audited with the actor, the
// announcement id and the counts.

export const partnerAnnouncementBatchLimit = maxPartnerAnnouncementBatch;
/**
 * Batches one request queues before it returns; the founder re-runs to
 * continue. Five batches of 100 finish well inside the command line's 30-second
 * request timeout, so the founder always sees the counts.
 */
export const maxPartnerAnnouncementBatchesPerRun = 5;

/** The flags that must all be on for an announcement to be queued or sent. */
export const partnerAnnouncementFlags = [
  'partners.enabled',
  'partners.announcements',
  'email.broadcast',
] as const satisfies readonly FlagKey[];

/** The announcement flags that are off, read with code defaults. */
export async function partnerAnnouncementFlagsOff(
  connection: DatabaseConnection,
): Promise<readonly FlagKey[]> {
  const rows = await createCampaignFlagRepository(connection).list(
    partnerAnnouncementFlags,
  );
  return partnerAnnouncementFlags.filter(
    (key) =>
      !(
        rows.find((row) => row.key === key)?.enabled ??
        campaignFlagRegistry[key]
      ),
  );
}

// No parameter properties: the maintenance worker runs this file under
// Node's type stripping, which accepts erasable syntax only.
export class PartnerAnnouncementRefusedError extends Error {
  public readonly refusal: 'not_found' | 'invalid' | 'flags_off';
  public readonly details: readonly string[];

  public constructor(
    refusal: 'not_found' | 'invalid' | 'flags_off',
    details: readonly string[] = [],
  ) {
    super(`partner_announcement_refused_${refusal}`);
    this.name = 'PartnerAnnouncementRefusedError';
    this.refusal = refusal;
    this.details = details;
  }
}

export type PartnerAnnouncementRunResult =
  | {
      readonly announcementId: string;
      readonly dryRun: true;
      /** Partners a run would queue now. */
      readonly due: number;
    }
  | {
      readonly announcementId: string;
      readonly dryRun: false;
      /** Emails this run queued. */
      readonly queued: number;
      /** Emails earlier runs had already queued for this announcement. */
      readonly alreadyQueued: number;
      /** Partners still due after this run; run the command again for them. */
      readonly remaining: number;
    };

export interface PartnerAnnouncementService {
  run(input: {
    readonly id: string;
    readonly dryRun: boolean;
    readonly actor: string;
    readonly requestId?: string;
  }): Promise<PartnerAnnouncementRunResult>;
}

export interface PartnerAnnouncementServiceDependencies {
  readonly clock: () => Date;
  readonly tokenSecret?: string;
  readonly queue?: (
    input: QueueEmailInput,
    connection: DatabaseConnection,
  ) => Promise<boolean>;
  /** The announcements folder; the checked-in one by default. */
  readonly directory?: string;
  readonly batchLimit?: number;
  readonly maxBatches?: number;
}

class AlreadyQueued extends Error {}

export function createPartnerAnnouncementService(
  database: DatabasePool,
  dependencies: PartnerAnnouncementServiceDependencies,
): PartnerAnnouncementService {
  const { clock } = dependencies;
  const batchLimit = dependencies.batchLimit ?? partnerAnnouncementBatchLimit;
  const maxBatches =
    dependencies.maxBatches ?? maxPartnerAnnouncementBatchesPerRun;
  if (
    !Number.isInteger(batchLimit) ||
    batchLimit < 1 ||
    batchLimit > partnerAnnouncementBatchLimit ||
    !Number.isInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > maxPartnerAnnouncementBatchesPerRun
  )
    throw new RangeError('Partner announcement batch is out of range.');
  const queue =
    dependencies.queue ??
    ((input: QueueEmailInput, connection: DatabaseConnection) =>
      createEmailQueue(database, clock).queue(input, connection));
  const repository = createPartnerAnnouncementRepository(database);

  async function queueOne(
    announcementId: string,
    partnerId: string,
    subscriberId: string,
  ): Promise<boolean> {
    return withTransaction(database, async (connection) => {
      const digest = createPartnerDigestRepository(connection);
      // Subscriber, then the programme flag row, then partner: the order
      // activation, the welcome, the digest and erasure lock in.
      if ((await digest.lockSubscriber(subscriberId)) === null) return false;
      if (!(await partnerAttributionEnabledForWrite(connection))) return false;
      if ((await partnerAnnouncementFlagsOff(connection)).length > 0)
        return false;
      if ((await digest.lockEligible(partnerId, subscriberId)) === null)
        return false;
      const status = await createVerificationService(connection, {
        clock,
        ...(dependencies.tokenSecret === undefined
          ? {}
          : { tokenSecret: dependencies.tokenSecret }),
      }).issue(subscriberId, 'status');
      const queued = await queue(
        {
          template: partnerAnnouncementTemplate,
          subscriberId,
          businessKey: partnerAnnouncementBusinessKey(
            announcementId,
            partnerId,
          ),
          provider: 'brevo',
          payload: {
            announcement_id: announcementId,
            status_token_id: status.id,
          },
        },
        connection,
      );
      // A lost race rolls back the status token with the transaction.
      if (!queued) throw new AlreadyQueued();
      return true;
    }).catch((error: unknown) => {
      if (error instanceof AlreadyQueued) return false;
      throw error;
    });
  }

  async function audit(
    actor: string,
    requestId: string | undefined,
    detail: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    await createAuditService(database).record({
      action: 'partner.announcement_run',
      actor,
      // The announcement is a content file, not a row: its id is in detail.
      subjectType: 'partner_announcement',
      subjectId: null,
      detail,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  return {
    async run({ id, dryRun, actor, requestId }) {
      try {
        readPartnerAnnouncement(id, dependencies.directory);
      } catch (error) {
        if (error instanceof PartnerAnnouncementError)
          throw new PartnerAnnouncementRefusedError(
            error.reason,
            error.problems,
          );
        throw error;
      }
      // Off: nothing is queued or sent, and the command refuses.
      const off = await partnerAnnouncementFlagsOff(database);
      if (off.length > 0)
        throw new PartnerAnnouncementRefusedError('flags_off', off);

      if (dryRun) {
        const due = await repository.countDue(id);
        await audit(actor, requestId, {
          announcement_id: id,
          dry_run: true,
          partners_due: due,
        });
        return { announcementId: id, dryRun: true, due };
      }

      const alreadyQueued = await repository.countQueued(id);
      let queued = 0;
      try {
        for (let batch = 0; batch < maxBatches; batch += 1) {
          const due = await repository.due(id, batchLimit);
          if (due.length === 0) break;
          let progressed = false;
          for (const candidate of due) {
            if (
              await queueOne(id, candidate.partner_id, candidate.subscriber_id)
            ) {
              queued += 1;
              progressed = true;
            }
          }
          // Every candidate failed its locked re-check: report the rest as
          // remaining rather than re-reading the same batch.
          if (!progressed) break;
        }
      } catch (error) {
        // A run that stops part-way is still audited with what it queued; the
        // next run continues by business key.
        await audit(actor, requestId, {
          announcement_id: id,
          dry_run: false,
          outcome: 'failed',
          queued,
          already_queued: alreadyQueued,
        }).catch(() => undefined);
        throw error;
      }
      const remaining = await repository.countDue(id);
      await audit(actor, requestId, {
        announcement_id: id,
        dry_run: false,
        outcome: remaining === 0 ? 'completed' : 'partial',
        queued,
        already_queued: alreadyQueued,
        remaining,
      });
      return {
        announcementId: id,
        dryRun: false,
        queued,
        alreadyQueued,
        remaining,
      };
    },
  };
}
