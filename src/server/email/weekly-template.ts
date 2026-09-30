import { emailCopy } from '../../copy/email.ts';
import type { SharedLeaderboardSnapshot } from '../leaderboard/persisted.ts';

import { renderEmailDocument } from './template-layout.ts';
import type { TemplateRenderer } from './service.ts';

export function createWeeklyTemplate(input: {
  readonly baseUrl: string;
  readonly sendingDomain: string;
  readonly snapshotById: (
    id: string,
  ) => Promise<SharedLeaderboardSnapshot | null>;
}): TemplateRenderer {
  const baseUrl = new URL(input.baseUrl).origin;
  return {
    kind: 'broadcast',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const snapshotId = payload.snapshot_id;
      const statusTokenId = payload.status_token_id;
      if (typeof snapshotId !== 'string' || typeof statusTokenId !== 'string')
        throw new Error('weekly_reference_missing');
      const snapshot = await input.snapshotById(snapshotId);
      if (snapshot === null) throw new Error('weekly_snapshot_missing');
      const statusToken = await token(statusTokenId);
      const statusUrl = new URL('/me', baseUrl);
      statusUrl.searchParams.set('t', statusToken);
      return renderEmailDocument({
        from: `${emailCopy.senderName} <hello@${input.sendingDomain}>`,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: emailCopy.weekly.subject,
          paragraphs: [
            emailCopy.weekly.firstLine,
            emailCopy.weekly.leaderboardHeading,
            emailCopy.weekly.snapshotAsOf(snapshot.asOf),
          ],
          facts:
            snapshot.entries.length === 0
              ? [emailCopy.weekly.empty]
              : snapshot.entries.map((entry) =>
                  emailCopy.weekly.entry(
                    entry.rank,
                    entry.displayHandle,
                    entry.confirmedReferrals,
                  ),
                ),
          links: [{ label: emailCopy.status, url: statusUrl.toString() }],
        },
      });
    },
  };
}
