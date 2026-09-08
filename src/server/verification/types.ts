/**
 * The three token purposes (ADR-011, `docs/modules/verification.md`). A token
 * is bound to exactly one purpose at issue and is invalid for any other, so a
 * status link can never be replayed as a verification.
 */
export type TokenPurpose = 'verify' | 'status' | 'unsubscribe';

/**
 * The outcome of consuming a token.
 * - `verified`: a valid, unconsumed, unexpired token, consumed now (first use).
 * - `already`: a replay of an already-consumed token — a no-op the caller
 *   renders as success, because clicking a confirmation link twice is not a
 *   mistake.
 * - `expired`: a never-consumed token past its expiry.
 * - `invalid`: unknown, malformed, or issued for a different purpose.
 *
 * `expired` and `invalid` are distinct internally but MUST render identically
 * to the visitor (`customerOutcome`), because distinguishing them tells an
 * attacker which token hashes exist.
 */
export type ConsumeResult = 'verified' | 'already' | 'expired' | 'invalid';

/**
 * The collapsed, visitor-facing view of a `ConsumeResult`: success or not.
 * `expired` and `invalid` both collapse to `rejected`, so no customer-facing
 * surface can leak the distinction.
 */
export type CustomerOutcome = 'ok' | 'rejected';

export interface VerificationCompletionConsumeResult {
  readonly outcome: ConsumeResult;
  readonly subscriberId: string | null;
}
