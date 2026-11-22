import { createAuditService } from '../audit/service.ts';
import type { BrevoConfiguration } from '../config.ts';
import {
  createBrevoPartnerSyncRepository,
  maxPartnerSyncBatch,
} from '../db/brevo-partner-sync.ts';
import type { PartnerExportRow } from '../db/partner-review.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import {
  reportBrevoSyncFailure,
  runBrevoContactSync,
} from '../email/brevo-sync.ts';
import {
  createBrevoProvider,
  type BrevoContactProvider,
} from '../email/providers/brevo.ts';
import type { FlagService } from '../flags/types.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

const attributeTypes = {
  PARTNER_ID: 'text',
  FULL_NAME: 'text',
  STATUS: 'text',
  PARTNER_TYPE: 'text',
  CODE: 'text',
  CONTRACT_SIGNED_AT: 'text',
  CONTRACT_VERSION: 'text',
  CONFIRMED_REFERRALS: 'float',
  PENDING_REFERRALS: 'float',
  MARKETING_CONSENT: 'boolean',
} as const;

function attributes(row: PartnerExportRow) {
  return {
    PARTNER_ID: row.id,
    FULL_NAME: row.full_name,
    STATUS: row.status,
    PARTNER_TYPE: row.partner_type,
    CODE: row.code ?? '',
    CONTRACT_SIGNED_AT: row.contract_signed_at,
    CONTRACT_VERSION: row.contract_version,
    CONFIRMED_REFERRALS: row.confirmed_referrals,
    PENDING_REFERRALS: row.pending_referrals,
    MARKETING_CONSENT: row.marketing_consent,
  } satisfies Record<keyof typeof attributeTypes, string | number | boolean>;
}

type PartnerContactProvider = Pick<
  BrevoContactProvider,
  'requireContactAttributes' | 'upsertContact' | 'removeContact'
>;

export function partnerBrevoTarget(configuration: BrevoConfiguration | null) {
  if (configuration?.partnerListId === undefined) return null;
  const { apiKey, sendingDomain, partnerListId } = configuration;
  return {
    listId: partnerListId,
    provider: createBrevoProvider(apiKey, sendingDomain, partnerListId),
  };
}

const failureCode = 'partner_sync_unavailable';
// Bound how long a pass can start new work so a slow provider cannot delay
// its alert or the CLI response for the entire batch. Finish in-flight calls.
const passStartWindowMs = 10_000;

export interface PartnerSyncResult {
  readonly state: 'completed' | 'disabled' | 'unavailable';
  readonly selected: number;
  readonly upserted: number;
  readonly removed: number;
  readonly failed: number;
}

export function createPartnerBrevoSync(
  database: DatabasePool,
  flags: Pick<FlagService, 'isEnabled'>,
  target: {
    readonly listId: number;
    readonly provider: PartnerContactProvider;
  } | null,
  alerts: AlertTransport,
  clock: () => Date,
) {
  async function run(
    limit = maxPartnerSyncBatch,
    stop?: AbortSignal,
  ): Promise<PartnerSyncResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxPartnerSyncBatch)
      throw new RangeError('Brevo partner sync batch is out of range.');

    const counts = { selected: 0, upserted: 0, removed: 0, failed: 0 };
    try {
      if (!(await flags.isEnabled('partners.brevo_sync')))
        return { state: 'disabled', ...counts };
      if (target === null) return { state: 'unavailable', ...counts };

      const { listId, provider } = target;
      const candidates = await createBrevoPartnerSyncRepository(
        database,
      ).candidates(listId, limit);
      let attributeCheck: Promise<void> | undefined;
      for (const { subscriber_id: id } of candidates) {
        if (stop?.aborted) break;
        counts.selected += 1;
        try {
          // Commit the first-upsert marker ahead of the network call. An
          // interrupted or failed local commit can then still trigger an
          // unlink if the subject stops being eligible before the retry.
          await withTransaction(database, async (connection) => {
            const repository = createBrevoPartnerSyncRepository(connection);
            if (await repository.lockSubscriber(id))
              await repository.stage(id, listId);
          });

          const applied = await withTransaction(
            database,
            async (connection) => {
              const repository = createBrevoPartnerSyncRepository(connection);
              const subscriber = await repository.lockSubscriber(id);
              if (subscriber === null) return;
              const cached = await repository.lockApplication(id, listId);
              if (cached === null) return;
              // Use a new read after the locks. A delayed candidate may have
              // been suppressed or become ineligible since the initial scan.
              const contact = await repository.desired(id);
              if (contact === null) {
                await provider.removeContact(subscriber.email_normalised);
                await repository.forget(id, listId);
                return 'removed';
              }
              if (cached.fingerprint?.equals(contact.fingerprint)) return;
              attributeCheck ??=
                provider.requireContactAttributes(attributeTypes);
              await attributeCheck;
              await provider.upsertContact(
                contact.email_normalised,
                contact.email,
                attributes(contact),
              );
              await repository.record(id, listId, contact.fingerprint, clock());
              return 'upserted';
            },
          );
          if (applied !== undefined) counts[applied] += 1;
        } catch {
          counts.failed += 1;
        }
      }
    } catch {
      return { state: 'unavailable', ...counts };
    }
    return {
      state: counts.failed > 0 ? 'unavailable' : 'completed',
      ...counts,
    };
  }

  return {
    run,
    async runOnDemand(actor: string): Promise<PartnerSyncResult> {
      const result = await run(
        maxPartnerSyncBatch,
        AbortSignal.timeout(passStartWindowMs),
      );
      if (result.state === 'unavailable')
        await reportBrevoSyncFailure(alerts, clock, failureCode);
      await createAuditService(database).record({
        action: 'partner.brevo_synced',
        actor,
        subjectType: 'partner',
        subjectId: null,
        detail: { ...result },
      });
      return result;
    },
    runContinuously(signal: AbortSignal): Promise<void> {
      return runBrevoContactSync(
        {
          async run() {
            const result = await run(
              maxPartnerSyncBatch,
              AbortSignal.any([signal, AbortSignal.timeout(passStartWindowMs)]),
            );
            if (result.state === 'unavailable') throw new Error(failureCode);
          },
        },
        alerts,
        clock,
        signal,
        undefined,
        failureCode,
      );
    },
  };
}
