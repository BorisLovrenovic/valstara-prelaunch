export const leaderboardCopy = {
  meta: {
    title: 'Valstara referral leaderboard',
    description:
      'See the anonymised Valstara waitlist leaderboard, ranked by confirmed referrals.',
  },
  heading: 'Referral leaderboard',
  introduction:
    'Confirmed referrals only. The board is anonymised and shows the latest cached snapshot.',
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
  rank(rank: number): string {
    return `Rank ${rank}`;
  },
  handle(handle: string): string {
    return `Anonymous ${handle}`;
  },
  confirmedReferrals(count: number): string {
    return `${count} confirmed ${count === 1 ? 'referral' : 'referrals'}`;
  },
} as const;
