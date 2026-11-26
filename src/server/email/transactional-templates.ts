import { emailCopy } from '../../copy/email.ts';
import type { ReferralStatus } from '../referral/status.ts';
import { presentPartnerWelcomePerk } from '../referral/partner-welcome-presentation.ts';
import { presentReferralStatus } from '../referral/status-presentation.ts';

import {
  renderEmailDocument,
  type EmailDocument,
  type EmailLink,
} from './template-layout.ts';
import type { TemplateRenderer } from './service.ts';

export interface TransactionalTemplateData {
  referralStatus(statusTokenId: string): Promise<ReferralStatus>;
  /**
   * E11.8-04: whether another member, not a partner, referred the member,
   * while `email.referred_welcome_line` is on; false while it is off.
   */
  memberReferral(statusTokenId: string): Promise<boolean>;
  receiptEntries(statusTokenId: string, rulesVersion: string): Promise<number>;
  winnerDetails(
    awardId: string,
    statusTokenId: string,
  ): Promise<{ readonly deadline: Date; readonly rulesVersion: string }>;
}

export interface TransactionalTemplateDependencies {
  readonly baseUrl: string;
  readonly sendingDomain: string;
  readonly data: TransactionalTemplateData;
}

function reference(
  payload: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = payload[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error('email_template_reference_missing');
  }
  return value;
}

function rulesVersion(payload: Readonly<Record<string, unknown>>): string {
  const version = reference(payload, 'rules_version');
  if (!/^VAL-GW-[A-Z0-9]+-\d{8}-r[1-9]\d*$/u.test(version)) {
    throw new Error('email_template_rules_version_invalid');
  }
  return version;
}

function statusLink(baseUrl: string, token: string): string {
  const target = new URL('/me', baseUrl);
  target.searchParams.set('t', token);
  return target.toString();
}

function verifyLink(baseUrl: string, token: string): string {
  const target = new URL('/verify', baseUrl);
  target.searchParams.set('token', token);
  return target.toString();
}

function rulesLink(baseUrl: string, version: string): string {
  return new URL(`/giveaway/rules/${version}`, baseUrl).toString();
}

function awardLink(baseUrl: string, awardId: string, token: string): string {
  const target = new URL('/giveaway/award', baseUrl);
  target.searchParams.set('award', awardId);
  target.searchParams.set('t', token);
  return target.toString();
}

/**
 * The referral section both mails share with /me: the status facts, then the
 * coupon ladder and early access in the founder's form, from the one
 * presentation. The held condition is its own paragraph (ADR-012).
 */
function referralFacts(status: ReferralStatus): readonly string[] {
  const view = presentReferralStatus(status);
  return [
    ...view.fields.map(({ label, value }) => `${label}: ${value}`),
    view.ladder.line,
    view.earlyAccess.line,
  ];
}

export function createTransactionalRenderers(
  dependencies: TransactionalTemplateDependencies,
): ReadonlyMap<string, TemplateRenderer> {
  const base = new URL(dependencies.baseUrl);
  const from = `${emailCopy.senderName} <hello@${dependencies.sendingDomain}>`;
  const render = (
    document: EmailDocument,
    email: string,
    unsubscribePageUrl: string,
  ) =>
    renderEmailDocument({
      document,
      from,
      to: email,
      unsubscribePageUrl,
    });
  const link = (label: string, url: string): EmailLink => ({ label, url });

  const verification: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const verifyToken = await token(reference(payload, 'token_id'));
      return render(
        {
          subject: emailCopy.verify.subject,
          preheader: emailCopy.verify.preheader,
          paragraphs: [emailCopy.verify.firstLine, emailCopy.verify.body],
          links: [
            link(emailCopy.verify.action, verifyLink(base.origin, verifyToken)),
          ],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  const reminder: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const verifyToken = await token(reference(payload, 'token_id'));
      return render(
        {
          subject: emailCopy.reminder.subject,
          preheader: emailCopy.reminder.preheader,
          paragraphs: [emailCopy.reminder.firstLine, emailCopy.reminder.body],
          links: [
            link(
              emailCopy.reminder.action,
              verifyLink(base.origin, verifyToken),
            ),
          ],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  const welcome: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const statusTokenId = reference(payload, 'status_token_id');
      const [status, statusToken, memberReferral] = await Promise.all([
        dependencies.data.referralStatus(statusTokenId),
        token(statusTokenId),
        dependencies.data.memberReferral(statusTokenId),
      ]);
      const perk = presentPartnerWelcomePerk(status.partnerWelcomePerk);
      // A partner-referred member keeps only the partner line (E11.8-04).
      const referralLead =
        memberReferral && perk === null
          ? { lead: emailCopy.welcome.referredByMember }
          : {};
      return render(
        {
          subject: emailCopy.welcome.subject,
          preheader: emailCopy.welcome.preheader,
          paragraphs: [
            emailCopy.welcome.firstLine,
            emailCopy.welcome.body,
            ...(perk === null
              ? []
              : [perk.lead + (perk.code ?? '') + perk.benefits]),
            presentReferralStatus(status).ladder.held,
          ],
          facts: referralFacts(status),
          links: [
            link(emailCopy.status, statusLink(base.origin, statusToken)),
            {
              ...link(emailCopy.referral, status.referralLink),
              ...referralLead,
            },
            link(emailCopy.trust, new URL('/legit', base.origin).toString()),
          ],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  // No milestone email has been queued since E11.7-03 retired the tiers; one
  // already queued renders the member's current ladder instead of a tier.
  const milestone: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const statusTokenId = reference(payload, 'status_token_id');
      const [status, statusToken] = await Promise.all([
        dependencies.data.referralStatus(statusTokenId),
        token(statusTokenId),
      ]);
      return render(
        {
          subject: emailCopy.milestone.subject,
          preheader: emailCopy.milestone.preheader,
          paragraphs: [
            emailCopy.milestone.firstLine,
            presentReferralStatus(status).ladder.held,
          ],
          facts: referralFacts(status),
          links: [
            link(emailCopy.status, statusLink(base.origin, statusToken)),
            link(emailCopy.referral, status.referralLink),
          ],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  const status: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const statusToken = await token(reference(payload, 'token_id'));
      return render(
        {
          subject: emailCopy.statusLink.subject,
          preheader: emailCopy.statusLink.preheader,
          paragraphs: [
            emailCopy.statusLink.firstLine,
            emailCopy.statusLink.body,
          ],
          links: [link(emailCopy.status, statusLink(base.origin, statusToken))],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  const receipt: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const statusTokenId = reference(payload, 'status_token_id');
      const version = rulesVersion(payload);
      const [entries, statusToken] = await Promise.all([
        dependencies.data.receiptEntries(statusTokenId, version),
        token(statusTokenId),
      ]);
      if (!Number.isInteger(entries) || entries < 1) {
        throw new Error('email_template_receipt_entries_missing');
      }
      return render(
        {
          subject: emailCopy.receipt.subject,
          preheader: emailCopy.receipt.preheader,
          paragraphs: [
            emailCopy.receipt.firstLine,
            emailCopy.receipt.count(entries, version),
          ],
          links: [
            link(emailCopy.rules, rulesLink(base.origin, version)),
            link(emailCopy.status, statusLink(base.origin, statusToken)),
          ],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  const winner: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const awardId = reference(payload, 'award_id');
      const statusTokenId = reference(payload, 'token_id');
      const [details, statusToken] = await Promise.all([
        dependencies.data.winnerDetails(awardId, statusTokenId),
        token(statusTokenId),
      ]);
      return render(
        {
          subject: emailCopy.winner.subject,
          preheader: emailCopy.winner.preheader,
          paragraphs: [
            emailCopy.winner.firstLine,
            emailCopy.winner.deadline(details.deadline),
          ],
          links: [
            link(
              emailCopy.winner.action,
              awardLink(base.origin, awardId, statusToken),
            ),
            link(emailCopy.rules, rulesLink(base.origin, details.rulesVersion)),
            link(emailCopy.status, statusLink(base.origin, statusToken)),
          ],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  return new Map([
    ['verification_test', verification],
    ['verification_reminder', reminder],
    ['welcome', welcome],
    ['milestone_reached', milestone],
    ['status_link', status],
    ['giveaway_entry_receipt', receipt],
    ['giveaway_winner', winner],
  ]);
}
