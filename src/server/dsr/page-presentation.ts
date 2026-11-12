import { dsrCopy } from '../../copy/dsr.ts';
import type { DsrOperation, DsrOutcome } from './http.ts';

export type DsrPageOutcome = Exclude<DsrOutcome['kind'], 'export'>;
export type TaskTone = 'accent' | 'neutral' | 'success' | 'error';
export type TaskNoticeTone = 'error' | 'success' | 'info' | 'wait';

export interface DsrPageView {
  /** The card's `data-task-state`. */
  readonly state: string;
  readonly heading: string;
  readonly icon: 'shield' | 'download' | 'erase' | 'clock';
  readonly tone: TaskTone;
  readonly line: string | null;
  readonly notice: {
    readonly tone: TaskNoticeTone;
    readonly message: string;
  } | null;
  /** Which form renders: the email request, the signed-link confirmation, or none. */
  readonly form: 'request' | 'confirm' | null;
  /** Whether the privacy-notice link follows. */
  readonly privacyLink: boolean;
}

const outcomeState: Record<DsrPageOutcome, string> = {
  accepted: 'accepted',
  pending: 'pending',
  export_used: 'used',
  invalid: 'invalid',
  unavailable: 'unavailable',
  rate_limited: 'rate-limited',
  challenge_failed: 'check-failed',
};

const outcomeNotice: Record<
  DsrPageOutcome,
  { readonly tone: TaskNoticeTone; readonly message: string }
> = {
  accepted: { tone: 'success', message: dsrCopy.accepted },
  pending: { tone: 'success', message: dsrCopy.pending },
  export_used: { tone: 'info', message: dsrCopy.exportUsed },
  invalid: { tone: 'info', message: dsrCopy.invalid },
  unavailable: { tone: 'error', message: dsrCopy.unavailable },
  rate_limited: { tone: 'wait', message: dsrCopy.rateLimited },
  challenge_failed: { tone: 'error', message: dsrCopy.challengeFailed },
};

/**
 * What `/dsr` shows (E11.5-11t, founder decision 2026-11-12, canvas frames 06
 * to 15): the request or confirmation form on GET, and after a POST the
 * outcome as a notice from the existing `dsrCopy` strings. Accepted and
 * erasure pending close the form; every other outcome brings the request form
 * back, empty: no typed address is ever echoed. Presentation only.
 */
export function dsrPageView(
  operation: DsrOperation,
  hasToken: boolean,
  outcome: DsrPageOutcome | null,
): DsrPageView {
  const copy = dsrCopy[operation];
  if (outcome === null) {
    return hasToken
      ? {
          state: `${operation}-confirm`,
          heading: copy.heading,
          icon: operation === 'export' ? 'download' : 'erase',
          tone: 'accent',
          line: copy.body,
          notice: null,
          form: 'confirm',
          // Frame 08 (export) has no link; frame 09 keeps it for the caveat.
          privacyLink: operation === 'delete',
        }
      : {
          state: `${operation}-request`,
          heading: copy.heading,
          icon: 'shield',
          tone: 'accent',
          line: copy.body,
          notice: null,
          form: 'request',
          privacyLink: true,
        };
  }
  if (outcome === 'pending') {
    // Frame 10: the clock on a neutral tile, the notice and nothing else.
    return {
      state: `${operation}-${outcomeState[outcome]}`,
      heading: copy.heading,
      icon: 'clock',
      tone: 'neutral',
      line: null,
      notice: outcomeNotice[outcome],
      form: null,
      privacyLink: false,
    };
  }
  return {
    state: `${operation}-${outcomeState[outcome]}`,
    heading: copy.heading,
    icon: 'shield',
    tone: 'accent',
    line: copy.body,
    notice: outcomeNotice[outcome],
    form: outcome === 'accepted' ? null : 'request',
    privacyLink: true,
  };
}
