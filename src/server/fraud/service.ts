import { randomUUID } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import { domainToASCII } from 'node:url';

import { createAuditService } from '../audit/service.ts';
import { createDomainAllowRepository } from '../db/domain-allow.ts';
import { findDuplicateIdentityMatches } from '../db/duplicate-identity.ts';
import { createFraudFlagRepository } from '../db/fraud-flag.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

import { isBlocklistedDomain } from './blocklist.ts';

export const mxLookupTimeoutMs = 1_500;
export const mxCacheTtlMs = 15 * 60 * 1_000;
export const mxCacheMaximumEntries = 10_000;
export const duplicateIdentityEvidenceLimit = 20;
export const duplicateIdentityRuleVersion = 1;

export type FraudScreenReject = 'blocked_domain' | 'invalid_email';
export type FraudScreenFlag = 'no_mx';

export interface ScreenInput {
  readonly domain: string;
}

export interface ScreenResult {
  readonly reject?: FraudScreenReject;
  readonly flags: readonly FraudScreenFlag[];
}

export interface FraudService {
  allowDomain(domain: string, actor: string): Promise<void>;
  flagDuplicateIdentity(subscriberId: string): Promise<boolean>;
  raise(
    subscriberId: string,
    kind: FraudScreenFlag,
    detail: Readonly<Record<string, string>>,
  ): Promise<void>;
  screen(input: ScreenInput): Promise<ScreenResult>;
}

type MxLookupResult = 'deliverable' | 'no_mx' | 'timeout';

export interface FraudServiceOptions {
  readonly cacheMaximumEntries?: number;
  readonly cacheTtlMs?: number;
  readonly clock?: () => Date;
  readonly mxResolver?: (domain: string) => Promise<readonly unknown[]>;
  readonly timeoutMs?: number;
  readonly withTimeout?: <Result>(
    operation: Promise<Result>,
    milliseconds: number,
  ) => Promise<Result | 'timeout'>;
}

interface CachedMxResult {
  readonly expiresAt: number;
  readonly result: MxLookupResult;
}

function normaliseDomain(domain: string): string | null {
  const ascii = domainToASCII(domain.trim().toLowerCase());
  if (
    ascii === '' ||
    ascii.length > 253 ||
    !ascii.includes('.') ||
    ascii
      .split('.')
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    return null;
  }
  return ascii;
}

function isNoMxError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENODATA' || error.code === 'ENOTFOUND')
  );
}

async function bounded<Result>(
  operation: Promise<Result>,
  milliseconds: number,
): Promise<Result | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), milliseconds);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createFraudService(
  database: DatabasePool,
  options: FraudServiceOptions = {},
): FraudService {
  const cache = new Map<string, CachedMxResult>();
  const cacheMaximumEntries =
    options.cacheMaximumEntries ?? mxCacheMaximumEntries;
  const cacheTtl = options.cacheTtlMs ?? mxCacheTtlMs;
  const clock = options.clock ?? (() => new Date());
  const resolver = options.mxResolver ?? resolveMx;
  const timeout = options.timeoutMs ?? mxLookupTimeoutMs;
  const withTimeout = options.withTimeout ?? bounded;

  if (!Number.isInteger(cacheMaximumEntries) || cacheMaximumEntries < 1) {
    throw new RangeError('MX cache size must be a positive integer.');
  }

  async function lookupMx(domain: string): Promise<MxLookupResult> {
    const now = clock().getTime();
    const cached = cache.get(domain);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }

    let result: MxLookupResult;
    try {
      const records = await withTimeout(resolver(domain), timeout);
      result =
        records === 'timeout'
          ? 'timeout'
          : records.length === 0
            ? 'no_mx'
            : 'deliverable';
    } catch (error) {
      // ENODATA/ENOTFOUND is a definitive no-MX answer. Other resolver errors
      // are transient and get the same accept-and-flag treatment as a timeout.
      result = isNoMxError(error) ? 'no_mx' : 'timeout';
    }

    if (!cache.has(domain) && cache.size >= cacheMaximumEntries) {
      const oldestDomain = cache.keys().next().value;
      if (oldestDomain !== undefined) {
        cache.delete(oldestDomain);
      }
    }
    cache.set(domain, { expiresAt: now + cacheTtl, result });
    return result;
  }

  return {
    async allowDomain(rawDomain, rawActor) {
      const domain = normaliseDomain(rawDomain);
      if (domain === null) {
        throw new RangeError('Domain must be a valid mail domain.');
      }
      const actor = rawActor.trim();
      if (actor === '') {
        throw new RangeError('An actor is required to allow a domain.');
      }

      await withTransaction(database, async (connection) => {
        const inserted = await createDomainAllowRepository(connection).insert(
          domain,
          actor,
        );
        await createAuditService(connection).record({
          action: 'fraud.domain_allowed',
          actor,
          detail: { created: inserted === 1 },
          subjectId: domain,
          subjectType: 'email_domain',
        });
      });
    },
    async flagDuplicateIdentity(subscriberId) {
      return withTransaction(database, async (connection) => {
        const matches = await findDuplicateIdentityMatches(connection, {
          limit: duplicateIdentityEvidenceLimit,
          subscriberId,
        });
        const firstMatch = matches[0];
        if (firstMatch === undefined) {
          return false;
        }

        await createFraudFlagRepository(connection).insertDuplicateIdentityFlag(
          {
            detail: {
              local_part: firstMatch.local_part,
              match_count: Number(firstMatch.match_count),
              matched_subscriber_ids: matches.map((match) => match.id),
              rule: 'shared_local_part_across_domains',
              rule_version: duplicateIdentityRuleVersion,
            },
            id: randomUUID(),
            subscriberId,
          },
        );
        return true;
      });
    },
    async raise(subscriberId, kind, detail) {
      if (kind !== 'no_mx') {
        throw new RangeError('Unsupported fraud flag kind.');
      }
      await createFraudFlagRepository(database).insertNoMxFlag({
        detail,
        id: randomUUID(),
        subscriberId,
      });
    },
    async screen(input) {
      const domain = normaliseDomain(input.domain);
      if (domain === null) {
        return { flags: [], reject: 'invalid_email' };
      }

      const allowed =
        await createDomainAllowRepository(database).contains(domain);
      if (!allowed && isBlocklistedDomain(domain)) {
        return { flags: [], reject: 'blocked_domain' };
      }

      const mx = await lookupMx(domain);
      if (mx === 'no_mx') {
        return { flags: [], reject: 'invalid_email' };
      }
      if (mx === 'timeout') {
        return { flags: ['no_mx'] };
      }
      return { flags: [] };
    },
  };
}
