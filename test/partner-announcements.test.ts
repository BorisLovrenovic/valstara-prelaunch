// E11.7-16: partner announcements, against a real database with an injected
// clock. The Tests line: once per partner per announcement across a restart ·
// audience and dispatch re-checks · opt-out between queueing and dispatch ·
// validation red paths · the append-only guard · dry run · authentication and
// audit · flag off · rendering in both parts.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { promisify } from 'node:util';

import type { APIContext } from 'astro';

import { scanPartnerAnnouncementsAppendOnly } from '../scripts/ci/partner-announcements-append-only.mjs';
import { adminCopy } from '../src/copy/admin.ts';
import { emailCopy } from '../src/copy/email.ts';
import { partnersCopy } from '../src/copy/partners.ts';
import { createPartnerAnnouncementRoute } from '../src/pages/api/admin/partners/announce.ts';
import {
  adminActor,
  createAdminAuthenticator,
} from '../src/server/admin-auth/authenticate.ts';
import { createAdminAuthMiddleware } from '../src/server/admin-auth/middleware.ts';
import { adminRouteRegistry } from '../src/server/admin-auth/route-registry.ts';
import { generateTotp } from '../src/server/admin-auth/totp.ts';
import {
  AdminCommandError,
  adminCommands,
  runAdminCommand,
} from '../src/server/admin/cli.ts';
import { createCampaignFlagRepository } from '../src/server/db/campaign-flags.ts';
import { createPartnerAnnouncementRepository } from '../src/server/db/partner-announcement.ts';
import { createPartnerDigestRepository } from '../src/server/db/partner-digest.ts';
import type { DatabaseConnection } from '../src/server/db/pool.ts';
import {
  createEmailService,
  type EmailProvider,
  type Message,
  type QueueEmailInput,
} from '../src/server/email/service.ts';
import { createUnsubscribeService } from '../src/server/email/unsubscribe.ts';
import {
  campaignFlagRegistry,
  type FlagKey,
} from '../src/server/flags/registry.ts';
import {
  checkPartnerAnnouncements,
  isPartnerAnnouncementId,
  parsePartnerAnnouncement,
  partnerAnnouncementLimits,
  readPartnerAnnouncement,
} from '../src/server/partner/announcement-content.ts';
import { createPartnerAnnouncementHandler } from '../src/server/partner/announcement-http.ts';
import { partnerAnnouncementRenderer } from '../src/server/partner/announcement-template.ts';
import {
  createPartnerAnnouncementService,
  maxPartnerAnnouncementBatchesPerRun,
  partnerAnnouncementBatchLimit,
  partnerAnnouncementFlags,
  PartnerAnnouncementRefusedError,
} from '../src/server/partner/announcement.ts';
import {
  dashboardRecoveryPath,
  partnerAnnouncementBusinessKey,
  partnerAnnouncementTemplate,
  partnerFirstSignupTemplate,
} from '../src/server/partner/config.ts';
import { partnerApplicationRenderers } from '../src/server/partner/templates.ts';
import {
  deriveEmailToken,
  emailTokenSecret,
} from '../src/server/verification/token-derivation.ts';
import { createVerificationService } from '../src/server/verification/service.ts';

import {
  createPartnerFixture,
  insertPartner,
  type InsertedPartner,
  type PartnerFixture,
} from './helpers/partner-review-fixture.ts';

const actor = 'founder:test';
const secret = emailTokenSecret();
const origin = 'https://valstara.com';
const instant = new Date('2026-12-01T09:00:00.000Z');
const clock = () => instant;

let fixture: PartnerFixture;
let directory: string;

before(async () => {
  fixture = await createPartnerFixture('partner-announcements');
  directory = await mkdtemp(join(tmpdir(), 'valstara-announcements-'));
});

after(async () => {
  await fixture?.dispose();
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
});

// Each test starts with no partner in the audience and no mail waiting.
beforeEach(async () => {
  if (fixture === undefined) return;
  await fixture.owner.execute({
    text: 'UPDATE partner SET nonessential_email_enabled = false',
  });
  await fixture.owner.execute({
    text: `UPDATE email_send SET state = 'failed', last_error = 'test_reset'
      WHERE state = 'queued'`,
  });
  for (const key of partnerAnnouncementFlags) await setFlag(key, true);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function announcementSource(
  options: {
    readonly subject?: string;
    readonly body?: string;
  } = {},
): string {
  return `---\nsubject: ${options.subject ?? 'Programme news for December'}\n---\n\n${
    options.body ??
    'The partner leaderboard now updates every hour.\n\nRead the [programme page](/partners) for the details, or [ask a question](/about).'
  }\n`;
}

/** Writes a valid announcement under a fresh id and returns the id. */
async function announcement(
  options: { readonly subject?: string; readonly body?: string } = {},
): Promise<string> {
  const id = `2026-12-01-news-${randomUUID().slice(0, 8)}`;
  await writeFile(join(directory, `${id}.md`), announcementSource(options));
  return id;
}

async function setFlag(key: FlagKey, on: boolean) {
  await createCampaignFlagRepository(fixture.app).set(key, on, actor);
}

async function audiencePartner(
  options: { readonly optedIn?: boolean; readonly marketing?: boolean } = {},
): Promise<InsertedPartner> {
  const partner = await insertPartner(fixture, {
    status: 'active',
    marketing: options.marketing ?? false,
  });
  if (options.optedIn ?? true)
    await fixture.owner.execute({
      text: 'UPDATE partner SET nonessential_email_enabled = true WHERE id = $1',
      values: [partner.id],
    });
  return partner;
}

function provider(id: string, domain: string, sent: Message[]): EmailProvider {
  return {
    id,
    sendingDomain: domain,
    capabilities: {
      broadcast: id === 'brevo',
      contactSync: false,
      dailyFreeCap: 100,
    },
    async send({ message }) {
      sent.push(message);
      return { providerMessageId: randomUUID() };
    },
  };
}

function emailService(sent: Message[] = [], broadcast = true) {
  return createEmailService(fixture.app, {
    clock,
    tokenSecret: secret,
    baseUrl: origin,
    providers: new Map([
      ['resend', provider('resend', 'send.valstara.com', sent)],
      ['brevo', provider('brevo', 'mail.valstara.com', sent)],
    ]),
    renderers: new Map([
      ...partnerApplicationRenderers(origin, 'send.valstara.com', {
        welcomeCode: async () => null,
      }),
      [
        partnerAnnouncementTemplate,
        partnerAnnouncementRenderer({
          baseUrl: origin,
          sendingDomain: 'mail.valstara.com',
          announcement: (id) => readPartnerAnnouncement(id, directory),
        }),
      ],
    ]),
    isBroadcastEnabled: async () => broadcast,
    operatorTask: async ({ code }) => assert.fail(`unexpected: ${code}`),
  });
}

function announcer(
  options: {
    readonly queue?: (
      input: QueueEmailInput,
      connection: DatabaseConnection,
    ) => Promise<boolean>;
    readonly batchLimit?: number;
    readonly maxBatches?: number;
  } = {},
) {
  const service = emailService();
  return createPartnerAnnouncementService(fixture.app, {
    clock,
    tokenSecret: secret,
    directory,
    queue:
      options.queue ??
      ((input, connection) => service.queue(input, connection)),
    ...(options.batchLimit === undefined
      ? {}
      : { batchLimit: options.batchLimit }),
    ...(options.maxBatches === undefined
      ? {}
      : { maxBatches: options.maxBatches }),
  });
}

async function rows(businessKey: string) {
  return fixture.owner.list<{
    id: string;
    template: string;
    provider: string;
    state: string;
    last_error: string | null;
    payload: Record<string, string>;
    unsubscribe_token_id: string;
  }>(
    {
      text: `SELECT id, template, provider, state, last_error, payload,
        unsubscribe_token_id FROM email_send WHERE business_key = $1`,
      values: [businessKey],
    },
    10,
  );
}

async function announcementRows(id: string) {
  return fixture.owner.list<{ business_key: string; state: string }>(
    {
      text: `SELECT business_key, state FROM email_send
        WHERE business_key LIKE 'partner-announcement:' || $1 || ':%'
        ORDER BY business_key`,
      values: [id],
    },
    1_000,
  );
}

async function runAudits(id: string) {
  return fixture.owner.list<{
    actor: string;
    subject_type: string;
    subject_id: string | null;
    detail: Record<string, unknown>;
  }>(
    {
      text: `SELECT actor, subject_type, subject_id, detail FROM audit_log
        WHERE action = 'partner.announcement_run'
          AND detail->>'announcement_id' = $1
        ORDER BY at, id`,
      values: [id],
    },
    100,
  );
}

async function statusTokens(subscriberId: string): Promise<number> {
  const row = await fixture.owner.readOne<{ n: number }>({
    text: `SELECT count(*)::int AS n FROM verification_token
      WHERE subscriber_id = $1 AND purpose = 'status'`,
    values: [subscriberId],
  });
  return row?.n ?? 0;
}

// ── Validation red paths ────────────────────────────────────────────────────

test('a valid announcement parses into its subject, plain paragraphs and own-origin links', () => {
  const parsed = parsePartnerAnnouncement(
    '2026-12-01-programme-news',
    announcementSource(),
  );
  assert.ok('announcement' in parsed, JSON.stringify(parsed));
  assert.deepEqual(parsed.announcement, {
    id: '2026-12-01-programme-news',
    subject: 'Programme news for December',
    paragraphs: [
      'The partner leaderboard now updates every hour.',
      'Read the programme page for the details, or ask a question.',
    ],
    links: [
      { label: 'programme page', path: '/partners' },
      { label: 'ask a question', path: '/about' },
    ],
  });
  // Lines of one paragraph join with a space; CRLF reads as LF; a quoted
  // subject is unquoted.
  const wrapped = parsePartnerAnnouncement(
    '2026-12-01-wrapped',
    '---\r\nsubject: "Rules: a reminder"\r\n---\r\n\r\nOne line\r\nand the next.\r\n',
  );
  assert.ok('announcement' in wrapped, JSON.stringify(wrapped));
  assert.equal(wrapped.announcement.subject, 'Rules: a reminder');
  assert.deepEqual(wrapped.announcement.paragraphs, ['One line and the next.']);
});

test('validation red paths: the id, subject, length, links, images, HTML, merge fields, markdown and copy rules', () => {
  const words = (count: number) =>
    Array.from({ length: count }, () => 'word').join(' ');
  const cases: readonly [string, string, string, RegExp][] = [
    ['bad id', '2026-02-30-news', announcementSource(), /file name/u],
    ['bad slug', '2026-12-01-News', announcementSource(), /file name/u],
    ['no frontmatter', '2026-12-01-a', 'Just prose.\n', /frontmatter/u],
    [
      'extra key',
      '2026-12-01-a',
      '---\nsubject: Hello there\nimage: x.png\n---\n\nText.\n',
      /exactly one line/u,
    ],
    [
      'long subject',
      '2026-12-01-a',
      announcementSource({ subject: `S${'s'.repeat(80)}` }),
      /longer than 80 characters/u,
    ],
    [
      'empty subject',
      '2026-12-01-a',
      announcementSource({ subject: '' }),
      /exactly one line|subject is empty/u,
    ],
    [
      'exclamation in subject',
      '2026-12-01-a',
      announcementSource({ subject: 'Big news' + '!' }),
      /exclamation mark/u,
    ],
    [
      'title case subject',
      '2026-12-01-a',
      announcementSource({ subject: 'Partner Programme Changes' }),
      /sentence case/u,
    ],
    [
      'lowercase subject',
      '2026-12-01-a',
      announcementSource({ subject: 'programme news' }),
      /capital letter/u,
    ],
    [
      'merge field in subject',
      '2026-12-01-a',
      announcementSource({ subject: 'Hello {{first_name}}' }),
      /merge field/u,
    ],
    [
      'too many words',
      '2026-12-01-a',
      announcementSource({ body: words(301) }),
      /301 words; at most 300/u,
    ],
    [
      'too many links',
      '2026-12-01-a',
      announcementSource({
        body: '[One](/a) [two](/b) [three](/c) [four](/d)',
      }),
      /4 links; at most 3/u,
    ],
    [
      'off-origin link',
      '2026-12-01-a',
      announcementSource({ body: 'See [this](https://example.com/x).' }),
      /must be a path on the site/u,
    ],
    [
      'protocol-relative link',
      '2026-12-01-a',
      announcementSource({ body: 'See [this](//example.com/x).' }),
      /must be a path on the site/u,
    ],
    [
      'own origin written absolute',
      '2026-12-01-a',
      announcementSource({
        body: 'See [this](https://valstara.com/partners).',
      }),
      /must be a path on the site/u,
    ],
    [
      'bare web address',
      '2026-12-01-a',
      announcementSource({ body: 'Visit example.com for more.' }),
      /web or email address/u,
    ],
    [
      'email address',
      '2026-12-01-a',
      announcementSource({ body: 'Write to someone@example.test today.' }),
      /web or email address/u,
    ],
    [
      'image',
      '2026-12-01-a',
      announcementSource({ body: 'Look: ![flyer](/flyer.png)' }),
      /image/u,
    ],
    [
      'HTML',
      '2026-12-01-a',
      announcementSource({ body: 'Read <b>this</b> now.' }),
      /HTML/u,
    ],
    [
      'HTML entity',
      '2026-12-01-a',
      announcementSource({ body: 'Fish &amp; chips.' }),
      /HTML/u,
    ],
    [
      'Brevo merge field',
      '2026-12-01-a',
      announcementSource({ body: 'Hello {{ contact.FIRSTNAME }}.' }),
      /merge field/u,
    ],
    [
      'Mailchimp merge field',
      '2026-12-01-a',
      announcementSource({ body: 'Hello *|FNAME|*.' }),
      /merge field/u,
    ],
    [
      'heading',
      '2026-12-01-a',
      announcementSource({ body: '# News\n\nText.' }),
      /markdown structure/u,
    ],
    [
      'list',
      '2026-12-01-a',
      announcementSource({ body: '- one\n- two' }),
      /markdown structure/u,
    ],
    [
      'emphasis',
      '2026-12-01-a',
      announcementSource({ body: 'This is **important**.' }),
      /markdown formatting/u,
    ],
    [
      'stray brackets',
      '2026-12-01-a',
      announcementSource({ body: 'See [the page] soon.' }),
      /square brackets/u,
    ],
    [
      'exclamation in text',
      '2026-12-01-a',
      announcementSource({ body: 'Great news' + '!' }),
      /exclamation mark/u,
    ],
    [
      'empty text',
      '2026-12-01-a',
      announcementSource({ body: '' }),
      /no text/u,
    ],
  ];
  for (const [name, id, source, problem] of cases) {
    const parsed = parsePartnerAnnouncement(id, source);
    assert.ok('problems' in parsed, `${name} must fail`);
    assert.ok(
      parsed.problems.some((text) => problem.test(text)),
      `${name}: ${parsed.problems.join(' | ')}`,
    );
  }

  // The limits themselves pass: 80 characters, 300 words and 3 links.
  const atLimits = parsePartnerAnnouncement(
    '2026-12-01-limits',
    announcementSource({
      subject: `S${'s'.repeat(partnerAnnouncementLimits.subjectCharacters - 1)}`,
      body: `${words(297)} [one](/a) [two](/b) [three](/c)`,
    }),
  );
  assert.ok('announcement' in atLimits, JSON.stringify(atLimits));

  // The forbidden-copy list applies when the build check passes it.
  const forbidden = parsePartnerAnnouncement(
    '2026-12-01-a',
    announcementSource({ body: 'Join our team today.' }),
    { forbiddenTerms: ['team'] },
  );
  assert.ok('problems' in forbidden);
  assert.match(forbidden.problems.join(' '), /forbidden copy "team"/u);

  assert.equal(isPartnerAnnouncementId('2028-02-29-leap'), true);
  assert.equal(isPartnerAnnouncementId('2027-02-29-not-leap'), false);
  assert.equal(isPartnerAnnouncementId(`2026-12-01-${'a'.repeat(70)}`), false);
});

test('the folder check reports every bad file, ignores the placeholder, and the shipped folder passes', async () => {
  assert.deepEqual(checkPartnerAnnouncements(), []);
  const folder = await mkdtemp(join(tmpdir(), 'valstara-announce-check-'));
  try {
    assert.deepEqual(checkPartnerAnnouncements(join(folder, 'missing')), []);
    await writeFile(join(folder, '.gitkeep'), '\n');
    await writeFile(join(folder, '2026-12-01-good.md'), announcementSource());
    assert.deepEqual(checkPartnerAnnouncements(folder), []);
    await writeFile(join(folder, 'notes.txt'), 'x');
    await mkdir(join(folder, 'drafts'));
    await writeFile(
      join(folder, '2026-12-02-bad.md'),
      announcementSource({ subject: 'Hello there' + '!' }),
    );
    const problems = checkPartnerAnnouncements(folder);
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(
      problems.join('\n'),
      /2026-12-02-bad\.md: the subject has an exclamation mark/u,
    );
    assert.match(problems.join('\n'), /drafts: only YYYY-MM-DD-<slug>\.md/u);
    assert.match(
      problems.join('\n'),
      /notes\.txt: only YYYY-MM-DD-<slug>\.md/u,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('an announcement that fails validation fails the build: the check runs before every build', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts.prebuild ?? '',
    /tsx scripts\/ci\/partner-announcements-check\.ts/u,
  );
  const run = promisify(execFile);
  const script = resolve('scripts/ci/partner-announcements-check.ts');
  const tsx = resolve('node_modules/.bin/tsx');
  const root = await mkdtemp(join(tmpdir(), 'valstara-announce-build-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await copyFile(
      'scripts/forbidden-copy.json',
      join(root, 'scripts/forbidden-copy.json'),
    );
    // No folder at all holds no announcements.
    await run(tsx, [script], { cwd: root });
    const folder = join(root, 'src/content/partner-announcements');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '2026-12-01-good.md'), announcementSource());
    await run(tsx, [script], { cwd: root });
    // A forbidden-copy term fails the build, not only the CI scan.
    await writeFile(
      join(folder, '2026-12-02-copy.md'),
      announcementSource({ body: 'Unlimited commission for the whole team.' }),
    );
    await assert.rejects(run(tsx, [script], { cwd: root }), (error: Error) => {
      const stderr = String((error as Error & { stderr?: string }).stderr);
      assert.match(stderr, /A partner announcement failed its checks/u);
      assert.match(stderr, /2026-12-02-copy\.md: forbidden copy "unlimited"/u);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── The append-only guard ───────────────────────────────────────────────────

test('the append-only guard fails an edited or deleted published announcement and allows a new one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-announce-history-'));
  const folder = join(root, 'src/content/partner-announcements');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root }).toString('utf8').trim();
  const commit = (message: string) =>
    git(
      '-c',
      'user.name=Announcement Test',
      '-c',
      'user.email=announcements@example.test',
      'commit',
      '-qm',
      message,
    );
  try {
    await mkdir(folder, { recursive: true });
    git('init', '-q', '-b', 'main');
    const published = join(folder, '2026-12-01-published.md');
    await writeFile(published, announcementSource());
    git('add', '.');
    commit('publish');
    assert.deepEqual(scanPartnerAnnouncementsAppendOnly({ root }), []);

    // A branch adds a new announcement: allowed.
    git('switch', '-q', '-c', 'feature');
    await writeFile(join(folder, '2026-12-08-next.md'), announcementSource());
    git('add', '.');
    commit('add');
    assert.deepEqual(
      scanPartnerAnnouncementsAppendOnly({ root, base: 'main' }),
      [],
    );

    // A committed edit on the branch, compared with the merge base, as CI does.
    await writeFile(published, announcementSource({ subject: 'Changed news' }));
    git('add', '.');
    commit('edit');
    const edited = scanPartnerAnnouncementsAppendOnly({ root, base: 'main' });
    assert.equal(edited.length, 1);
    assert.equal(edited[0].scan, 'partner-announcements-append-only');
    assert.equal(
      edited[0].path,
      'src/content/partner-announcements/2026-12-01-published.md',
    );
    assert.match(edited[0].message, /was edited/u);

    // A deletion, uncommitted, against HEAD as a local check runs.
    git('switch', '-q', 'main');
    await unlink(published);
    const deleted = scanPartnerAnnouncementsAppendOnly({ root });
    assert.equal(deleted.length, 1);
    assert.match(deleted[0].message, /was deleted/u);

    // An unresolvable base is an issue, never a pass.
    assert.equal(
      scanPartnerAnnouncementsAppendOnly({ root, base: 'no-such-ref' }).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the security gates run the append-only guard, and the repository passes it', async () => {
  const gates = await readFile('scripts/ci/security-gates.mjs', 'utf8');
  assert.match(
    gates,
    /scanPartnerAnnouncementsAppendOnly\(\{\s*root: projectRoot,\s*base: options\.base,\s*\}\)/u,
  );
  assert.deepEqual(
    scanPartnerAnnouncementsAppendOnly({
      root: resolve('.'),
      base: process.env.SECURITY_BASE_SHA ?? process.env.COVERAGE_BASE_SHA,
    }),
    [],
  );
});

// ── Flag off ────────────────────────────────────────────────────────────────

test('flag off: the flag defaults off, the command refuses with nothing queued, and a flag turned off after queueing stops the send', async () => {
  assert.equal(campaignFlagRegistry['partners.announcements'], false);
  const id = await announcement();
  const partner = await audiencePartner();

  // With no override, the code default (off) applies.
  await fixture.owner.execute({
    text: "DELETE FROM campaign_flag WHERE key = 'partners.announcements'",
  });
  for (const dryRun of [true, false]) {
    await assert.rejects(
      announcer().run({ id, dryRun, actor }),
      (error: unknown) =>
        error instanceof PartnerAnnouncementRefusedError &&
        error.refusal === 'flags_off' &&
        error.details.join() === 'partners.announcements',
    );
  }
  // Each of the digest's flags is required too.
  for (const key of ['partners.enabled', 'email.broadcast'] as const) {
    for (const flag of partnerAnnouncementFlags) await setFlag(flag, true);
    await setFlag(key, false);
    await assert.rejects(
      announcer().run({ id, dryRun: false, actor }),
      (error: unknown) =>
        error instanceof PartnerAnnouncementRefusedError &&
        error.details.join() === key,
    );
  }
  assert.deepEqual(await announcementRows(id), []);
  assert.equal(await statusTokens(partner.subscriberId), 0);
  assert.deepEqual(await runAudits(id), []);

  // Queued while on, then switched off before dispatch: nothing is sent.
  for (const flag of partnerAnnouncementFlags) await setFlag(flag, true);
  assert.equal(
    (await announcer().run({ id, dryRun: false, actor })).dryRun,
    false,
  );
  await setFlag('partners.announcements', false);
  const sent: Message[] = [];
  const summary = await emailService(sent).dispatch(100);
  assert.equal(sent.length, 0);
  assert.equal(summary.suppressed, 1);
  const [row] = await rows(partnerAnnouncementBusinessKey(id, partner.id));
  assert.equal(row?.state, 'failed');
  assert.equal(row?.last_error, 'recipient_ineligible');
});

// ── Once per partner per announcement ───────────────────────────────────────

test('one email per partner per announcement across a restart, a repeat run and concurrent runs', async () => {
  const id = await announcement();
  const partners = [
    await audiencePartner(),
    await audiencePartner(),
    await audiencePartner(),
  ];

  // The process stops after one queue: a crash part-way through the run.
  const service = emailService();
  let calls = 0;
  await assert.rejects(
    announcer({
      queue: async (input, connection) => {
        calls += 1;
        if (calls > 1) throw new Error('process stopped');
        return service.queue(input, connection);
      },
    }).run({ id, dryRun: false, actor }),
    /process stopped/u,
  );
  assert.equal((await announcementRows(id)).length, 1);

  // A new run after the restart queues only the partners still due.
  assert.deepEqual(await announcer().run({ id, dryRun: false, actor }), {
    announcementId: id,
    dryRun: false,
    queued: 2,
    alreadyQueued: 1,
    remaining: 0,
  });
  // A repeat run queues nothing.
  assert.deepEqual(await announcer().run({ id, dryRun: false, actor }), {
    announcementId: id,
    dryRun: false,
    queued: 0,
    alreadyQueued: 3,
    remaining: 0,
  });
  for (const partner of partners) {
    const [row, ...more] = await rows(
      partnerAnnouncementBusinessKey(id, partner.id),
    );
    assert.deepEqual(more, []);
    assert.equal(row?.template, partnerAnnouncementTemplate);
    assert.equal(row?.provider, 'brevo');
    assert.deepEqual(Object.keys(row?.payload ?? {}).sort(), [
      'announcement_id',
      'status_token_id',
    ]);
    assert.equal(row?.payload.announcement_id, id);
  }
  // Each partner was issued exactly one status link; the run that lost its
  // partner rolled its token back with the transaction.
  for (const partner of partners)
    assert.equal(await statusTokens(partner.subscriberId), 1);

  // Every run is audited, the stopped one included, with what it queued.
  const audits = await runAudits(id);
  assert.deepEqual(
    audits.map((row) => row.detail),
    [
      {
        announcement_id: id,
        dry_run: false,
        outcome: 'failed',
        queued: 1,
        already_queued: 0,
      },
      {
        announcement_id: id,
        dry_run: false,
        outcome: 'completed',
        queued: 2,
        already_queued: 1,
        remaining: 0,
      },
      {
        announcement_id: id,
        dry_run: false,
        outcome: 'completed',
        queued: 0,
        already_queued: 3,
        remaining: 0,
      },
    ],
  );

  // Two concurrent runs of a second announcement queue each partner once.
  const second = await announcement();
  const results = await Promise.all([
    announcer().run({ id: second, dryRun: false, actor }),
    announcer().run({ id: second, dryRun: false, actor }),
  ]);
  const queuedTotal = results.reduce(
    (total, result) => total + (result.dryRun ? 0 : result.queued),
    0,
  );
  assert.equal(queuedTotal, 3);
  assert.equal((await announcementRows(second)).length, 3);
  for (const partner of partners)
    assert.equal(await statusTokens(partner.subscriberId), 2);

  // Dispatch sends each partner's email once, and again sends nothing.
  const sent: Message[] = [];
  assert.equal((await emailService(sent).dispatch(100)).sent, 6);
  assert.equal((await emailService(sent).dispatch(100)).sent, 0);
  assert.equal(sent.length, 6);
});

test('a run is batch-capped and resumable: it stops after its batches and the next run continues', async () => {
  assert.equal(partnerAnnouncementBatchLimit, 100);
  assert.throws(
    () => announcer({ batchLimit: partnerAnnouncementBatchLimit + 1 }),
    RangeError,
  );
  assert.throws(
    () => announcer({ maxBatches: maxPartnerAnnouncementBatchesPerRun + 1 }),
    RangeError,
  );
  const id = await announcement();
  for (let index = 0; index < 3; index += 1) await audiencePartner();
  const capped = announcer({ batchLimit: 1, maxBatches: 2 });
  assert.deepEqual(await capped.run({ id, dryRun: false, actor }), {
    announcementId: id,
    dryRun: false,
    queued: 2,
    alreadyQueued: 0,
    remaining: 1,
  });
  assert.equal((await runAudits(id))[0]?.detail.outcome, 'partial');
  assert.deepEqual(await capped.run({ id, dryRun: false, actor }), {
    announcementId: id,
    dryRun: false,
    queued: 1,
    alreadyQueued: 2,
    remaining: 0,
  });
  assert.equal((await announcementRows(id)).length, 3);
});

// ── Audience and dispatch re-checks ─────────────────────────────────────────

test('the audience is exactly the digest’s: only active, unpurged, verified, unsuppressed partners who chose optional programme email', async () => {
  const id = await announcement();
  const optedIn = await audiencePartner();
  const optedOut = await audiencePartner({ optedIn: false });
  // Marketing consent is neither required nor enough (D-071).
  const marketingOnly = await audiencePartner({
    optedIn: false,
    marketing: true,
  });
  const paused = await audiencePartner();
  await fixture.owner.execute({
    text: "UPDATE partner SET status = 'paused', status_changed_at = $2 WHERE id = $1",
    values: [paused.id, instant],
  });
  const suppressed = await audiencePartner();
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES (lower($1), 'complaint', 'brevo')",
    values: [suppressed.email],
  });
  const unverified = await audiencePartner();
  await fixture.owner.execute({
    text: "UPDATE subscriber SET status = 'unsubscribed' WHERE id = $1",
    values: [unverified.subscriberId],
  });
  const approved = await insertPartner(fixture, { status: 'approved' });
  await fixture.owner.execute({
    text: 'UPDATE partner SET nonessential_email_enabled = true WHERE id = $1',
    values: [approved.id],
  });

  // The same set as the digest's own audience query.
  const digest = await createPartnerDigestRepository(fixture.app).eligible(
    '2099-01',
    100,
  );
  const due = await createPartnerAnnouncementRepository(fixture.app).due(
    id,
    100,
  );
  assert.deepEqual(due, digest);
  assert.deepEqual(
    due.map((row) => row.partner_id),
    [optedIn.id],
  );

  assert.deepEqual(await announcer().run({ id, dryRun: false, actor }), {
    announcementId: id,
    dryRun: false,
    queued: 1,
    alreadyQueued: 0,
    remaining: 0,
  });
  assert.equal(
    (await rows(partnerAnnouncementBusinessKey(id, optedIn.id))).length,
    1,
  );
  for (const partner of [
    optedOut,
    marketingOnly,
    paused,
    suppressed,
    unverified,
    approved,
  ])
    assert.deepEqual(
      await rows(partnerAnnouncementBusinessKey(id, partner.id)),
      [],
    );
});

test('an opt-out between queueing and dispatch stops the send, as does any other change the dispatch re-checks', async () => {
  const id = await announcement();
  const optingOut = await audiencePartner();
  const terminated = await audiencePartner();
  const suppressed = await audiencePartner();
  const staying = await audiencePartner();
  assert.equal(
    (await announcer().run({ id, dryRun: false, actor })).dryRun === false &&
      (await announcementRows(id)).length,
    4,
  );

  await fixture.owner.execute({
    text: 'UPDATE partner SET nonessential_email_enabled = false WHERE id = $1',
    values: [optingOut.id],
  });
  await fixture.owner.execute({
    text: "UPDATE partner SET status = 'terminated', status_changed_at = $2 WHERE id = $1",
    values: [terminated.id, instant],
  });
  await fixture.owner.execute({
    text: "INSERT INTO suppression (email_normalised, reason, source) VALUES (lower($1), 'complaint', 'brevo')",
    values: [suppressed.email],
  });
  const sent: Message[] = [];
  const summary = await emailService(sent).dispatch(100);
  assert.equal(summary.sent, 1);
  assert.equal(summary.suppressed, 3);
  assert.deepEqual(
    sent.map((message) => message.to),
    [staying.email],
  );
  for (const partner of [optingOut, terminated, suppressed]) {
    const [row] = await rows(partnerAnnouncementBusinessKey(id, partner.id));
    assert.equal(row?.state, 'failed');
    assert.equal(row?.last_error, 'recipient_ineligible');
  }

  // With email.broadcast off at dispatch, the broadcast waits; nothing is sent.
  const later = await announcement();
  const waiting = await audiencePartner();
  await announcer().run({ id: later, dryRun: false, actor });
  const paused: Message[] = [];
  const held = await emailService(paused, false).dispatch(100);
  assert.equal(paused.length, 0);
  // The partner who stayed opted in is in this audience too.
  assert.equal(held.broadcastPaused, 2);
  for (const partner of [staying, waiting])
    assert.equal(
      (await rows(partnerAnnouncementBusinessKey(later, partner.id)))[0]?.state,
      'queued',
    );
});

test('an announcement unsubscribe turns off only the optional-email choice; marketing consent, the waitlist place and transactional mail stay', async () => {
  const id = await announcement();
  const partner = await audiencePartner({ marketing: true });
  await announcer().run({ id, dryRun: false, actor });
  const [row] = await rows(partnerAnnouncementBusinessKey(id, partner.id));
  assert.ok(row);
  const unsubscribe = createUnsubscribeService(fixture.app, {
    clock,
    tokenSecret: secret,
    onFailure: async () => assert.fail('unsubscribe failed'),
  });
  assert.equal(
    await unsubscribe.apply({
      token: deriveEmailToken(row.unsubscribe_token_id, secret),
      action: 'message_unsubscribe',
      ipPrefixHash: 'test-prefix',
    }),
    'accepted',
  );
  const state = await fixture.owner.readOne<{
    nonessential_email_enabled: boolean;
    status: string;
    marketing: boolean;
    suppressed: boolean;
  }>({
    text: `SELECT p.nonessential_email_enabled, s.status,
        s.marketing_consent_at IS NOT NULL AS marketing,
        EXISTS (SELECT 1 FROM suppression x WHERE x.email_normalised = s.email_normalised) AS suppressed
      FROM partner p JOIN subscriber s ON s.id = p.subscriber_id WHERE p.id = $1`,
    values: [partner.id],
  });
  assert.deepEqual(state, {
    nonessential_email_enabled: false,
    status: 'verified',
    marketing: true,
    suppressed: false,
  });
  const audit = await fixture.owner.list<{
    action: string;
    actor: string;
    detail: Record<string, string>;
  }>(
    {
      text: `SELECT action, actor, detail FROM audit_log
        WHERE subject_id = $1 ORDER BY at`,
      values: [partner.subscriberId],
    },
    10,
  );
  assert.deepEqual(audit, [
    {
      action: 'partner.optional_email_withdrawn',
      actor: 'subscriber',
      detail: { source_template: partnerAnnouncementTemplate, send_id: row.id },
    },
  ]);

  // The queued announcement no longer goes out, and the next is not queued.
  const sent: Message[] = [];
  await emailService(sent).dispatch(100);
  assert.equal(sent.length, 0);
  const next = await announcement();
  assert.equal(
    (await announcer().run({ id: next, dryRun: true, actor })).dryRun &&
      (await createPartnerAnnouncementRepository(fixture.app).countDue(next)),
    0,
  );

  // The partner's transactional mail still reaches them.
  const status = await createVerificationService(fixture.app, {
    clock,
    tokenSecret: secret,
  }).issue(partner.subscriberId, 'status');
  const service = emailService(sent);
  assert.equal(
    await service.queue({
      template: partnerFirstSignupTemplate,
      subscriberId: partner.subscriberId,
      businessKey: `test-transactional:${partner.id}`,
      provider: 'resend',
      payload: { status_token_id: status.id },
    }),
    true,
  );
  assert.equal((await service.dispatch(100)).sent, 1);
  assert.deepEqual(
    sent.map((message) => message.to),
    [partner.email],
  );
});

// ── Dry run ─────────────────────────────────────────────────────────────────

test('a dry run counts the partners it would reach, queues and issues nothing, and is audited', async () => {
  const id = await announcement();
  const partners = [await audiencePartner(), await audiencePartner()];
  await audiencePartner({ optedIn: false });
  assert.deepEqual(await announcer().run({ id, dryRun: true, actor }), {
    announcementId: id,
    dryRun: true,
    due: 2,
  });
  assert.deepEqual(await announcementRows(id), []);
  for (const partner of partners)
    assert.equal(await statusTokens(partner.subscriberId), 0);
  assert.deepEqual(await runAudits(id), [
    {
      actor,
      subject_type: 'partner_announcement',
      subject_id: null,
      detail: { announcement_id: id, dry_run: true, partners_due: 2 },
    },
  ]);

  // After a real run, a dry run counts only the partners still due.
  await announcer().run({ id, dryRun: false, actor });
  await audiencePartner();
  assert.deepEqual(await announcer().run({ id, dryRun: true, actor }), {
    announcementId: id,
    dryRun: true,
    due: 1,
  });
  assert.equal((await announcementRows(id)).length, 2);
});

test('an unknown or invalid announcement is refused before anything is read or queued', async () => {
  const partner = await audiencePartner();
  for (const id of ['2026-12-01-missing', '../privacy', 'not-an-id']) {
    await assert.rejects(
      announcer().run({ id, dryRun: false, actor }),
      (error: unknown) =>
        error instanceof PartnerAnnouncementRefusedError &&
        error.refusal === 'not_found',
    );
  }
  const id = '2026-12-01-broken';
  await writeFile(
    join(directory, `${id}.md`),
    announcementSource({ body: 'Visit example.com now.' }),
  );
  await assert.rejects(
    announcer().run({ id, dryRun: true, actor }),
    (error: unknown) =>
      error instanceof PartnerAnnouncementRefusedError &&
      error.refusal === 'invalid' &&
      /web or email address/u.test(error.details.join()),
  );
  assert.equal(await statusTokens(partner.subscriberId), 0);
  assert.deepEqual(await runAudits(id), []);
});

// ── Authentication and audit ────────────────────────────────────────────────

const credential = 'test-admin-credential-with-32-characters';
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const code = generateTotp(totpSecret, instant);

async function adminServer(): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const route = createPartnerAnnouncementRoute(announcer());
  const middleware = createAdminAuthMiddleware(
    createAdminAuthenticator({ credential, totpSecret }, clock),
  );
  const server: Server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (typeof value === 'string') headers.set(key, value);
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
    });
    const locals = {};
    const response = await middleware({ locals, request, url }, async () =>
      request.method === 'POST' &&
      url.pathname === '/api/admin/partners/announce'
        ? route({ locals, params: {}, request, url } as unknown as APIContext)
        : new Response(null, { status: 404 }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function io(typed: string) {
  const lines: string[] = [];
  return {
    lines,
    io: {
      async prompt() {
        return typed;
      },
      write(line: string) {
        lines.push(line);
      },
      writeChunk() {},
    },
  };
}

test('authentication and audit: the command is refused without the authenticator code, and each run is audited as the operator', async (t) => {
  const server = await adminServer();
  t.after(() => server.close());
  const id = await announcement();
  const partner = await audiencePartner();
  const environment = {
    ADMIN_API_ORIGIN: server.origin,
    ADMIN_CREDENTIAL: credential,
  };
  assert.equal(
    adminCommands['partners announce']?.usage,
    'partners announce --id <announcement id> [--dry-run]',
  );
  assert.deepEqual(
    adminRouteRegistry.find(
      (entry) => entry.pathname === '/api/admin/partners/announce',
    ),
    {
      source: 'src/pages/api/admin/partners/announce.ts',
      pathname: '/api/admin/partners/announce',
      methods: [{ method: 'POST', audit: 'required' }],
    },
  );

  // At the command line, no code or a malformed one sends nothing.
  let requests = 0;
  for (const typed of ['', '12345', 'abcdef']) {
    const terminal = io(typed);
    await assert.rejects(
      runAdminCommand(
        ['partners', 'announce', '--id', id],
        environment,
        terminal.io,
        async () => {
          requests += 1;
          return new Response(null, { status: 500 });
        },
      ),
      (error: unknown) =>
        error instanceof AdminCommandError &&
        /A six-digit authenticator code is required\. Nothing was sent\./u.test(
          error.message,
        ),
    );
    assert.deepEqual(terminal.lines, []);
  }
  assert.equal(requests, 0);
  // A missing --id is refused before anything is asked or sent.
  await assert.rejects(
    runAdminCommand(['partners', 'announce'], environment, io(code).io),
    /Name the announcement: --id\./u,
  );

  // At the API, a missing or wrong code is 401, and nothing is queued or audited.
  for (const totp of [null, '000000']) {
    const response = await fetch(
      new URL('/api/admin/partners/announce', server.origin),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          ...(totp === null ? {} : { 'X-Valstara-TOTP': totp }),
        },
        body: JSON.stringify({ id }),
      },
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json()).error.code, 'unauthorized');
  }
  assert.deepEqual(await announcementRows(id), []);
  assert.deepEqual(await runAudits(id), []);

  // With the code: the dry run prints only the count; the run queues.
  const dry = io(code);
  await runAdminCommand(
    ['partners', 'announce', '--id', id, '--dry-run'],
    environment,
    dry.io,
  );
  assert.deepEqual(dry.lines, [
    `1 partners would receive announcement ${id}. Nothing was sent.`,
  ]);
  assert.deepEqual(await announcementRows(id), []);
  const real = io(code);
  await runAdminCommand(
    ['partners', 'announce', '--id', id],
    environment,
    real.io,
  );
  assert.deepEqual(real.lines, [
    `Announcement ${id}: 1 queued now, 0 queued before.`,
    'Every eligible partner has it.',
  ]);
  assert.equal(
    (await rows(partnerAnnouncementBusinessKey(id, partner.id))).length,
    1,
  );
  assert.deepEqual(
    (await runAudits(id)).map(({ actor: who, detail }) => ({ who, detail })),
    [
      {
        who: adminActor,
        detail: { announcement_id: id, dry_run: true, partners_due: 1 },
      },
      {
        who: adminActor,
        detail: {
          announcement_id: id,
          dry_run: false,
          outcome: 'completed',
          queued: 1,
          already_queued: 0,
          remaining: 0,
        },
      },
    ],
  );

  // Refusals reach the founder as copy-layer messages.
  await setFlag('partners.announcements', false);
  await assert.rejects(
    runAdminCommand(
      ['partners', 'announce', '--id', id],
      environment,
      io(code).io,
    ),
    (error: unknown) =>
      error instanceof AdminCommandError &&
      error.message ===
        `invalid_input: ${adminCopy.partnerAnnouncement.flagsOff(['partners.announcements'])}`,
  );
});

test('the route refuses a malformed body, an unknown id and an invalid file with copy-layer messages', async () => {
  const handle = createPartnerAnnouncementHandler(announcer());
  const post = (body: string) =>
    handle({
      actor,
      request: new Request('http://127.0.0.1/api/admin/partners/announce', {
        method: 'POST',
        body,
      }),
    });
  for (const body of [
    'not json',
    '[]',
    '{}',
    '{"id":""}',
    '{"id":"2026-12-01-a","dry_run":"yes"}',
    '{"id":"2026-12-01-a","extra":true}',
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, body);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: {
        code: 'invalid_input',
        message: adminCopy.partnerAnnouncement.bodyInvalid,
      },
    });
  }
  const unknown = await post('{"id":"2026-12-01-unknown"}');
  assert.deepEqual(await unknown.json(), {
    error: {
      code: 'invalid_input',
      message: adminCopy.partnerAnnouncement.notFound,
    },
  });
  const id = '2026-12-01-route-broken';
  await writeFile(
    join(directory, `${id}.md`),
    announcementSource({ subject: 'Partner Programme Update' }),
  );
  const invalid = await post(JSON.stringify({ id, dry_run: true }));
  assert.equal(invalid.status, 400);
  assert.match(
    (await invalid.json()).error.message,
    /^That announcement breaks its rules: the subject must be in sentence case/u,
  );
});

// ── Rendering in both parts ─────────────────────────────────────────────────

test('the rendered announcement carries the subject, the prose and its links in both parts, links the dashboard request and the status page, and names no one', async () => {
  const id = await announcement();
  const partner = await insertPartner(fixture, {
    status: 'active',
    fullName: 'Maya Renderson',
  });
  await fixture.owner.execute({
    text: 'UPDATE partner SET nonessential_email_enabled = true WHERE id = $1',
    values: [partner.id],
  });
  await announcer().run({ id, dryRun: false, actor });
  const sent: Message[] = [];
  assert.equal((await emailService(sent).dispatch(100)).sent, 1);
  const [message] = sent;
  assert.ok(message);
  const copy = partnersCopy.email.announcement;
  assert.equal(message.to, partner.email);
  assert.equal(
    message.from,
    `${emailCopy.senderName} <hello@mail.valstara.com>`,
  );
  assert.equal(message.subject, 'Programme news for December');
  const html = message.html ?? '';
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll("'", '&#39;');
  for (const line of [
    'The partner leaderboard now updates every hour.',
    'Read the programme page for the details, or ask a question.',
    copy.dashboard,
    copy.choice,
  ]) {
    assert.ok(message.text.includes(line), `text: ${line}`);
    assert.ok(html.includes(escape(line)), `html: ${line}`);
  }
  assert.ok(html.includes(escape(copy.preheader)));
  // The announcement's first link is the button; then its other link, the
  // dashboard request and the status page, in both parts.
  const recovery = new URL(dashboardRecoveryPath, origin).toString();
  const links = [
    ['programme page', `${origin}/partners`],
    ['ask a question', `${origin}/about`],
    [copy.action, recovery],
  ];
  for (const [label, url] of links) {
    assert.ok(message.text.includes(`${label}: ${url}`), `text link ${label}`);
    assert.ok(html.includes(`href="${escape(url)}"`), `html link ${label}`);
  }
  assert.match(
    html,
    new RegExp(`class="v-button"[^>]*>\\s*<a href="${origin}/partners"`, 'u'),
  );
  assert.match(
    message.text,
    new RegExp(`${emailCopy.status}: ${origin}/me\\?t=`, 'u'),
  );
  assert.match(message.text, new RegExp(`${emailCopy.unsubscribe}: `, 'u'));
  // It names no one: neither the partner's name nor address is in the body.
  for (const part of [message.text, html]) {
    assert.equal(part.includes('Maya Renderson'), false);
    assert.equal(part.includes(partner.email), false);
    assert.doesNotMatch(part, /<img\b/u);
  }

  // Without links of its own, the dashboard request is the button.
  const plain = await announcement({ body: 'A short programme update.' });
  await announcer().run({ id: plain, dryRun: false, actor });
  const plainSent: Message[] = [];
  await emailService(plainSent).dispatch(100);
  const plainHtml = plainSent[0]?.html ?? '';
  assert.match(
    plainHtml,
    new RegExp(
      `class="v-button"[^>]*>\\s*<a href="${escape(recovery).replace(/[.?]/gu, '\\$&')}"`,
      'u',
    ),
  );
  assert.equal(plainHtml.split(`href="${escape(recovery)}"`).length - 1, 1);
});

test('an announcement file missing or broken at dispatch fails the send rather than sending something else', async () => {
  const id = await announcement();
  const partner = await audiencePartner();
  await announcer().run({ id, dryRun: false, actor });
  await unlink(join(directory, `${id}.md`));
  const failed: string[] = [];
  const service = createEmailService(fixture.app, {
    clock,
    tokenSecret: secret,
    baseUrl: origin,
    providers: new Map([['brevo', provider('brevo', 'mail.valstara.com', [])]]),
    renderers: new Map([
      [
        partnerAnnouncementTemplate,
        partnerAnnouncementRenderer({
          baseUrl: origin,
          sendingDomain: 'mail.valstara.com',
          announcement: (announcementId) =>
            readPartnerAnnouncement(announcementId, directory),
        }),
      ],
    ]),
    isBroadcastEnabled: async () => true,
    operatorTask: async ({ code: failure }) => {
      failed.push(failure);
    },
  });
  assert.equal((await service.dispatch(100)).sent, 0);
  const [row] = await rows(partnerAnnouncementBusinessKey(id, partner.id));
  assert.equal(row?.state, 'failed');
  assert.deepEqual(failed, [row?.last_error]);
});

test('the new modules load under Node’s own type stripping, as the maintenance worker and the command line run them', async () => {
  // The tests run under tsx; production runs `node ./src/server/subscriber/
  // run-maintenance.ts`, which accepts erasable TypeScript only.
  const run = promisify(execFile);
  const modules = [
    'src/server/partner/announcement-content.ts',
    'src/server/partner/announcement.ts',
    'src/server/partner/announcement-template.ts',
    'src/server/email/resend-dispatch.ts',
    'src/server/admin/cli.ts',
  ];
  // Each module is preloaded with --import, exactly as Node loads a file it
  // runs, and the script only reports that they all loaded.
  const { stdout } = await run(
    process.execPath,
    [
      ...modules.flatMap((path) => ['--import', `./${path}`]),
      '--input-type=module',
      '-e',
      "console.log('loaded')",
    ],
    { cwd: resolve('.'), env: { PATH: process.env.PATH ?? '' } },
  );
  assert.equal(stdout.trim(), 'loaded');
});
