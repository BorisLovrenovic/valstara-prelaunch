// E11.7-15: every new and changed email template of the partner programme,
// rendered from a seeded database (scripts/seed-partner-programme.ts) through
// the dispatch path (`prepareDispatchMessage`) with the renderers the
// dispatcher registers. Shared by the email audit
// (test/e11-7-15-partner-audit.test.ts) and the contact sheet
// (scripts/design/partner-contact-sheet.mjs), so the sheet shows what the
// audit checked. Only exports; run on its own it does nothing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createCampaignFlagRepository } from '../../src/server/db/campaign-flags.ts';
import type { QueuedEmailRow } from '../../src/server/db/email.ts';
import { createPartnerWelcomeRepository } from '../../src/server/db/partner-welcome.ts';
import type { DatabasePool } from '../../src/server/db/pool.ts';
import { withTransaction } from '../../src/server/db/transaction.ts';
import { createTransactionalEmailProducers } from '../../src/server/email/producers.ts';
import { createEmailQueue } from '../../src/server/email/queue.ts';
import {
  prepareDispatchMessage,
  type Message,
  type TemplateRenderer,
} from '../../src/server/email/service.ts';
import { createTransactionalTemplateData } from '../../src/server/email/transactional-template-data.ts';
import { createTransactionalRenderers } from '../../src/server/email/transactional-templates.ts';
import {
  partnerDigestTemplate,
  partnerInviteTemplate,
} from '../../src/server/partner/config.ts';
import { createPartnerDashboardRecovery } from '../../src/server/partner/dashboard-recovery.ts';
import {
  partnerDigestData,
  partnerDigestRenderer,
} from '../../src/server/partner/digest-template.ts';
import { createPartnerInviteJob } from '../../src/server/partner/milestone-mail.ts';
import {
  partnerApplicationRenderers,
  partnerInviteRenderer,
} from '../../src/server/partner/templates.ts';
import { createVerificationService } from '../../src/server/verification/service.ts';
import { deriveEmailToken } from '../../src/server/verification/token-derivation.ts';

/**
 * The templates E11.7 added or changed: the programme's nine, and the two
 * member emails E11.7-04 and E11.7-08 changed (the ladder, the held
 * condition and the partner-referred perk line).
 */
export const auditedTemplates = Object.freeze([
  'welcome',
  'milestone_reached',
  'partner_application_confirm',
  'partner_application_received',
  'partner_approved',
  'partner_rejected',
  'partner_dashboard_link',
  'partner_welcome',
  'partner_first_signup',
  'partner_invite',
  partnerDigestTemplate,
]);

/** The founder's digest note, which the shipped content file leaves empty. */
export const auditDigestNote = 'A sample founder note for the audit.';

export type AuditedRow = QueuedEmailRow & { readonly email: string };

export interface RenderedEmail {
  readonly row: AuditedRow;
  readonly message: Message;
}

/** The renderers the dispatcher registers (createResendDispatcher). */
export function registeredRenderers(
  database: DatabasePool,
  baseUrl: string,
): ReadonlyMap<string, TemplateRenderer> {
  return new Map([
    ...partnerApplicationRenderers(baseUrl, 'send.valstara.com', {
      welcomeCode: (tokenId) =>
        createPartnerWelcomeRepository(database).codeForDashboardToken(tokenId),
    }),
    ...createTransactionalRenderers({
      baseUrl,
      sendingDomain: 'send.valstara.com',
      data: createTransactionalTemplateData(database),
    }),
    [
      partnerInviteTemplate,
      partnerInviteRenderer(baseUrl, 'mail.valstara.com'),
    ],
    [
      partnerDigestTemplate,
      partnerDigestRenderer({
        baseUrl,
        sendingDomain: 'mail.valstara.com',
        data: partnerDigestData(database),
        // A run skips its period while the note file is empty (D-071 Q2).
        note: () => auditDigestNote,
      }),
    ],
  ]);
}

async function one<Row extends Record<string, unknown>>(
  database: DatabasePool,
  text: string,
): Promise<Row> {
  const row = await database.readOne<Row>({ text });
  assert.ok(row, text);
  return row;
}

/**
 * Queues the audited templates the seed leaves to switches it never sets,
 * through their own jobs and services, and returns the digest's row, which
 * its job would queue only with a founder note written.
 */
export async function queueRemainingTemplates(
  database: DatabasePool,
  options: { readonly tokenSecret: string; readonly actor: string },
): Promise<AuditedRow> {
  const clock = () => new Date();
  const flags = createCampaignFlagRepository(database);
  // The auto-invite is a broadcast, queued only while `email.broadcast` is on.
  await flags.set('email.broadcast', true, options.actor);
  try {
    const invited = await createPartnerInviteJob(database, {
      clock,
      email: createEmailQueue(database, clock),
      tokenSecret: options.tokenSecret,
    }).run(100);
    assert.equal(invited, 1, 'the consenting member at 10 referrals');
  } finally {
    await flags.set('email.broadcast', false, options.actor);
  }
  // A replacement dashboard link, through the recovery form's service.
  const standard = await one<{ email: string }>(
    database,
    `SELECT s.email FROM partner p JOIN subscriber s ON s.id = p.subscriber_id
      WHERE p.status = 'active' AND p.partner_type = 'standard'`,
  );
  const form = new FormData();
  form.set('email_address', standard.email);
  form.set('turnstile_token', 'passed-in-the-audit');
  assert.equal(
    await createPartnerDashboardRecovery(database, {
      isEnabled: async () => true,
      hashIpPrefix: () => 'e11715'.padEnd(64, '0'),
      verifyTurnstile: async () => 'verified',
      tokenSecret: options.tokenSecret,
      sleep: async () => undefined,
    })(form, '203.0.113.7'),
    'accepted',
  );
  // The milestone email: its renderer is registered and changed by E11.7-04,
  // although no code has queued it since E11.7-03 retired the tiers.
  const member = await one<{ id: string }>(
    database,
    'SELECT id FROM subscriber WHERE confirmed_referrals = 21',
  );
  await withTransaction(database, (connection) =>
    createTransactionalEmailProducers(database, clock).milestone(
      connection,
      member.id,
      1,
    ),
  );
  // The digest, as its job queues it (business key, period and status-token
  // reference), for the active creator, rendered for the current period.
  const creator = await one<{ subscriber_id: string; email: string }>(
    database,
    `SELECT p.subscriber_id, s.email FROM partner p
      JOIN subscriber s ON s.id = p.subscriber_id
      WHERE p.status = 'active' AND p.partner_type = 'creator'`,
  );
  const verification = createVerificationService(database, {
    clock,
    tokenSecret: options.tokenSecret,
  });
  const status = await verification.issue(creator.subscriber_id, 'status');
  const unsubscribe = await verification.issue(
    creator.subscriber_id,
    'unsubscribe',
  );
  const period = clock().toISOString().slice(0, 7);
  return {
    id: randomUUID(),
    subscriber_id: creator.subscriber_id,
    template: partnerDigestTemplate,
    provider: 'brevo',
    business_key: `partner-digest:${period}:audit`,
    payload: { period, status_token_id: status.id },
    unsubscribe_token_id: unsubscribe.id,
    attempts: 0,
    email: creator.email,
  };
}

/** Renders every queued audited email, and the digest, as dispatch would. */
export async function renderAuditedEmails(
  database: DatabasePool,
  options: {
    readonly baseUrl: string;
    readonly tokenSecret: string;
    readonly actor: string;
  },
): Promise<RenderedEmail[]> {
  const digest = await queueRemainingTemplates(database, options);
  const queued = await database.list<AuditedRow>(
    {
      text: `SELECT q.id, q.subscriber_id, q.template, q.provider,
          q.business_key, q.payload, q.unsubscribe_token_id, q.attempts,
          s.email
        FROM email_send q JOIN subscriber s ON s.id = q.subscriber_id
        WHERE q.template = ANY($1) ORDER BY q.template, q.created_at, q.id`,
      values: [auditedTemplates],
    },
    10_000,
  );
  const renderers = registeredRenderers(database, options.baseUrl);
  const rendered: RenderedEmail[] = [];
  for (const row of [...queued, digest]) {
    const renderer = renderers.get(row.template);
    assert.ok(renderer, row.template);
    const { message } = await prepareDispatchMessage({
      row,
      recipient: row.email,
      renderer,
      baseUrl: options.baseUrl,
      token: async (id) => deriveEmailToken(id, options.tokenSecret),
    });
    rendered.push({ row, message });
  }
  return rendered;
}
