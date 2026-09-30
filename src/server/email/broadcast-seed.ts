import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';

import { emailCopy } from '../../copy/email.ts';
import {
  createBroadcastSeedRepository,
  type BroadcastSeedState,
} from '../db/broadcast-seed-test.ts';
import type { DatabasePool } from '../db/pool.ts';
import type { SeedProvider } from '../db/seed-test.ts';
import type { AlertTransport } from '../verification-rate/p1-webhook.ts';

import {
  seedMissingAfterMs,
  seedProviders,
  seedWeekStart,
} from './seed-test.ts';
import type { EmailProvider } from './service.ts';

export interface BroadcastSeedMailbox {
  source(provider: SeedProvider, marker: string): Promise<Buffer | null>;
}

export async function inspectBroadcastSeed(
  source: Buffer,
  marker: string,
  expectedUrl: string,
): Promise<Exclude<BroadcastSeedState, 'pending' | 'missing'>> {
  const parsed = await simpleParser(source, { skipHtmlToText: true });
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  if (!parsed.text?.includes(marker)) return 'missing_plain_part';
  if (/<img\b/iu.test(html)) return 'tracking_pixel';
  const plainLinks = [...parsed.text.matchAll(/https?:\/\/[^\s<>]+/giu)].map(
    (match) => match[0],
  );
  const links = [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/giu)].map(
    (match) => match[1],
  );
  if (
    plainLinks.length !== 1 ||
    plainLinks[0] !== expectedUrl ||
    links.length !== 1 ||
    links[0] !== expectedUrl
  )
    return 'rewritten_link';
  return 'passed';
}

export function createBroadcastSeedSender(
  provider: EmailProvider,
  addresses: Readonly<Record<SeedProvider, string>>,
  baseUrl: string,
) {
  const expectedUrl = new URL('/', baseUrl).toString();
  return {
    expectedUrl,
    async send(
      destination: SeedProvider,
      marker: string,
      businessKey: string,
    ): Promise<void> {
      await provider.send({
        message: {
          from: `${emailCopy.senderName} <hello@${provider.sendingDomain}>`,
          to: addresses[destination],
          subject: emailCopy.seed.subject(marker),
          text: emailCopy.seed.broadcastText(marker, expectedUrl),
          html: emailCopy.seed.broadcastHtml(marker, expectedUrl),
        },
        idempotencyKey: businessKey,
        headers: {},
      });
    },
  };
}

export function createBroadcastSeedTest(
  database: DatabasePool,
  sender: ReturnType<typeof createBroadcastSeedSender>,
  mailbox: BroadcastSeedMailbox,
  alerts: AlertTransport,
  clock: () => Date,
  makeMarker: () => string = randomUUID,
) {
  const repository = createBroadcastSeedRepository(database);
  return {
    async run(): Promise<void> {
      const weekStart = seedWeekStart(clock());
      let failed = false;
      for (const destination of seedProviders) {
        try {
          const row = await repository.ensure(
            weekStart,
            destination,
            makeMarker(),
          );
          if (row.state === 'passed') continue;
          let sentAt = row.sent_at;
          if (sentAt === null) {
            await sender.send(
              destination,
              row.marker,
              `brevo-seed:${weekStart.toISOString().slice(0, 10)}:${destination}`,
            );
            sentAt = clock();
            await repository.markSent(weekStart, destination, sentAt);
          }
          const source = await mailbox.source(destination, row.marker);
          const state =
            source === null
              ? clock().getTime() - sentAt.getTime() >= seedMissingAfterMs
                ? 'missing'
                : 'pending'
              : await inspectBroadcastSeed(
                  source,
                  row.marker,
                  sender.expectedUrl,
                );
          if (state !== row.state && state !== 'pending')
            await repository.markChecked(
              weekStart,
              destination,
              state,
              clock(),
            );
          if (
            state !== 'pending' &&
            state !== 'passed' &&
            (row.alerted_at === null || row.state !== state)
          ) {
            await alerts.send({
              event: 'broadcast_seed_content_failed',
              detail: {
                provider: destination,
                code: state,
                week_start: weekStart.toISOString().slice(0, 10),
              },
              occurredAt: clock(),
              severity: 'P1',
            });
            await repository.markAlerted(weekStart, destination, clock());
          }
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error('broadcast_seed_test_failed');
    },
  };
}
