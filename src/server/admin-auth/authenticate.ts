import { createHash, timingSafeEqual } from 'node:crypto';

import { verifyTotp } from './totp.ts';

export const adminActor = 'admin.operator';

export interface AdminAuthenticatorConfiguration {
  readonly credential: string;
  readonly totpSecret: string;
}

export type AdminAuthenticator = (request: Request) => string | null;

function fixedLengthDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerCredential(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer ([^\s]+)$/iu);
  return match?.[1] ?? '';
}

export function createAdminAuthenticator(
  configuration: AdminAuthenticatorConfiguration,
  clock: () => Date = () => new Date(),
): AdminAuthenticator {
  const expectedCredential = fixedLengthDigest(configuration.credential);

  return (request) => {
    const suppliedCredential = fixedLengthDigest(bearerCredential(request));
    const credentialMatches = timingSafeEqual(
      suppliedCredential,
      expectedCredential,
    );
    const totpMatches = verifyTotp(
      configuration.totpSecret,
      request.headers.get('x-valstara-totp') ?? '',
      clock(),
    );

    return credentialMatches && totpMatches ? adminActor : null;
  };
}
