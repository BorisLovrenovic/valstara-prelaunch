import { emailCopy } from '../../copy/email.ts';
import { partnerDashboardCopy } from '../../copy/partner-dashboard.ts';
import { partnersCopy } from '../../copy/partners.ts';
import type { TemplateRenderer } from '../email/service.ts';
import { renderEmailDocument } from '../email/template-layout.ts';

import {
  partnerConfirmationTemplate,
  partnerReceivedTemplate,
} from './application.ts';
import { dashboardPath } from './dashboard.ts';
import { partnerDashboardRecoveryTemplate } from './dashboard-recovery.ts';
import {
  partnerApprovedTemplate,
  partnerRejectedTemplate,
} from './review-email.ts';

/**
 * The partner programme's transactional emails. E11.7-05 (D-050 Q4): the
 * confirmation link sent on submit, and "application received" once the
 * application reaches `applied`. E11.7-06: "approved" at `approve`, and
 * "rejected" only when `reject --template` asks for it (D-052 Q2). None
 * carries an application field; each links the member's own status page.
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
  const statusUrl = async (
    payload: Readonly<Record<string, unknown>>,
    token: (id: string) => Promise<string>,
  ) => {
    if (
      typeof payload.status_token_id !== 'string' ||
      payload.status_token_id === ''
    ) {
      throw new Error('email_template_reference_missing');
    }
    const status = new URL('/me', origin);
    status.searchParams.set('t', await token(payload.status_token_id));
    return status.toString();
  };
  const approved: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const status = await statusUrl(payload, token);
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: partnersCopy.email.approved.subject,
          preheader: partnersCopy.email.approved.preheader,
          paragraphs: [
            partnersCopy.email.approved.firstLine,
            partnersCopy.email.approved.body,
          ],
          links: [
            { label: partnersCopy.email.approved.action, url: programmeUrl },
            { label: emailCopy.status, url: status },
          ],
        },
      });
    },
  };
  const rejected: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const status = await statusUrl(payload, token);
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: partnersCopy.email.rejected.subject,
          preheader: partnersCopy.email.rejected.preheader,
          paragraphs: [
            partnersCopy.email.rejected.firstLine,
            partnersCopy.email.rejected.body,
          ],
          links: [{ label: emailCopy.status, url: status }],
        },
      });
    },
  };
  const dashboardLink: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      if (typeof payload.token_id !== 'string' || payload.token_id === '') {
        throw new Error('email_template_reference_missing');
      }
      const target = new URL(dashboardPath, origin);
      target.searchParams.set('t', await token(payload.token_id));
      const copy = partnerDashboardCopy.mail;
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: copy.subject,
          preheader: copy.preheader,
          paragraphs: [copy.body],
          links: [{ label: copy.action, url: target.toString() }],
        },
      });
    },
  };
  return new Map([
    [partnerConfirmationTemplate, confirm],
    [partnerReceivedTemplate, received],
    [partnerApprovedTemplate, approved],
    [partnerRejectedTemplate, rejected],
    [partnerDashboardRecoveryTemplate, dashboardLink],
  ]);
}
