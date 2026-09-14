import { getDatabaseUrl } from '../src/server/config.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createFraudService } from '../src/server/fraud/service.ts';

const [domain, actor] = process.argv.slice(2);

if (domain === undefined || actor === undefined) {
  throw new Error('Usage: npm run fraud:allow-domain -- <domain> <actor>');
}

const database = createPool(getDatabaseUrl());
try {
  await createFraudService(database).allowDomain(domain, actor);
  process.stdout.write(`Allowed ${domain.trim().toLowerCase()}.\n`);
} finally {
  await database.close();
}
