import { partnerDashboardCopy } from '../../copy/partner-dashboard.ts';
import {
  createPartnerLeaderboardRepository,
  partnerLeaderboardTopSize,
} from '../db/partner-leaderboard.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import { maintenanceLoopIntervalMs } from '../subscriber/heartbeat-file.ts';

import { displayNameDisclosureVersion } from './config.ts';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function partnerLeaderboardLabel(
  name: string | null,
  version: number | null,
  showFullName: boolean,
): string {
  const generic = partnerDashboardCopy.leaderboard.genericName;
  if (name === null || version !== displayNameDisclosureVersion) return generic;
  const initials: string[] = [];
  for (const part of name.split(/\s+/u)) {
    const initial = [...graphemes.segment(part)].find(({ segment }) =>
      /\p{L}/u.test(segment),
    );
    if (initial !== undefined) initials.push(initial.segment.toUpperCase());
    if (initials.length === 2) break;
  }
  if (initials.length === 0) return generic;
  return showFullName
    ? name
    : initials.map((initial) => `${initial}.`).join(' ');
}

export function createPartnerLeaderboardJob(
  database: DatabasePool,
  isEnabled: () => Promise<boolean>,
  clock: () => Date,
) {
  return {
    async run() {
      if (!(await isEnabled())) return;
      await withTransaction(database, async (connection) => {
        const repository = createPartnerLeaderboardRepository(connection);
        const snapshot = await repository.lockSnapshot();
        if (snapshot === null)
          throw new Error('Missing partner leaderboard snapshot.');
        const now = clock();
        if (
          snapshot.as_of !== null &&
          now.getTime() - snapshot.as_of.getTime() <
            maintenanceLoopIntervalMs.scheduler_cycle
        )
          return;
        await repository.replaceSnapshot(now);
      });
    },
  };
}

export async function readPartnerLeaderboard(
  database: DatabasePool,
  viewerId: string,
) {
  const snapshot = await createPartnerLeaderboardRepository(database)
    .readForViewer(viewerId)
    .catch(() => null);
  if (snapshot === null) return null;
  return {
    asOf: snapshot.as_of.toISOString(),
    entries: snapshot.rows
      .filter((row) => row.rank <= partnerLeaderboardTopSize)
      .map((row) => ({
        rank: row.rank,
        confirmedSignups: row.confirmed_signups,
        label: partnerLeaderboardLabel(
          row.display_name,
          row.display_name_disclosure_version,
          row.show_on_leaderboard,
        ),
      })),
    ownRank:
      snapshot.rows.find((row) => row.partner_id === viewerId)?.rank ?? null,
  };
}
