import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { thinSliceCopy } from '../../copy/e1-11.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const rateLimitWindowMs = 15 * 60 * 1_000;
const verificationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

export const thinSliceRateLimit = {
  maximumAttempts: 5,
  windowMs: rateLimitWindowMs,
} as const;

export type ThinSignupResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'invalid_email' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'unavailable' };

export interface ThinSignupInput {
  readonly email: string;
  readonly ipAddress: string;
  readonly verificationUrl: (token: string) => string;
}

export interface VerificationTestMail {
  readonly businessKey: string;
  readonly verificationUrl: string;
}

export interface ThinSignupDependencies {
  readonly clock?: () => Date;
  readonly ipPrefixPepper: string;
  readonly rateLimitMaximumAttempts?: number;
  readonly sendVerificationTestMail: (
    mail: VerificationTestMail,
  ) => Promise<void>;
}

interface QueuedVerificationMail extends VerificationTestMail {
  readonly subscriberId: string;
}

function hasValidThinSliceEmailShape(email: string): boolean {
  return emailPattern.test(email);
}

function normaliseEmailForThinSlice(email: string): string {
  return email.toLowerCase();
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

function expandedIpv6Parts(address: string): readonly string[] {
  const [left = '', right = ''] = address.toLowerCase().split('::');
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  const missingParts = 8 - leftParts.length - rightParts.length;

  return [
    ...leftParts,
    ...Array.from({ length: missingParts }, () => '0'),
    ...rightParts,
  ];
}

function truncatedIpPrefix(ipAddress: string): string | null {
  const address = ipAddress.split('%', 1)[0] ?? '';
  const version = isIP(address);

  if (version === 4) {
    return `${address.split('.').slice(0, 3).join('.')}.0/24`;
  }

  if (version === 6) {
    return `${expandedIpv6Parts(address)
      .slice(0, 4)
      .map((part) => Number.parseInt(part, 16).toString(16))
      .join(':')}::/64`;
  }

  return null;
}

function hashedIpPrefix(ipAddress: string, pepper: string): string | null {
  const prefix = truncatedIpPrefix(ipAddress);
  return prefix === null
    ? null
    : createHmac('sha256', pepper).update(prefix).digest('hex');
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function createVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

async function incrementRateLimit(
  database: DatabasePool,
  key: string,
  now: Date,
): Promise<number> {
  const windowThreshold = new Date(now.getTime() - rateLimitWindowMs);
  return withTransaction(database, async (connection) => {
    await connection.execute({
      text: `
        INSERT INTO rate_limit_bucket (key, window_start, count)
        VALUES ($1, $2, 1)
        ON CONFLICT (key) DO UPDATE
        SET window_start = CASE
              WHEN rate_limit_bucket.window_start <= $3 THEN EXCLUDED.window_start
              ELSE rate_limit_bucket.window_start
            END,
            count = CASE
              WHEN rate_limit_bucket.window_start <= $3 THEN 1
              ELSE rate_limit_bucket.count + 1
            END
      `,
      values: [key, now, windowThreshold],
    });
    const row = await connection.readOne<{ count: number }>({
      text: 'SELECT count FROM rate_limit_bucket WHERE key = $1',
      values: [key],
    });

    if (row === null) {
      throw new Error('Rate-limit counter did not return a count.');
    }

    return row.count;
  });
}

async function insertSignup(
  database: DatabasePool,
  email: string,
  emailNormalised: string,
  verificationUrl: (token: string) => string,
  now: Date,
): Promise<QueuedVerificationMail | null> {
  return withTransaction(database, async (connection) => {
    const subscriberId = randomUUID();
    const insertedSubscribers = await connection.execute({
      text: `
        INSERT INTO subscriber (
          id,
          email,
          email_normalised,
          email_domain,
          status
        )
        VALUES ($1, $2, $3, $4, 'pending')
        ON CONFLICT (email_normalised) DO NOTHING
      `,
      values: [
        subscriberId,
        email,
        emailNormalised,
        emailDomain(emailNormalised),
      ],
    });

    if (insertedSubscribers === 0) {
      return null;
    }

    const tokenId = randomUUID();
    const token = createVerificationToken();
    const businessKey = `verify:${subscriberId}:${tokenId}`;
    const expiresAt = new Date(now.getTime() + verificationLifetimeMs);

    await connection.execute({
      text: `
        INSERT INTO verification_token (
          id,
          subscriber_id,
          token_hash,
          purpose,
          expires_at
        )
        VALUES ($1, $2, $3, 'verify', $4)
      `,
      values: [tokenId, subscriberId, tokenHash(token), expiresAt],
    });
    await connection.execute({
      text: `
        INSERT INTO email_send (
          id,
          subscriber_id,
          template,
          provider,
          business_key,
          state
        )
        VALUES ($1, $2, 'verification_test', 'resend', $3, 'queued')
      `,
      values: [randomUUID(), subscriberId, businessKey],
    });

    return {
      businessKey,
      subscriberId,
      verificationUrl: verificationUrl(token),
    };
  });
}

export function createThinSignupService(
  database: DatabasePool,
  dependencies: ThinSignupDependencies,
): (input: ThinSignupInput) => Promise<ThinSignupResult> {
  const clock = dependencies.clock ?? (() => new Date());
  const maximumAttempts =
    dependencies.rateLimitMaximumAttempts ?? thinSliceRateLimit.maximumAttempts;

  return async (input) => {
    const now = clock();
    const prefixHash = hashedIpPrefix(
      input.ipAddress,
      dependencies.ipPrefixPepper,
    );

    if (prefixHash === null) {
      return { kind: 'rate_limited' };
    }

    const count = await incrementRateLimit(
      database,
      `signup:ip:${prefixHash}`,
      now,
    );
    if (count > maximumAttempts) {
      return { kind: 'rate_limited' };
    }

    if (!hasValidThinSliceEmailShape(input.email)) {
      return { kind: 'invalid_email' };
    }
    const normalisedEmail = normaliseEmailForThinSlice(input.email);

    const mail = await insertSignup(
      database,
      input.email,
      normalisedEmail,
      input.verificationUrl,
      now,
    );
    if (mail === null) {
      return { kind: 'duplicate' };
    }

    try {
      await dependencies.sendVerificationTestMail(mail);
    } catch {
      // The committed queue is the source of truth. E8 adds retry handling.
    }

    return { kind: 'created' };
  };
}

export function createResendTestMailSender(
  apiKey: string | undefined,
  testRecipient: string | undefined,
): (mail: VerificationTestMail) => Promise<void> {
  return async (mail) => {
    if (!apiKey || !testRecipient) {
      throw new Error('Resend test-mode configuration is unavailable.');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': mail.businessKey,
      },
      body: JSON.stringify({
        from: 'Valstara <onboarding@resend.dev>',
        subject: thinSliceCopy.verificationSubject,
        text: thinSliceCopy.verificationText(mail.verificationUrl),
        to: [testRecipient],
      }),
    });

    if (!response.ok) {
      throw new Error('Resend test-mode request failed.');
    }
  };
}
