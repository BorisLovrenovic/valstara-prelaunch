import { randomUUID } from 'node:crypto';

import { getConfig } from '../config.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import { createPool, type DatabasePool } from '../db/pool.ts';
import { getFlagService } from '../flags/app-service.ts';
import { createFraudService } from '../fraud/service.ts';
import { currentRules } from '../giveaway/rules-catalog.ts';
import { createPartnerCodeRules } from '../referral/partner-code.ts';
import { consumeRateLimit } from '../ratelimit/consume.ts';
import { hashedIpPrefix } from '../ratelimit/ip-prefix.ts';
import { verifyTurnstileToken } from '../turnstile/verify.ts';

import {
  createPartnerApplicationHandler,
  createPartnerSubmitService,
  type PartnerApplicationOutcome,
} from './application.ts';
import { partnerApplicationIpWindowMs } from './config.ts';
import {
  createPartnerConfirmationService,
  type PartnerConfirmationOutcome,
} from './confirm.ts';

let database: DatabasePool | undefined;
function getDatabase(): DatabasePool {
  database ??= createPool(getConfig().databaseUrl);
  return database;
}

const isEnabled = () => getFlagService().isEnabled('partners.enabled');

/** `/partners/apply`'s submit, wired to the application's services. */
export function runPartnerApplication(
  form: FormData,
  clientAddress: string,
): Promise<PartnerApplicationOutcome> {
  const config = getConfig();
  const pool = getDatabase();
  const fraud = createFraudService(pool);
  return createPartnerApplicationHandler({
    // The raw client address is not forwarded to the provider; it stays in
    // the truncate-then-hash rate-limit path (standing rule 9).
    verifyTurnstile: (token) => verifyTurnstileToken(token),
    isEnabled,
    hashIpPrefix: (address) => {
      const hash = hashedIpPrefix(address, config.ipPrefixPepper);
      return hash === null ? null : Buffer.from(hash, 'hex');
    },
    consumeIpRateLimit: (prefixHash, now, strict) =>
      consumeRateLimit(
        pool,
        strict
          ? `partner:apply:ip:strict:${prefixHash}`
          : `partner:apply:ip:${prefixHash}`,
        partnerApplicationIpWindowMs,
        now,
      ),
    checkCode: (requested) => createPartnerCodeRules(pool).check(requested),
    submit: createPartnerSubmitService(pool, {
      screenEmailDomain: (domain) => fraud.screen({ domain }),
      raiseFraudFlag: (subscriberId, kind, detail) =>
        fraud.raise(subscriberId, kind, detail),
      flagDuplicateIdentity: (subscriberId) =>
        fraud.flagDuplicateIdentity(subscriberId),
      flagIpVelocity: (subscriberId, prefixHash) =>
        fraud.flagIpVelocity(subscriberId, prefixHash, config.ipVelocity),
      async flagChallengeTimeout(subscriberId) {
        await createFraudFlagRepository(pool).insertChallengeTimeoutFlag({
          id: randomUUID(),
          subscriberId,
        });
      },
    }),
  })(form, clientAddress);
}

/** `/partners/apply`'s confirmation POST, wired to the application's services. */
export function runPartnerConfirmation(
  token: string,
  clientAddress: string,
): Promise<PartnerConfirmationOutcome> {
  const pool = getDatabase();
  return createPartnerConfirmationService(pool, {
    isEnabled,
    consumeIpRateLimit: (prefixHash, now) =>
      consumeRateLimit(
        pool,
        `partner:confirm:ip:${prefixHash}`,
        partnerApplicationIpWindowMs,
        now,
      ),
    giveaway: { flags: getFlagService(), currentRules },
  })(token, hashedIpPrefix(clientAddress, getConfig().ipPrefixPepper) ?? '');
}
