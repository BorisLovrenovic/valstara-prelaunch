import type { AuditService } from '../audit/service.ts';
import {
  openPartnerExportSnapshot,
  partnerExportBatchSize,
  type PartnerExportRow,
  type PartnerExportSnapshot,
} from '../db/partner-review.ts';
import type { DatabasePool } from '../db/pool.ts';

// E11.7-06: `partners export`, the quarterly Brevo import file (D-052 Q3).
// One CSV row per contracted partner whose personal data is not purged and
// whose address is not suppressed. `EXT_ID` is the linked member's normalised
// email, the external ID the Brevo contact sync already uses, so erasure's
// Brevo delete by ext_id also removes an imported partner contact. No country,
// application answers, notes or referred person's data is exported.

/** The columns, in the founder's order (D-052 Q3). */
export const partnerExportColumns = [
  'EMAIL',
  'EXT_ID',
  'PARTNER_ID',
  'FULL_NAME',
  'STATUS',
  'PARTNER_TYPE',
  'CODE',
  'CONTRACT_SIGNED_AT',
  'CONTRACT_VERSION',
  'CONFIRMED_REFERRALS',
  'PENDING_REFERRALS',
  'MARKETING_CONSENT',
] as const;

function field(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function partnerCsvHeader(): string {
  return `${partnerExportColumns.join(',')}\r\n`;
}

export function partnerCsvRow(row: PartnerExportRow): string {
  return `${[
    row.email,
    row.email_normalised,
    row.id,
    row.full_name,
    row.status,
    row.partner_type,
    row.code,
    row.contract_signed_at,
    row.contract_version,
    row.confirmed_referrals,
    row.pending_referrals,
    row.marketing_consent,
  ]
    .map(field)
    .join(',')}\r\n`;
}

export interface PartnerExportService {
  open(actor: string): Promise<ReadableStream<Uint8Array>>;
}

export function createPartnerExportService(
  database: DatabasePool,
  audit: Pick<AuditService, 'record'>,
): PartnerExportService {
  return createPartnerExportServiceWithSnapshot(
    () => openPartnerExportSnapshot(database),
    audit,
  );
}

/**
 * Opens the snapshot, records `partner.exported` with its row count before
 * the first byte (failing closed if the audit cannot be written), then
 * streams the rows in pages of at most 500.
 */
export function createPartnerExportServiceWithSnapshot(
  snapshotFactory: () => Promise<PartnerExportSnapshot>,
  audit: Pick<AuditService, 'record'>,
): PartnerExportService {
  return {
    async open(actor) {
      const trimmed = actor.trim();
      if (trimmed === '' || trimmed.startsWith('system:')) {
        throw new Error('A human export actor is required.');
      }
      const snapshot = await snapshotFactory();
      try {
        await audit.record({
          action: 'partner.exported',
          actor: trimmed,
          subjectType: 'export',
          subjectId: null,
          detail: {
            row_count: snapshot.rowCount,
            page_size: partnerExportBatchSize,
          },
        });
      } catch (error) {
        await snapshot.close();
        throw error;
      }
      return csvStream(snapshot);
    },
  };
}

function csvStream(
  snapshot: PartnerExportSnapshot,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let headerSent = false;
  let afterId: string | null = null;
  let emitted = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(partnerCsvHeader()));
          return;
        }
        if (emitted === snapshot.rowCount) {
          await snapshot.close();
          controller.close();
          return;
        }
        // One page per pull: at most 500 rows are held at once.
        const page = await snapshot.page(afterId, partnerExportBatchSize);
        if (page.length === 0) {
          throw new Error(
            'Partner export snapshot ended before its audited row count.',
          );
        }
        afterId = page.at(-1)?.id ?? afterId;
        emitted += page.length;
        controller.enqueue(encoder.encode(page.map(partnerCsvRow).join('')));
      } catch (error) {
        try {
          await snapshot.close();
        } catch {
          // Preserve the read failure as the stream error.
        }
        controller.error(error);
      }
    },
    async cancel() {
      await snapshot.close();
    },
  });
}
