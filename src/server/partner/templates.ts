import { emailCopy } from '../../copy/email.ts';
import { partnerDashboardCopy } from '../../copy/partner-dashboard.ts';
import { partnersCopy } from '../../copy/partners.ts';
import type { TemplateRenderer } from '../email/service.ts';
import { renderEmailDocument } from '../email/template-layout.ts';

import {
  partnerConfirmationTemplate,
  partnerReceivedTemplate,
} from './application.ts';
import {
  dashboardPath,
  dashboardRecoveryPath,
  flyerPath,
  partnerDashboardRecoveryTemplate,
  partnerFirstSignupTemplate,
  partnerInviteThreshold,
  partnerWelcomeTemplate,
} from './config.ts';
import { hasKitDownloads, partnerKit, type PartnerKit } from './kit.ts';
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
 * E11.7-11 (D-057): the partner welcome, with a fresh private dashboard link,
 * the code and `/r/{CODE}` link, the print flyer and the three-step checklist.
 */
export interface PartnerRendererDependencies {
  /** The partner code of a welcome's dashboard link, read at dispatch. */
  readonly welcomeCode?: (tokenId: string) => Promise<string | null>;
  readonly kit?: PartnerKit;
}

export function partnerApplicationRenderers(
  baseUrl: string,
  sendingDomain: string,
  dependencies: PartnerRendererDependencies = {},
): ReadonlyMap<string, TemplateRenderer> {
  const kit = dependencies.kit ?? partnerKit;
  const welcomeCode = dependencies.welcomeCode ?? (async () => null);
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
  const welcome: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      if (typeof payload.token_id !== 'string' || payload.token_id === '') {
        throw new Error('email_template_reference_missing');
      }
      const bearer = await token(payload.token_id);
      const code = await welcomeCode(payload.token_id);
      if (code === null || !/^[A-Z0-9]{4,16}$/u.test(code)) {
        throw new Error('email_token_missing');
      }
      const dashboard = new URL(dashboardPath, origin);
      dashboard.searchParams.set('t', bearer);
      const flyer = new URL(flyerPath, origin);
      flyer.searchParams.set('t', bearer);
      const link = new URL(`/r/${code}`, origin).toString();
      const copy = partnerDashboardCopy.welcome;
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: copy.subject,
          preheader: copy.preheader,
          paragraphs: [
            copy.firstLine,
            copy.dashboard,
            copy.checklist,
            ...copy.steps,
            ...(hasKitDownloads(kit) ? [copy.kitFiles] : []),
          ],
          facts: [copy.code(code), copy.link(link)],
          links: [
            { label: copy.action, url: dashboard.toString() },
            { label: copy.flyer, url: flyer.toString() },
          ],
        },
      });
    },
  };
  // E11.7-12: the first confirmed partner signup. It carries no new
  // dashboard link, because issuing one would cancel the welcome's link; the
  // replacement request is the partner's own choice.
  const firstSignup: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const status = await statusUrl(payload, token);
      const copy = partnersCopy.email.firstSignup;
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: copy.subject,
          preheader: copy.preheader,
          paragraphs: [copy.firstLine, copy.body, copy.dashboard],
          links: [
            {
              label: copy.action,
              url: new URL(dashboardRecoveryPath, origin).toString(),
            },
            { label: emailCopy.status, url: status },
          ],
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
    [partnerWelcomeTemplate, welcome],
    [partnerFirstSignupTemplate, firstSignup],
  ]);
}

/**
 * E11.7-12: the auto-invite. It is marketing (ADR-027), so it is a broadcast
 * from the Brevo domain: dispatch sends it only while `email.broadcast` is on
 * and re-checks verification, marketing consent and suppression, and its
 * unsubscribe withdraws marketing consent only. The application link carries
 * the recipient's own address, added at render time, so the queued payload
 * stays references only.
 */
export function partnerInviteRenderer(
  baseUrl: string,
  sendingDomain: string,
): TemplateRenderer {
  const origin = new URL(baseUrl).origin;
  const from = `${emailCopy.senderName} <hello@${sendingDomain}>`;
  return {
    kind: 'broadcast',
    async render({ email, payload, token, unsubscribePageUrl }) {
      if (
        typeof payload.status_token_id !== 'string' ||
        payload.status_token_id === ''
      ) {
        throw new Error('email_template_reference_missing');
      }
      const status = new URL('/me', origin);
      status.searchParams.set('t', await token(payload.status_token_id));
      const apply = new URL('/partners/apply', origin);
      apply.searchParams.set('email', email);
      const copy = partnersCopy.email.invite;
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: copy.subject,
          preheader: copy.preheader,
          paragraphs: [
            copy.firstLine(partnerInviteThreshold),
            copy.body,
            copy.review,
          ],
          links: [
            { label: copy.action, url: apply.toString() },
            {
              label: copy.programme,
              url: new URL('/partners', origin).toString(),
            },
            { label: emailCopy.status, url: status.toString() },
          ],
        },
      });
    },
  };
}
