import { emailCopy } from '../../copy/email.ts';
import { memberStatusCopy } from '../../copy/member-status.ts';
import type { ReferralStatus } from '../referral/status.ts';
import { presentReferralStatus } from '../referral/status-presentation.ts';

import {
  renderEmailDocument,
  type EmailDocument,
  type EmailLink,
} from './template-layout.ts';
import type { TemplateRenderer } from './service.ts';

export interface TransactionalTemplateData {
  referralStatus(statusTokenId: string): Promise<ReferralStatus>;
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

function referralFacts(status: ReferralStatus): readonly string[] {
  const view = presentReferralStatus(status);
  return [
    ...view.fields.map(({ label, value }) => `${label}: ${value}`),
    ...(view.rewards.length === 0
      ? [memberStatusCopy.rewards.empty]
      : view.rewards.map(
          (reward) => `${reward.tier}: ${reward.label} — ${reward.state}`,
        )),
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
      const [status, statusToken] = await Promise.all([
        dependencies.data.referralStatus(statusTokenId),
        token(statusTokenId),
      ]);
      return render(
        {
          subject: emailCopy.welcome.subject,
          preheader: emailCopy.welcome.preheader,
          paragraphs: [
            emailCopy.welcome.firstLine,
            emailCopy.welcome.body,
            memberStatusCopy.rewards.intro,
          ],
          facts: referralFacts(status),
          links: [
            link(emailCopy.status, statusLink(base.origin, statusToken)),
            link(emailCopy.referral, status.referralLink),
            link(emailCopy.trust, new URL('/legit', base.origin).toString()),
          ],
        },
        email,
        unsubscribePageUrl,
      );
    },
  };
  const milestone: TemplateRenderer = {
    kind: 'transactional',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const tier = payload.tier;
      if (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 1) {
        throw new Error('email_template_tier_invalid');
      }
      const statusTokenId = reference(payload, 'status_token_id');
      const [status, statusToken] = await Promise.all([
        dependencies.data.referralStatus(statusTokenId),
        token(statusTokenId),
      ]);
      if (!status.rewards.some((reward) => reward.tier === tier)) {
        throw new Error('email_template_milestone_missing');
      }
      return render(
        {
          subject: emailCopy.milestone.subject(tier),
          preheader: emailCopy.milestone.preheader,
          paragraphs: [
            emailCopy.milestone.firstLine(tier),
            emailCopy.milestone.body,
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
