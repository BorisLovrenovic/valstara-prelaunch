import { getConfig } from '../config.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';

import {
  createTrustLedgerFiguresService,
  type TrustLedgerFiguresService,
} from './waitlist-figures.ts';

// E11.8-01: the process-lifetime figures service behind the admin route, on a
// pool created at first use, as the other admin routes do.
let database: DatabasePool | undefined;
let service: TrustLedgerFiguresService | undefined;

export function getTrustLedgerFiguresService(): TrustLedgerFiguresService {
  database ??= createPool(getConfig().databaseUrl);
  service ??= createTrustLedgerFiguresService(database);
  return service;
}
