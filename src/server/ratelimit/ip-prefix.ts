import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Truncate-then-hash of a client IP, for use as a rate-limit bucket key.
 *
 * A full IP address is personal data and is never stored, logged or returned
 * (standing rule 9). We truncate first — IPv4 to /24, IPv6 to /64 — and then
 * HMAC the prefix with a server-side pepper, so the stored key is neither the
 * address nor reversible to it. E5-03 owns the fraud-velocity `hashIpPrefix()`
 * and the 90-day purge; this helper exists because the signup route has been
 * rate-limited per hashed IP prefix since E1-11 and needs the key.
 */

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

/** Returns the truncated network prefix, or `null` when the input is not an IP. */
export function truncatedIpPrefix(ipAddress: string): string | null {
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

/**
 * Returns the HMAC-SHA-256 of the truncated prefix, or `null` when the address
 * is unparseable — the caller treats a `null` as a rate-limit denial rather
 * than letting an unattributable request through.
 */
export function hashedIpPrefix(
  ipAddress: string,
  pepper: string,
): string | null {
  const prefix = truncatedIpPrefix(ipAddress);
  return prefix === null
    ? null
    : createHmac('sha256', pepper).update(prefix).digest('hex');
}
