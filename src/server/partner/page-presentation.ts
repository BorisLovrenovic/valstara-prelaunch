import { partnersCopy } from '../../copy/partners.ts';

import type {
  PartnerApplicationOutcome,
  PartnerFormError,
} from './application.ts';
import type { PartnerConfirmationOutcome } from './confirm.ts';
import { normaliseEmail } from '../subscriber/normalise-email.ts';

import { partnerApplicationLimits } from './config.ts';
import {
  emptyPartnerApplicationValues,
  type PartnerApplicationField,
  type PartnerApplicationValues,
} from './fields.ts';

type NoticeTone = 'error' | 'success' | 'info' | 'wait';

export interface PartnerApplyView {
  /** The card's `data-task-state`. */
  readonly state: string;
  readonly heading: string;
  readonly icon: 'people' | 'mail' | 'check' | 'pause' | 'link';
  readonly tone: 'accent' | 'neutral' | 'success' | 'error';
  readonly line: string | null;
  readonly notice: {
    readonly tone: NoticeTone;
    readonly message: string;
  } | null;
  /** Which form renders: the application, the link's confirmation, or none. */
  readonly form: 'application' | 'confirm' | null;
  readonly values: PartnerApplicationValues;
  readonly errors: Readonly<Partial<Record<PartnerApplicationField, string>>>;
  readonly alternatives: readonly string[];
  /** Whether "Apply again" follows (an unavailable link). */
  readonly applyAgain: boolean;
  readonly status: number;
}

const copy = partnersCopy.apply;

const blank = {
  values: emptyPartnerApplicationValues,
  errors: {},
  alternatives: [],
  applyAgain: false,
} as const;

function fieldMessages(
  errors: Readonly<Partial<Record<PartnerApplicationField, PartnerFormError>>>,
): Partial<Record<PartnerApplicationField, string>> {
  return Object.fromEntries(
    Object.entries(errors).map(([field, error]) => [
      field,
      copy.errors[error as PartnerFormError],
    ]),
  );
}

const paused: PartnerApplyView = {
  ...blank,
  state: 'paused',
  heading: copy.pausedHeading,
  icon: 'pause',
  tone: 'neutral',
  line: null,
  notice: { tone: 'info', message: copy.paused },
  form: null,
  status: 200,
};

/**
 * E11.7-12: the auto-invite's link pre-fills the email field from its
 * `email` query value. Only a well-formed address is used, as typed; anything
 * else leaves the field empty. It fills nothing else and is never stored.
 */
export function partnerApplyPrefillEmail(value: string | null): string {
  if (value === null) return '';
  const email = value.trim();
  if (
    email.length === 0 ||
    email.length > partnerApplicationLimits.email ||
    normaliseEmail(email) === null
  )
    return '';
  return email;
}

/**
 * What `/partners/apply` shows (E11.7-05): the application, the emailed
 * link's confirmation, or an outcome. A refused application comes back with
 * what was typed, each field's reason and the code's alternatives, all
 * rendered on the server. Presentation only.
 */
export function partnerApplyView(input: {
  readonly enabled: boolean;
  readonly token: string | null;
  readonly application: PartnerApplicationOutcome | null;
  readonly confirmation: PartnerConfirmationOutcome | null;
  /** E11.7-12: the invite link's address, already checked; empty for none. */
  readonly prefillEmail?: string;
}): PartnerApplyView {
  const { application, confirmation } = input;
  if (confirmation !== null) {
    switch (confirmation.kind) {
      case 'confirmed':
        return {
          ...blank,
          state: 'confirmed',
          heading: copy.confirmed.heading,
          icon: 'check',
          tone: 'success',
          line: copy.confirmed.line,
          notice: null,
          form: null,
          status: 200,
        };
      case 'invalid':
        return {
          ...blank,
          state: 'link-invalid',
          heading: copy.invalid.heading,
          icon: 'link',
          tone: 'neutral',
          line: copy.invalid.line,
          notice: null,
          form: null,
          applyAgain: true,
          status: 400,
        };
      case 'paused':
        return paused;
      case 'rate_limited':
      case 'unavailable':
        return {
          ...blank,
          state:
            confirmation.kind === 'rate_limited'
              ? 'confirm-rate-limited'
              : 'confirm-unavailable',
          heading: copy.confirm.heading,
          icon: 'mail',
          tone: 'accent',
          line: copy.confirm.line,
          notice:
            confirmation.kind === 'rate_limited'
              ? { tone: 'wait', message: copy.rateLimited }
              : { tone: 'error', message: copy.unavailable },
          form: 'confirm',
          status: confirmation.kind === 'rate_limited' ? 429 : 503,
        };
    }
  }
  if (application !== null) {
    switch (application.kind) {
      case 'paused':
        return paused;
      case 'accepted':
        return {
          ...blank,
          state: 'accepted',
          heading: copy.accepted.heading,
          icon: 'mail',
          tone: 'success',
          line: copy.accepted.line,
          notice: null,
          form: null,
          status: 200,
        };
      case 'refused':
        return {
          ...blank,
          state: 'refused',
          heading: copy.heading,
          icon: 'people',
          tone: 'accent',
          line: copy.line,
          notice: { tone: 'error', message: copy.refused },
          form: 'application',
          values: application.values,
          errors: fieldMessages(application.errors),
          alternatives: application.alternatives,
          status: 400,
        };
      case 'challenge_failed':
      case 'rate_limited':
      case 'unavailable':
        return {
          ...blank,
          state:
            application.kind === 'challenge_failed'
              ? 'check-failed'
              : application.kind === 'rate_limited'
                ? 'rate-limited'
                : 'unavailable',
          heading: copy.heading,
          icon: 'people',
          tone: 'accent',
          line: copy.line,
          notice:
            application.kind === 'challenge_failed'
              ? { tone: 'error', message: copy.challengeFailed }
              : application.kind === 'rate_limited'
                ? { tone: 'wait', message: copy.rateLimited }
                : { tone: 'error', message: copy.unavailable },
          form: 'application',
          values: application.values,
          status:
            application.kind === 'challenge_failed'
              ? 400
              : application.kind === 'rate_limited'
                ? 429
                : 503,
        };
    }
  }
  if (!input.enabled) return paused;
  if (input.token !== null) {
    return {
      ...blank,
      state: 'confirm',
      heading: copy.confirm.heading,
      icon: 'mail',
      tone: 'accent',
      line: copy.confirm.line,
      notice: null,
      form: 'confirm',
      status: 200,
    };
  }
  return {
    ...blank,
    state: 'application',
    heading: copy.heading,
    icon: 'people',
    tone: 'accent',
    line: copy.line,
    notice: null,
    form: 'application',
    values:
      input.prefillEmail === undefined || input.prefillEmail === ''
        ? emptyPartnerApplicationValues
        : { ...emptyPartnerApplicationValues, email: input.prefillEmail },
    status: 200,
  };
}
