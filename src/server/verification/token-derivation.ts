import { createHash, createHmac } from 'node:crypto';

export function deriveEmailToken(tokenId: string, secret: string): string {
  if (secret.length < 32) {
    throw new RangeError(
      'EMAIL_TOKEN_SECRET must contain at least 32 characters.',
    );
  }
  return createHmac('sha256', secret)
    .update(tokenId, 'utf8')
    .digest('base64url');
}

export function hashEmailToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function emailTokenSecret(): string {
  const secret = process.env.EMAIL_TOKEN_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new Error('EMAIL_TOKEN_SECRET must contain at least 32 characters.');
  }
  return secret;
}
