import { getConfig } from '../config.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';

import { utmConvention } from './convention.ts';
import {
  createSourceReportService,
  type SourceReportService,
} from './report.ts';

// E11.8-02: the process-lifetime report service behind the admin route, on a
// pool created at first use, as the other admin routes do, with the committed
// UTM convention.
let database: DatabasePool | undefined;
let service: SourceReportService | undefined;

export function getSourceReportService(): SourceReportService {
  database ??= createPool(getConfig().databaseUrl);
  service ??= createSourceReportService(database, {
    convention: utmConvention,
  });
  return service;
}
