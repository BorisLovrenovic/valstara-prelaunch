import { emailCopy } from '../../copy/email.ts';
import { partnersCopy } from '../../copy/partners.ts';
import type { TemplateRenderer } from '../email/service.ts';
import { renderEmailDocument } from '../email/template-layout.ts';

import {
  partnerConfirmationTemplate,
  partnerReceivedTemplate,
} from './application.ts';

/**
 * The partner application's two transactional emails (D-050 Q4): the
 * confirmation link sent on submit, and "application received" once the
 * application reaches `applied`. Neither carries an application field.
 */
export function partnerApplicationRenderers(
  baseUrl: string,
  sendingDomain: string,
): ReadonlyMap<string, TemplateRenderer> {
  const origin = new URL(baseUrl).origin;
  const from = `${emailCopy.senderName} <hello@${sendingDomain}>`;
  const programmeUrl = new URL('/partners', origin).toString();

  const confirm: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      if (typeof payload.token_id !== 'string' || payload.token_id === '') {
        throw new Error('email_template_reference_missing');
      }
      const target = new URL('/partners/apply', origin);
      target.searchParams.set('token', await token(payload.token_id));
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: partnersCopy.email.confirm.subject,
          preheader: partnersCopy.email.confirm.preheader,
          paragraphs: [
            partnersCopy.email.confirm.firstLine,
            partnersCopy.email.confirm.body,
          ],
          links: [
            {
              label: partnersCopy.email.confirm.action,
              url: target.toString(),
            },
          ],
        },
      });
    },
  };
  const received: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      if (
        typeof payload.status_token_id !== 'string' ||
        payload.status_token_id === ''
      ) {
        throw new Error('email_template_reference_missing');
      }
      const status = new URL('/me', origin);
      status.searchParams.set('t', await token(payload.status_token_id));
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: partnersCopy.email.received.subject,
          preheader: partnersCopy.email.received.preheader,
          paragraphs: [
            partnersCopy.email.received.firstLine,
            partnersCopy.email.received.body,
          ],
          links: [
            { label: partnersCopy.email.received.action, url: programmeUrl },
            { label: emailCopy.status, url: status.toString() },
          ],
        },
      });
    },
  };
  return new Map([
    [partnerConfirmationTemplate, confirm],
    [partnerReceivedTemplate, received],
  ]);
}
