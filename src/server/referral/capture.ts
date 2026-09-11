import { createHmac, timingSafeEqual } from 'node:crypto';

/** A referral field is a landing-request handoff, not a visitor identifier. */
export const referralCaptureTtlMs = 24 * 60 * 60 * 1_000;

const acceptedUtmParameters = [
  ['utm_source', 'source'],
  ['utm_medium', 'medium'],
  ['utm_campaign', 'campaign'],
  ['utm_content', 'content'],
  ['utm_term', 'term'],
] as const;
const maximumUtmValueLength = 128;
const maximumUtmSerializedBytes = 512;

export interface UtmParameters {
  readonly source?: string;
  readonly medium?: string;
  readonly campaign?: string;
  readonly content?: string;
  readonly term?: string;
}

export interface ReferralCapture {
  readonly ref: string | null;
  readonly utm: UtmParameters | null;
}

interface ReferralEnvelope extends ReferralCapture {
  readonly exp: number;
  readonly iat: number;
}

export interface ReferralCaptureService {
  capture(url: URL): ReferralCapture;
  signRef(capture: ReferralCapture): string;
  verifyRef(signed: string | null): ReferralCapture | null;
}

export interface ReferralCaptureDependencies {
  readonly clock?: () => Date;
}

/** Server-only query capture and signed-form verification. */
export function createReferralCaptureService(
  secret: string,
  dependencies: ReferralCaptureDependencies = {},
): ReferralCaptureService {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    capture(url) {
      const rawRef = url.searchParams.get('ref');
      return {
        ref: rawRef === null || rawRef === '' ? null : rawRef,
        utm: captureUtm(url.searchParams),
      };
    },
    signRef(capture) {
      const iat = clock().getTime();
      const payload = Buffer.from(
        JSON.stringify({
          exp: iat + referralCaptureTtlMs,
          iat,
          ref: capture.ref,
          utm: capture.utm,
        } satisfies ReferralEnvelope),
      ).toString('base64url');
      return `${payload}.${sign(payload, secret)}`;
    },
    verifyRef(signed) {
      if (signed === null) return null;
      const [payload, signature, extra] = signed.split('.');
      if (
        payload === undefined ||
        signature === undefined ||
        extra !== undefined ||
        !signatureMatches(payload, signature, secret)
      )
        return null;
      let envelope: unknown;
      try {
        envelope = JSON.parse(
          Buffer.from(payload, 'base64url').toString('utf8'),
        );
      } catch {
        return null;
      }
      if (!isReferralEnvelope(envelope) || envelope.exp < clock().getTime())
        return null;
      return { ref: envelope.ref, utm: envelope.utm };
    },
  };
}

export function captureUtm(
  searchParams: URLSearchParams,
): UtmParameters | null {
  const utm: Record<string, string> = {};
  for (const [queryKey, storedKey] of acceptedUtmParameters) {
    const value = searchParams.get(queryKey)?.trim();
    if (
      value === undefined ||
      value === '' ||
      value.length > maximumUtmValueLength ||
      /\p{Cc}/u.test(value)
    )
      continue;
    const candidate = { ...utm, [storedKey]: value };
    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') <=
      maximumUtmSerializedBytes
    )
      utm[storedKey] = value;
  }
  return Object.keys(utm).length === 0 ? null : (utm as UtmParameters);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(sign(payload, secret), 'base64url');
  const provided = Buffer.from(signature, 'base64url');
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

function isReferralEnvelope(value: unknown): value is ReferralEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (
    typeof envelope.exp !== 'number' ||
    !Number.isSafeInteger(envelope.exp) ||
    typeof envelope.iat !== 'number' ||
    !Number.isSafeInteger(envelope.iat) ||
    (typeof envelope.ref !== 'string' && envelope.ref !== null) ||
    (typeof envelope.utm !== 'object' && envelope.utm !== null)
  )
    return false;
  const utm = envelope.utm as Record<string, unknown> | null;
  if (
    utm !== null &&
    Object.values(utm).some((entry) => typeof entry !== 'string')
  )
    return false;
  const query = new URLSearchParams(
    Object.entries(utm ?? {}).map(([key, entry]) => [
      `utm_${key}`,
      entry as string,
    ]),
  );
  return JSON.stringify(captureUtm(query)) === JSON.stringify(envelope.utm);
}
