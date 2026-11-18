import * as fs from 'node:fs/promises';

import { createJsonFileStore } from '../../packages/price-index/src/storage/index.ts';

// E11.6-03 test helper: writes a new latest.json or snapshot into the data
// directory in argv[2], and kills its own process with SIGKILL at the moment
// the flushed temporary file would take the target's name. It is a real
// crash: no `finally`, no clean-up and no exit handler runs.
//
// `node --test` also loads every file under test/, with no arguments; then it
// does nothing.

const [directory, kind] = process.argv.slice(2);

const killed = async (): Promise<never> => {
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => undefined);
};

const store = createJsonFileStore({
  directory: directory ?? '.',
  fs: { open: fs.open, unlink: fs.unlink, rename: killed, link: killed },
});

const file = {
  built_at: '2026-12-01T09:30:00Z',
  records: [
    {
      market: 'SE',
      service_id: 'spotify',
      plan_id: 'individual',
      billing_period: 'month' as const,
      price_local: '159.00',
      price_source_text: 'kr\u00a0159',
      currency: 'SEK',
      price_usd_source: '16.85',
      source: 'scraper:youfundceo.com',
      source_url: 'https://www.youfundceo.com/services/spotify/sweden',
      observed_at: '2026-12-01T09:00:00Z',
      source_verified_at: '2026-11-28',
      status: 'ok' as const,
      missing_reason: null,
      notes: null,
    },
  ],
};

if (kind === 'snapshot') {
  await store.writeSnapshot(file, '2026-12-01');
} else if (kind === 'latest') {
  await store.writeLatest(file);
}
