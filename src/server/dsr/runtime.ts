import {
  getConfig,
  getP1AlertConfiguration,
  getBrevoConfiguration,
} from '../config.ts';
import { createPool } from '../db/pool.ts';
import { createBrevoProvider } from '../email/providers/brevo.ts';
import { createAlertWebhookTransport } from '../verification-rate/p1-webhook.ts';
import { verifyTurnstileToken } from '../turnstile/verify.ts';
import { createErasureService } from './service.ts';
import {
  createDsrHandler,
  createDsrService,
  type DsrDependencies,
  type DsrOperation,
  type DsrOutcome,
} from './http.ts';
let database: ReturnType<typeof createPool> | undefined;
function runtime(): {
  database: ReturnType<typeof createPool>;
  dependencies: DsrDependencies;
} {
  const config = getConfig();
  database ??= createPool(config.databaseUrl);
  const brevo = getBrevoConfiguration();
  const provider = brevo
    ? createBrevoProvider(brevo.apiKey, brevo.sendingDomain, brevo.listId)
    : null;
  const clock = () => new Date();
  const alerts = createAlertWebhookTransport(getP1AlertConfiguration());
  const erasure = createErasureService(database, {
    clock,
    alerts,
    deleteContact: async (email) => {
      if (!provider) throw new Error('brevo_unconfigured');
      await provider.deleteContact(email);
    },
  });
  return {
    database,
    dependencies: { clock, challenge: verifyTurnstileToken, erasure, alerts },
  };
}
export function handleDsr(
  operation: DsrOperation,
  request: Request,
  ipPrefixHash: string,
) {
  const { database: pool, dependencies } = runtime();
  return createDsrHandler(pool, dependencies)(operation, request, ipPrefixHash);
}
/** The `/dsr` page's POST: the same logic as `handleDsr`, as an outcome. */
export function runDsr(
  operation: DsrOperation,
  form: FormData,
  ipPrefixHash: string,
): Promise<DsrOutcome> {
  const { database: pool, dependencies } = runtime();
  return createDsrService(pool, dependencies)(operation, form, ipPrefixHash);
}
