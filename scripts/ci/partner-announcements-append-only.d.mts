export const announcementDirectory: string;

export interface AppendOnlyIssue {
  readonly message: string;
  readonly path: string;
  readonly scan: 'partner-announcements-append-only';
}

export function scanPartnerAnnouncementsAppendOnly(options: {
  readonly root: string;
  readonly base?: string | undefined;
}): AppendOnlyIssue[];
