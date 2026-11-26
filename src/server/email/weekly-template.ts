import { emailCopy } from '../../copy/email.ts';
import type { SharedLeaderboardSnapshot } from '../leaderboard/persisted.ts';

import {
  renderEmailDocument,
  type EmailDocument,
  type EmailLink,
} from './template-layout.ts';
import type { TemplateRenderer } from './service.ts';
import type { WeeklyNoteService } from './weekly-note.ts';

export function createWeeklyTemplate(input: {
  readonly baseUrl: string;
  readonly sendingDomain: string;
  readonly snapshotById: (
    id: string,
  ) => Promise<SharedLeaderboardSnapshot | null>;
  /**
   * E11.8-03: the founder note for a message whose run recorded one. Without
   * it, no message carries a note.
   */
  readonly note?: Pick<WeeklyNoteService, 'forDispatch'>;
}): TemplateRenderer {
  const baseUrl = new URL(input.baseUrl).origin;

  async function noteSection(
    period: unknown,
  ): Promise<EmailDocument['note'] | undefined> {
    // The payload carries the run's ISO week only when its run recorded a
    // note (E11.8-03); the payload check constrains its form.
    if (period === undefined) return undefined;
    if (typeof period !== 'string') throw new Error('weekly_reference_missing');
    const note = await input.note?.forDispatch(period);
    if (note === null || note === undefined) return undefined;
    const links: EmailLink[] = [];
    if (note.link !== null) {
      const url = new URL(note.link.path, baseUrl);
      if (url.origin !== baseUrl) throw new Error('weekly_note_off_origin');
      links.push({ label: note.link.label, url: url.toString() });
    }
    return {
      paragraphs: [emailCopy.weekly.noteHeading, ...note.paragraphs],
      links,
    };
  }

  return {
    kind: 'broadcast',
    async render({ email, payload, token, unsubscribePageUrl }) {
      const snapshotId = payload.snapshot_id;
      const statusTokenId = payload.status_token_id;
      if (typeof snapshotId !== 'string' || typeof statusTokenId !== 'string')
        throw new Error('weekly_reference_missing');
      const snapshot = await input.snapshotById(snapshotId);
      if (snapshot === null) throw new Error('weekly_snapshot_missing');
      const note = await noteSection(payload.period);
      const statusToken = await token(statusTokenId);
      const statusUrl = new URL('/me', baseUrl);
      statusUrl.searchParams.set('t', statusToken);
      return renderEmailDocument({
        from: `${emailCopy.senderName} <hello@${input.sendingDomain}>`,
        to: email,
        unsubscribePageUrl,
        document: {
          subject: emailCopy.weekly.subject,
          preheader: emailCopy.weekly.preheader,
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
          ...(note === undefined ? {} : { note }),
          links: [{ label: emailCopy.status, url: statusUrl.toString() }],
        },
      });
    },
  };
}
