import type { EmailQuotaConfiguration } from '../config.ts';
import {
  createEmailQuotaRepository,
  type QuotaProvider,
} from '../db/email-quota.ts';
import type { DatabasePool } from '../db/pool.ts';
import { withTransaction } from '../db/transaction.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

const dayMs = 24 * 60 * 60 * 1_000;
const providers = ['resend', 'brevo'] as const;

export interface ProviderQuotaHealth {
  readonly provider: QuotaProvider;
  readonly tier: 'free' | 'paid';
  readonly cap: number;
  readonly dailyConsumption: readonly { day: string; accepted: number }[];
  readonly todayConsumption: number;
  readonly forecast: number;
  readonly alertState: 'none' | 'P2' | 'P1';
}

export interface EmailQuotaHealth {
  readonly checkedAt: Date;
  readonly providers: readonly ProviderQuotaHealth[];
}

export function quotaForecast(daily: readonly number[], audience = 0): number {
  if (
    daily.length !== 7 ||
    daily.some((count) => !Number.isSafeInteger(count) || count < 0)
  )
    throw new RangeError(
      'Quota projection requires seven nonnegative daily counts.',
    );
  if (!Number.isSafeInteger(audience) || audience < 0)
    throw new RangeError('Quota audience must be nonnegative.');
  const slope =
    daily.reduce((sum, count, index) => sum + (index - 3) * count, 0) / 28;
  return Math.max(Math.max(...daily) + 7 * Math.max(0, slope), audience);
}

export async function quotaHealth(
  database: DatabasePool,
  configuration: EmailQuotaConfiguration,
  clock: () => Date,
): Promise<EmailQuotaHealth> {
  const now = clock();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const start = new Date(today - 7 * dayMs);
  const end = new Date(today + dayMs);
  const repository = createEmailQuotaRepository(database);
  const [rows, audience] = await Promise.all([
    repository.dailyAccepted(start, end),
    repository.currentBroadcastAudience(),
  ]);
  return {
    checkedAt: now,
    providers: providers.map((provider): ProviderQuotaHealth => {
      const counts = Array.from({ length: 8 }, (_, index) => {
        const day = new Date(start.getTime() + index * dayMs)
          .toISOString()
          .slice(0, 10);
        return {
          day,
          accepted: Number(
            rows.find((row) => row.provider === provider && row.day === day)
              ?.total ?? '0',
          ),
        };
      });
      const dailyConsumption = counts.slice(0, 7);
      const todayConsumption = counts[7]?.accepted ?? 0;
      const cap = configuration[provider].cap;
      const forecast = quotaForecast(
        dailyConsumption.map(({ accepted }) => accepted),
        provider === 'brevo' ? audience : 0,
      );
      return {
        provider,
        tier: configuration[provider].tier,
        cap,
        dailyConsumption,
        todayConsumption,
        forecast,
        alertState: counts.some(({ accepted }) => accepted >= cap)
          ? 'P1'
          : forecast >= cap
            ? 'P2'
            : 'none',
      };
    }),
  };
}

export function createEmailQuotaService(
  database: DatabasePool,
  configuration: EmailQuotaConfiguration,
  alerts: AlertTransport,
  clock: () => Date,
) {
  const health = (): Promise<EmailQuotaHealth> =>
    quotaHealth(database, configuration, clock);

  return {
    health,
    async run(): Promise<EmailQuotaHealth> {
      const result = await health();
      const day = result.checkedAt.toISOString().slice(0, 10);
      for (const provider of result.providers) {
        if (provider.alertState === 'none') continue;
        const severity = provider.alertState;
        await withTransaction(database, async (connection) => {
          const repository = createEmailQuotaRepository(connection);
          await repository.lockAlert(provider.provider, day);
          if (await repository.hasAlert(provider.provider, day, severity))
            return;
          await alerts.send({
            event: 'email_quota_headroom',
            detail: {
              provider: provider.provider,
              cap: provider.cap,
              forecast: provider.forecast,
              severity,
            },
            occurredAt: result.checkedAt,
            severity,
          });
          await repository.recordAlert(
            provider.provider,
            day,
            severity,
            result.checkedAt,
          );
        });
      }
      return result;
    },
  };
}
