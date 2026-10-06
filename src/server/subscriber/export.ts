import type { AuditService } from '../audit/service.ts';
import {
  adminExportBatchSize,
  openAdminExportSnapshot,
  type AdminExportRow,
  type AdminExportSnapshot,
} from '../db/admin-export.ts';
import type { DatabasePool } from '../db/pool.ts';
import { csvHeader, csvRow } from './export-csv.ts';

export interface AdminExportService {
  open(actor: string): Promise<ReadableStream<Uint8Array>>;
}

export function createAdminExportService(
  database: DatabasePool,
  audit: AuditService,
): AdminExportService {
  return createAdminExportServiceWithSnapshot(
    () => openAdminExportSnapshot(database),
    audit,
  );
}

export function createAdminExportServiceWithSnapshot(
  snapshotFactory: () => Promise<AdminExportSnapshot>,
  audit: Pick<AuditService, 'record'>,
): AdminExportService {
  return {
    async open(actor) {
      if (actor.trim().length === 0)
        throw new Error('Export actor is required.');
      const snapshot = await snapshotFactory();
      try {
        await audit.record({
          action: 'export.run',
          actor,
          subjectType: 'export',
          subjectId: null,
          detail: { row_count: snapshot.rowCount },
        });
      } catch (error) {
        await snapshot.close();
        throw error;
      }
      return csvStream(snapshot);
    },
  };
}

function csvStream(snapshot: AdminExportSnapshot): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let page: readonly AdminExportRow[] = [];
  let pageIndex = 0;
  let afterId: string | null = null;
  let emitted = 0;
  let headerSent = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(csvHeader()));
          return;
        }
        if (emitted === snapshot.rowCount) {
          await snapshot.close();
          controller.close();
          return;
        }
        if (pageIndex === page.length) {
          page = await snapshot.page(afterId, adminExportBatchSize);
          pageIndex = 0;
          if (page.length === 0) {
            throw new Error(
              'Export snapshot ended before its audited row count.',
            );
          }
        }
        const row = page[pageIndex];
        if (row === undefined)
          throw new Error('Export page row was unavailable.');
        pageIndex += 1;
        afterId = row.id;
        emitted += 1;
        controller.enqueue(encoder.encode(csvRow(row)));
      } catch (error) {
        try {
          await snapshot.close();
        } catch {
          // Preserve the row-read failure as the stream error.
        }
        controller.error(error);
      }
    },
    async cancel() {
      await snapshot.close();
    },
  });
}
