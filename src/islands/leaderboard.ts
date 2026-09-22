export const leaderboardPollIntervalMilliseconds = 5_000;

export interface PublicLeaderboardEntry {
  readonly confirmedReferrals: number;
  readonly displayHandle: string;
  readonly rank: number;
}

export interface PublicLeaderboardSnapshot {
  readonly asOf: string;
  readonly entries: readonly PublicLeaderboardEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function parseLeaderboardSnapshot(
  value: unknown,
): PublicLeaderboardSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.as_of !== 'string' ||
    Number.isNaN(Date.parse(value.as_of)) ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }

  const entries: PublicLeaderboardEntry[] = [];
  for (const candidate of value.entries) {
    if (
      !isRecord(candidate) ||
      !isNonNegativeInteger(candidate.confirmed_referrals) ||
      typeof candidate.display_handle !== 'string' ||
      candidate.display_handle === '' ||
      !isPositiveInteger(candidate.rank)
    ) {
      return null;
    }
    entries.push({
      confirmedReferrals: candidate.confirmed_referrals,
      displayHandle: candidate.display_handle,
      rank: candidate.rank,
    });
  }

  return Object.freeze({
    asOf: value.as_of,
    entries: Object.freeze(entries),
  });
}

export function snapshotAgeSeconds(asOf: string, now: Date): number {
  const snapshotTime = Date.parse(asOf);
  if (Number.isNaN(snapshotTime)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - snapshotTime) / 1_000));
}

export function formatSnapshotTimestamp(asOf: string): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    timeZone: 'UTC',
    timeZoneName: 'short',
    year: 'numeric',
  }).format(new Date(asOf));
}

export function leaderboardErrorMessage(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) {
    return null;
  }
  return typeof value.error.message === 'string' ? value.error.message : null;
}
