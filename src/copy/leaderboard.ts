const rankLabel = 'Rank';

function confirmedReferralsLabel(count: number): string {
  return `confirmed ${count === 1 ? 'referral' : 'referrals'}`;
}

export const leaderboardCopy = {
  meta: {
    title: 'Valstara referral leaderboard',
    description:
      'See the anonymised Valstara waitlist leaderboard, ranked by confirmed referrals.',
  },
  heading: 'Referral leaderboard',
  introduction: 'Ranked by confirmed referrals, up to the top 10.',
  loading: 'Loading the latest leaderboard snapshot.',
  empty: 'No verified referrals appear in this snapshot yet.',
  paused: 'The leaderboard is paused right now.',
  unavailable:
    'The leaderboard is unavailable right now. Please check back shortly.',
  snapshotAsOf: 'Snapshot taken at',
  snapshotAge(seconds: number): string {
    if (seconds < 60) {
      return `Snapshot age: ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
    }
    const minutes = Math.floor(seconds / 60);
    return `Snapshot age: ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  },
  rankLabel,
  rank(rank: number): string {
    return `${rankLabel} ${rank}`;
  },
  handle(handle: string): string {
    return `Anonymous ${handle}`;
  },
  confirmedReferralsLabel,
  confirmedReferrals(count: number): string {
    return `${count} ${confirmedReferralsLabel(count)}`;
  },
} as const;

// Server-rendered panels beside the board. A separate export keeps them out of
// the island's client bundle, which must stay small enough to inline.
export const leaderboardPanelCopy = {
  counts: {
    heading: 'What counts',
    lines: [
      'Only referrals who verified their email address count.',
      'Counts are exact, and every person is shown as an anonymous handle.',
    ],
  },
  cta: {
    heading: 'Get your own referral link',
    join: 'Join the waitlist',
    member:
      'Already joined? Open your status page from the link in our emails.',
  },
} as const;
