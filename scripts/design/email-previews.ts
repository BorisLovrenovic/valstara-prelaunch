// Renders every email template from fixture payloads for review. Writes one
// HTML file per template and a contact-sheet manifest into a git-ignored
// directory; serve that directory and run contact-sheet.mjs over it to capture
// light and dark previews. Nothing is sent and no database is read.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { dsrRenderers } from '../../src/server/dsr/templates.ts';
import type {
  Message,
  TemplateRenderer,
} from '../../src/server/email/service.ts';
import { createTransactionalRenderers } from '../../src/server/email/transactional-templates.ts';
import { createWeeklyTemplate } from '../../src/server/email/weekly-template.ts';

const rulesVersion = 'VAL-GW-LAUNCH-20261009-r1';
const awardId = '11111111-1111-4111-8111-111111111111';

const payloads: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  verification_test: { token_id: 'verify-id' },
  verification_reminder: { token_id: 'verify-id' },
  welcome: { status_token_id: 'status-id' },
  milestone_reached: { status_token_id: 'status-id', tier: 1 },
  status_link: { token_id: 'status-id' },
  giveaway_entry_receipt: {
    status_token_id: 'status-id',
    rules_version: rulesVersion,
  },
  giveaway_winner: { token_id: 'status-id', award_id: awardId },
  dsr_export: { token_id: 'dsr-id' },
  dsr_delete: { token_id: 'dsr-id' },
  weekly_campaign_update: {
    snapshot_id: 'snapshot-id',
    status_token_id: 'status-id',
  },
};

/** Every registered template, keyed by its queue identifier. */
export function emailPreviewRenderers(
  baseUrl: string,
): ReadonlyMap<string, TemplateRenderer> {
  const origin = new URL(baseUrl).origin;
  return new Map([
    ...createTransactionalRenderers({
      baseUrl: origin,
      sendingDomain: 'send.valstara.com',
      data: {
        async referralStatus() {
          return {
            accessWindow: 'wave-2',
            confirmedReferrals: 3,
            giveawayEntries: 6,
            ownRank: 4,
            referralLink: new URL('/?ref=ABCDEF234567', origin).toString(),
            rewards: [
              { kind: 'wave_upgrade', state: 'settled', tier: 1 },
              { kind: 'discount', state: 'held', tier: 1 },
            ],
            subscriberStatus: 'verified',
            tier: 1,
          };
        },
        async receiptEntries() {
          return 6;
        },
        async winnerDetails() {
          return {
            deadline: new Date('2027-04-15T09:00:00.000Z'),
            rulesVersion,
          };
        },
      },
    }),
    ...dsrRenderers(origin, 'send.valstara.com'),
    [
      'weekly_campaign_update',
      createWeeklyTemplate({
        baseUrl: origin,
        sendingDomain: 'mail.valstara.com',
        async snapshotById(id) {
          return {
            id,
            asOf: '2026-10-20T09:00:00.000Z',
            entries: [
              { rank: 1, displayHandle: 'Member 7K2Q', confirmedReferrals: 12 },
              { rank: 2, displayHandle: 'Member 4HX9', confirmedReferrals: 7 },
              { rank: 3, displayHandle: 'Member P3ZD', confirmedReferrals: 1 },
            ],
          };
        },
      }),
    ],
  ]);
}

export async function renderEmailPreviews(
  baseUrl: string,
): Promise<
  readonly { readonly template: string; readonly message: Message }[]
> {
  const unsubscribePageUrl = new URL('/unsubscribe', baseUrl);
  unsubscribePageUrl.searchParams.set('t', 'unsubscribe-signature');
  const rendered = [];
  for (const [template, renderer] of emailPreviewRenderers(baseUrl)) {
    const payload = payloads[template];
    if (payload === undefined)
      throw new Error(`No preview payload for ${template}.`);
    rendered.push({
      template,
      message: await renderer.render({
        email: 'reader@example.test',
        payload,
        token: async (id) => `${id}-signature`,
        unsubscribePageUrl: unsubscribePageUrl.toString(),
      }),
    });
  }
  return rendered;
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(resolve(entry)).href
) {
  const flag = process.argv.indexOf('--output');
  const output = resolve(
    flag < 0 ? '.design-contact-sheets/email-html' : process.argv[flag + 1],
  );
  await mkdir(output, { recursive: true });
  const previews = await renderEmailPreviews('https://valstara.com');
  for (const { template, message } of previews) {
    if (message.html === undefined)
      throw new Error(`${template} has no HTML part.`);
    await writeFile(join(output, `${template}.html`), message.html);
    await writeFile(join(output, `${template}.txt`), message.text);
  }
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify(
      previews.map(({ template }) => ({
        route: `/${template}.html`,
        state: `email-${template}`,
      })),
      null,
      2,
    ),
  );
  process.stdout.write(
    `Rendered ${previews.length} email previews in ${output}\n`,
  );
}
