import { emailCopy } from '../../copy/email.ts';
import { partnersCopy } from '../../copy/partners.ts';
import { createPartnerDigestRepository } from '../db/partner-digest.ts';
import type { DatabaseConnection } from '../db/pool.ts';
import type { TemplateRenderer } from '../email/service.ts';
import {
  renderEmailDocument,
  type EmailLink,
} from '../email/template-layout.ts';

import {
  readPartnerAnnouncement,
  type PartnerAnnouncement,
} from './announcement-content.ts';
import { partnerAnnouncementFlagsOff } from './announcement.ts';
import { dashboardRecoveryPath } from './config.ts';

// E11.7-16: the partner announcement's renderer. It is optional programme
// mail on the digest's send path: a broadcast from the Brevo domain, so
// dispatch sends it only while `email.broadcast` is on, with its own dispatch
// check in place of the marketing-consent check. That check re-reads the
// three announcement flags and requires what the digest's does: a verified
// member record and an active, unpurged partner who keeps optional programme
// email on. The email service checks suppression first. The subject and text
// are read from the announcement's content file at dispatch; the mail names
// no one, links the dashboard replacement request as the digest does, and
// carries the member's status link.

export interface PartnerAnnouncementRendererDependencies {
  readonly baseUrl: string;
  readonly sendingDomain: string;
  /** The dispatch consent check, in the dispatch transaction. */
  readonly eligible?: (
    connection: DatabaseConnection,
    subscriberId: string,
  ) => Promise<boolean>;
  /** Reads an announcement by id; the checked-in folder by default. */
  readonly announcement?: (id: string) => PartnerAnnouncement;
}

/** The announcement's own dispatch consent check (the digest's audience). */
export async function partnerAnnouncementDispatchEligible(
  connection: DatabaseConnection,
  subscriberId: string,
): Promise<boolean> {
  if ((await partnerAnnouncementFlagsOff(connection)).length > 0) return false;
  return createPartnerDigestRepository(connection).dispatchEligible(
    subscriberId,
  );
}

export function partnerAnnouncementRenderer(
  dependencies: PartnerAnnouncementRendererDependencies,
): TemplateRenderer {
  const origin = new URL(dependencies.baseUrl).origin;
  const from = `${emailCopy.senderName} <hello@${dependencies.sendingDomain}>`;
  const eligible = dependencies.eligible ?? partnerAnnouncementDispatchEligible;
  const read =
    dependencies.announcement ?? ((id: string) => readPartnerAnnouncement(id));
  return {
    kind: 'broadcast',
    dispatchConsent: ({ connection, subscriberId, recipient }) =>
      recipient.status === 'verified'
        ? eligible(connection, subscriberId)
        : Promise.resolve(false),
    async render({ email, payload, token, unsubscribePageUrl }) {
      const { announcement_id: id, status_token_id: statusTokenId } = payload;
      if (
        typeof id !== 'string' ||
        typeof statusTokenId !== 'string' ||
        statusTokenId === ''
      )
        throw new Error('email_template_reference_missing');
      const announcement = read(id);
      const status = new URL('/me', origin);
      status.searchParams.set('t', await token(statusTokenId));
      const copy = partnersCopy.email.announcement;
      const recovery: EmailLink = {
        label: copy.action,
        url: new URL(dashboardRecoveryPath, origin).toString(),
      };
      // The announcement's own links come first, so its first link is the
      // button; without one, the replacement request is.
      const [first = recovery, ...rest] = announcement.links.map(
        ({ label, path }): EmailLink => ({
          label,
          url: new URL(path, origin).toString(),
        }),
      );
      return renderEmailDocument({
        from,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: announcement.subject,
          preheader: copy.preheader,
          paragraphs: [...announcement.paragraphs, copy.dashboard, copy.choice],
          links: [
            first,
            ...rest,
            ...(first === recovery ? [] : [recovery]),
            { label: emailCopy.status, url: status.toString() },
          ],
        },
      });
    },
  };
}
