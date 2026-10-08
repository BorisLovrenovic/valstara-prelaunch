import { getConfig, getP1AlertConfiguration } from '../config.ts';
import { createAlertWebhookTransport } from '../verification-rate/p1-webhook.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

/**
 * Server-side verification of Cloudflare Turnstile tokens — the only consumer
 * of the Turnstile secret (`docs/modules/platform.md#turnstile`, ADR-006).
 *
 * The whole design is the distinction between "this token is invalid" and "we
 * could not reach the provider", because getting it backwards either opens the
 * door or rejects real people:
 *
 * - `verified`    — the provider confirmed the token.
 * - `rejected`    — the provider gave a verdict that the token is bad
 *                   (invalid, missing, or already redeemed → a replay). Fail
 *                   closed: the caller rejects the request.
 * - `unavailable` — no verdict was obtained (network error, timeout, a non-2xx
 *                   response, a malformed body, or a configuration/internal
 *                   error that is not the visitor's fault). The caller accepts
 *                   the request, applies strict rate limits, and flags the row
 *                   for review. A secret configuration fault alerts P1; other
 *                   unavailable outcomes alert P2.
 *
 * E1-11 verified tokens inline and failed closed on *every* failure, including a
 * timeout; the `unavailable` branch is the behaviour this module adds.
 */
export type TurnstileOutcome = 'verified' | 'rejected' | 'unavailable';
export type TurnstileUnavailableReason =
  'secret_configuration' | 'provider_unavailable';

export interface TurnstileVerifier {
  /**
   * `ip` is the documented swap interface (`docs/architecture/modules.md`
   * `verify(token, ip)`) and is forwarded to the provider as `remoteip` when
   * given. The signup route deliberately omits it so the raw client address
   * stays confined to the truncate-then-hash rate-limit path (standing rule 9).
   */
  verify(token: string, ip?: string): Promise<TurnstileOutcome>;
}

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_TIMEOUT_MS = 5_000;

// Error codes that attribute the failure to the token itself — a definitive
// "this token is not valid" verdict, so the caller rejects. `timeout-or-
// duplicate` is Cloudflare's code for a token that was already redeemed, which
// is exactly the replay case. Any other code (missing/invalid secret, a
// bad-request, or an internal-error on Cloudflare's side) is not the visitor's
// fault, so it falls through to `unavailable` rather than rejecting a real
// person for a problem they did not cause.
const tokenFailureCodes = new Set([
  'invalid-input-response',
  'missing-input-response',
  'timeout-or-duplicate',
]);
const secretFailureCodes = new Set([
  'missing-input-secret',
  'invalid-input-secret',
]);
const alertDeduplicationMilliseconds = 60 * 60 * 1_000;

interface SiteverifyResult {
  readonly success: boolean;
  readonly errorCodes: readonly string[];
}

function parseSiteverify(body: unknown): SiteverifyResult | null {
  if (typeof body !== 'object' || body === null || !('success' in body)) {
    return null;
  }
  const success = (body as { success: unknown }).success;
  if (typeof success !== 'boolean') {
    return null;
  }
  const rawCodes = (body as { 'error-codes'?: unknown })['error-codes'];
  const errorCodes = Array.isArray(rawCodes)
    ? rawCodes.filter((code): code is string => typeof code === 'string')
    : [];
  return { errorCodes, success };
}

function classify(
  result: SiteverifyResult,
): 'verified' | 'rejected' | TurnstileUnavailableReason {
  if (result.success) {
    return 'verified';
  }
  if (result.errorCodes.some((code) => secretFailureCodes.has(code))) {
    return 'secret_configuration';
  }
  // A verdict was returned, but only reject when the failure is attributable to
  // the token. An empty or non-token error set means we cannot blame the
  // visitor, so we accept-and-flag rather than reject.
  if (
    result.errorCodes.length > 0 &&
    result.errorCodes.every((code) => tokenFailureCodes.has(code))
  ) {
    return 'rejected';
  }
  return 'provider_unavailable';
}

export interface TurnstileVerifierOptions {
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onUnavailable?: (
    reason: TurnstileUnavailableReason,
  ) => Promise<void>;
}

/** One successful alert per fault class per hour per app process. */
export function createTurnstileUnavailableReporter(
  alerts: AlertTransport,
  clock: () => Date = () => new Date(),
) {
  const lastSent = new Map<TurnstileUnavailableReason, number>();
  const pending = new Map<TurnstileUnavailableReason, Promise<void>>();
  return {
    async report(reason: TurnstileUnavailableReason) {
      const existing = pending.get(reason);
      if (existing) return existing;
      const now = clock();
      const previous = lastSent.get(reason);
      if (
        previous !== undefined &&
        now.getTime() - previous < alertDeduplicationMilliseconds
      )
        return;
      const attempt = alerts
        .send({
          detail: { reason },
          event: 'turnstile_unavailable',
          occurredAt: now,
          severity: reason === 'secret_configuration' ? 'P1' : 'P2',
        })
        .then(() => {
          lastSent.set(reason, now.getTime());
        })
        .finally(() => {
          pending.delete(reason);
        });
      pending.set(reason, attempt);
      return attempt;
    },
  };
}

export function createTurnstileVerifier(
  options: TurnstileVerifierOptions,
): TurnstileVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reporter = options.onUnavailable;
  async function unavailable(
    reason: TurnstileUnavailableReason,
  ): Promise<TurnstileOutcome> {
    try {
      await reporter?.(reason);
    } catch {
      process.stderr.write(
        `${JSON.stringify({ event: 'turnstile_alert_failed', code: 'alert_unavailable' })}\n`,
      );
    }
    return 'unavailable';
  }

  return {
    async verify(token, ip) {
      // An absent token never reached a real challenge — it is invalid, not a
      // provider problem, and there is nothing to ask Cloudflare about.
      if (token === '') {
        return 'rejected';
      }

      const body = new URLSearchParams({
        response: token,
        secret: options.secret,
      });
      if (ip !== undefined && ip !== '') {
        body.set('remoteip', ip);
      }

      let response: Response;
      try {
        response = await fetchImpl(SITEVERIFY_URL, {
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Network error, DNS failure, or the timeout aborting the request:
        // unreachable, not a verdict. Never surface the error (it must not
        // leak the secret) — the outcome is the whole contract.
        return unavailable('provider_unavailable');
      }

      if (!response.ok) {
        return unavailable('provider_unavailable');
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return unavailable('provider_unavailable');
      }

      const result = parseSiteverify(payload);
      if (result === null) return unavailable('provider_unavailable');
      const classification = classify(result);
      return classification === 'verified' || classification === 'rejected'
        ? classification
        : unavailable(classification);
    },
  };
}

let defaultVerifier: TurnstileVerifier | undefined;

const defaultReporter = createTurnstileUnavailableReporter({
  send: (alert) =>
    createAlertWebhookTransport(getP1AlertConfiguration()).send(alert),
});

function getDefaultVerifier(): TurnstileVerifier {
  defaultVerifier ??= createTurnstileVerifier({
    secret: getConfig().turnstileSecretKey,
    onUnavailable: defaultReporter.report,
  });
  return defaultVerifier;
}

/**
 * The application entry point: verify a token with the configured secret. The
 * secret is read here and nowhere a route can see it.
 */
export function verifyTurnstileToken(
  token: string,
  ip?: string,
): Promise<TurnstileOutcome> {
  return getDefaultVerifier().verify(token, ip);
}
