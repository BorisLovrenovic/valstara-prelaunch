import { randomUUID } from 'node:crypto';

import type {
  SeedPlacement,
  SeedProvider,
  SeedTestRepository,
} from '../db/seed-test.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

export const seedProviders = ['gmail', 'outlook', 'gmx', 'web_de'] as const;
export const seedMissingAfterMs = 2 * 60 * 60 * 1_000;

export interface SeedSender {
  send(input: {
    readonly provider: SeedProvider;
    readonly marker: string;
    readonly businessKey: string;
  }): Promise<void>;
}

export interface SeedMailbox {
  placement(
    provider: SeedProvider,
    marker: string,
  ): Promise<'inbox' | 'spam' | null>;
}

export interface SeedTestAlert {
  send(input: {
    readonly provider: SeedProvider;
    readonly placement: 'spam' | 'missing';
    readonly weekStart: Date;
    readonly occurredAt: Date;
  }): Promise<void>;
}

export function createSeedTestAlert(alerts: AlertTransport): SeedTestAlert {
  return {
    async send(result) {
      await alerts.send({
        detail: {
          provider: result.provider,
          placement: result.placement,
          week_start: result.weekStart.toISOString().slice(0, 10),
        },
        event: 'email_seed_placement_failed',
        occurredAt: result.occurredAt,
        severity: 'P1',
      });
    },
  };
}

export interface SeedTestHealth {
  readonly weekStart: Date;
  readonly checkedAt: Date;
  readonly state: 'not_run' | 'current' | 'incomplete' | 'stale';
  readonly providers: readonly {
    readonly provider: SeedProvider;
    readonly placement: SeedPlacement | 'not_run';
    readonly sentAt: Date | null;
    readonly checkedAt: Date | null;
  }[];
}

export function seedWeekStart(now: Date): Date {
  const day = now.getUTCDay();
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday;
}

export async function seedTestHealth(
  repository: SeedTestRepository,
  clock: () => Date,
): Promise<SeedTestHealth> {
  const now = clock();
  const weekStart = seedWeekStart(now);
  const rows = await repository.latest();
  const inCurrentWeek =
    rows.length > 0 &&
    rows.every(
      (row) => row.week_start === weekStart.toISOString().slice(0, 10),
    );
  return {
    weekStart,
    checkedAt: now,
    state:
      rows.length === 0
        ? 'not_run'
        : !inCurrentWeek
          ? 'stale'
          : rows.length === 4
            ? 'current'
            : 'incomplete',
    providers: seedProviders.map((provider) => {
      const row = rows.find((candidate) => candidate.provider === provider);
      return {
        provider,
        placement: row?.placement ?? 'not_run',
        sentAt: row?.sent_at ?? null,
        checkedAt: row?.checked_at ?? null,
      };
    }),
  };
}

export function createSeedTestService(
  repository: SeedTestRepository,
  sender: SeedSender,
  mailbox: SeedMailbox,
  alerts: SeedTestAlert,
  clock: () => Date,
  makeMarker: () => string = randomUUID,
) {
  async function run(): Promise<SeedTestHealth> {
    const weekStart = seedWeekStart(clock());
    let failed = false;
    for (const provider of seedProviders) {
      try {
        const row = await repository.ensure(weekStart, provider, makeMarker());
        const businessKey = `seed:${weekStart.toISOString().slice(0, 10)}:${provider}`;
        const sentAt = row.sent_at ?? clock();
        if (row.sent_at === null) {
          await sender.send({ provider, marker: row.marker, businessKey });
          await repository.markSent(weekStart, provider, sentAt);
        }
        if (row.placement === 'inbox') continue;
        const observed = await mailbox.placement(provider, row.marker);
        const placement =
          observed ??
          (clock().getTime() - sentAt.getTime() >= seedMissingAfterMs
            ? 'missing'
            : null);
        if (placement !== null && placement !== row.placement) {
          await repository.markPlacement(
            weekStart,
            provider,
            placement,
            clock(),
          );
        }
        if (
          (placement === 'spam' || placement === 'missing') &&
          (row.alerted_at === null || row.placement !== placement)
        ) {
          const occurredAt = clock();
          await alerts.send({ provider, placement, weekStart, occurredAt });
          await repository.markAlerted(weekStart, provider, occurredAt);
        }
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('seed_test_failed');
    return seedTestHealth(repository, clock);
  }

  return { health: () => seedTestHealth(repository, clock), run };
}
