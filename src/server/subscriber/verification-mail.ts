import { thinSliceCopy } from '../../copy/e1-11.ts';

/**
 * The verification mail, queued and sent by the signup flow.
 *
 * This is still the deliberately minimal E1-11 test-mode sender: the row in
 * `email_send` is the source of truth, and this fire-and-forget send is best
 * effort. E3-06 owns the real verification-token module and E8-01 the email
 * service with `business_key` idempotency, suppression re-checked at dispatch,
 * and retry. Until then the signup service keeps queueing through here so a
 * send failure never rolls back the subscriber row.
 */
export interface VerificationTestMail {
  readonly businessKey: string;
  readonly verificationUrl: string;
}

export type VerificationMailSender = (
  mail: VerificationTestMail,
) => Promise<void>;

export function createResendTestMailSender(
  apiKey: string | undefined,
  testRecipient: string | undefined,
): VerificationMailSender {
  return async (mail) => {
    if (!apiKey || !testRecipient) {
      throw new Error('Resend test-mode configuration is unavailable.');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': mail.businessKey,
      },
      body: JSON.stringify({
        from: 'Valstara <onboarding@resend.dev>',
        subject: thinSliceCopy.verificationSubject,
        text: thinSliceCopy.verificationText(mail.verificationUrl),
        to: [testRecipient],
      }),
    });

    if (!response.ok) {
      throw new Error('Resend test-mode request failed.');
    }
  };
}
