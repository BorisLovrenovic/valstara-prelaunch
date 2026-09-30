import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const maxSignatureAgeSeconds = 5 * 60;

export function authenticateBrevoWebhook(
  authorization: string | null,
  expectedToken: string,
): boolean {
  if (authorization === null || !authorization.startsWith('Bearer '))
    return false;
  const supplied = authorization.slice('Bearer '.length);
  if (!supplied || supplied.includes(' ')) return false;
  const suppliedHash = createHash('sha256').update(supplied).digest();
  const expectedHash = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

export function authenticateResendWebhook(
  headers: Headers,
  rawBody: Uint8Array,
  secret: string,
  now: Date,
): string | null {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signature = headers.get('svix-signature');
  if (
    id === null ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(id) ||
    timestamp === null ||
    !/^\d{10}$/u.test(timestamp) ||
    signature === null ||
    !/^whsec_[A-Za-z0-9+/=_-]{24,}$/u.test(secret)
  )
    return null;
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(Math.floor(now.getTime() / 1000) - seconds) >
      maxSignatureAgeSeconds
  )
    return null;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64url');
  if (key.length < 16) return null;
  const signed = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, 'utf8'),
    Buffer.from(rawBody),
  ]);
  const expected = createHmac('sha256', key).update(signed).digest();
  for (const candidate of signature.split(' ')) {
    if (!candidate.startsWith('v1,')) continue;
    const encoded = candidate.slice(3);
    if (!/^[A-Za-z0-9+/=_-]+$/u.test(encoded)) continue;
    const actual = Buffer.from(encoded, 'base64');
    if (actual.length === expected.length && timingSafeEqual(actual, expected))
      return id;
  }
  return null;
}
