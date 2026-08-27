import { isIP } from 'node:net';

import type { AuditDetail, AuditDetailValue } from './types.ts';

export const redactedAuditDetailValue = '[redacted]';

const sensitiveKey =
  /(?:api[-_]?key|authori[sz]ation|email|ip|password|secret|signature|token)/i;
const emailAddress = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const ipv4Address =
  /(?:^|[^\d])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\d)/;
const ipAddressCandidate = /[\da-f:.]+/gi;

export function redactAuditDetail(detail: AuditDetail): AuditDetail {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      sensitiveKey.test(key)
        ? redactedAuditDetailValue
        : redactAuditDetailValue(value),
    ]),
  );
}

function redactAuditDetailValue(value: AuditDetailValue): AuditDetailValue {
  if (typeof value === 'string') {
    return containsPersonalAddress(value) ? redactedAuditDetailValue : value;
  }

  if (Array.isArray(value)) {
    return value.map(redactAuditDetailValue);
  }

  if (isAuditDetailObject(value)) {
    return redactAuditDetail(value);
  }

  return value;
}

function containsPersonalAddress(value: string): boolean {
  return (
    emailAddress.test(value) ||
    ipv4Address.test(value) ||
    containsIpAddressCandidate(value) ||
    isIP(value) !== 0
  );
}

function containsIpAddressCandidate(value: string): boolean {
  return Array.from(value.matchAll(ipAddressCandidate)).some((match) => {
    const candidate = match[0].replace(/^\.+|\.+$/g, '');
    return isIP(candidate) !== 0;
  });
}

function isAuditDetailObject(
  value: AuditDetailValue,
): value is { readonly [key: string]: AuditDetailValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
