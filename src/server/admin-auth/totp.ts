import { createHmac, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const digits = 6;
const periodMilliseconds = 30_000;

function decodeBase32(value: string): Buffer {
  let accumulator = 0;
  let availableBits = 0;
  const bytes: number[] = [];

  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit === -1) {
      throw new Error('Invalid TOTP secret.');
    }
    accumulator = (accumulator << 5) | digit;
    availableBits += 5;
    if (availableBits >= 8) {
      availableBits -= 8;
      bytes.push((accumulator >>> availableBits) & 0xff);
      accumulator &= (1 << availableBits) - 1;
    }
  }

  return Buffer.from(bytes);
}

function counterAt(instant: Date): bigint {
  return BigInt(Math.floor(instant.getTime() / periodMilliseconds));
}

function codeForCounter(secret: string, counter: bigint): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret))
    .update(message)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 0x1000000 +
    (digest[offset + 1] ?? 0) * 0x10000 +
    (digest[offset + 2] ?? 0) * 0x100 +
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function generateTotp(secret: string, instant: Date): string {
  return codeForCounter(secret, counterAt(instant));
}

export function verifyTotp(
  secret: string,
  candidate: string,
  instant: Date,
): boolean {
  if (!/^\d{6}$/u.test(candidate)) return false;

  const candidateBytes = Buffer.from(candidate, 'ascii');
  const counter = counterAt(instant);
  let matched = false;

  // One adjacent step in each direction tolerates ordinary authenticator clock
  // skew. Evaluate every candidate so the accepted offset is not observable.
  for (const offset of [-1n, 0n, 1n]) {
    const expected = Buffer.from(
      codeForCounter(secret, counter + offset),
      'ascii',
    );
    matched = timingSafeEqual(candidateBytes, expected) || matched;
  }
  return matched;
}
