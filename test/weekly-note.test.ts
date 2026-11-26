import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { emailCopy } from '../src/copy/email.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  createEmailService,
  type EmailProvider,
  type Message,
} from '../src/server/email/service.ts';
import { renderEmailDocument } from '../src/server/email/template-layout.ts';
import {
  createWeeklyCampaignJob,
  type WeeklyCampaignDependencies,
} from '../src/server/email/weekly-campaign.ts';
import {
  checkWeeklyNotes,
  isIsoWeek,
  parseWeeklyNote,
  readWeeklyNote,
  WeeklyNoteError,
  weeklyNoteHash,
  type WeeklyNote,
} from '../src/server/email/weekly-note-content.ts';
import {
  createWeeklyNoteService,
  type WeeklyNoteP3,
} from '../src/server/email/weekly-note.ts';
import { createWeeklyTemplate } from '../src/server/email/weekly-template.ts';
import { campaignFlagRegistry } from '../src/server/flags/registry.ts';
import { createSharedLeaderboardSnapshotStore } from '../src/server/leaderboard/persisted.ts';
import type { SharedLeaderboardSnapshot } from '../src/server/leaderboard/persisted.ts';

const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const secret = 'weekly-note-test-secret-32-characters!';
const schedule = { isoWeekday: 2, hour: 9, minute: 0 };
const origin = 'https://valstara.com';

const noteA =
  'We finished the supplier checks for December this week.\n\nThe numbers are in [the Trust Ledger](/trust-ledger), the bad ones included.\n';
const noteAProse = 'We finished the supplier checks for December this week.';
const noteB = 'A different note that a deploy put in place mid-run.\n';
const noteBProse = 'A different note that a deploy put in place mid-run.';

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
}

function problemsOf(source: string, isoWeek = '2026-W50'): string {
  const parsed = parseWeeklyNote(isoWeek, source, {
    forbiddenTerms: ['unlimited', 'instant delivery'],
  });
  assert.ok('problems' in parsed, `expected problems for: ${source}`);
  return parsed.problems.join('\n');
}

// ── Validation ──────────────────────────────────────────────────────────────

test('E11.8-03 a valid note parses into paragraphs, one own-origin link and its content hash', () => {
  const parsed = parseWeeklyNote('2026-W50', noteA);
  assert.ok('note' in parsed);
  assert.deepEqual(parsed.note, {
    isoWeek: '2026-W50',
    paragraphs: [
      noteAProse,
      'The numbers are in the Trust Ledger, the bad ones included.',
    ],
    link: { label: 'the Trust Ledger', path: '/trust-ledger' },
    hash: weeklyNoteHash(noteA),
  });
  assert.match(parsed.note.hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(weeklyNoteHash(noteA), weeklyNoteHash(`${noteA} `));
  // Exactly 120 words is allowed; a note needs no link.
  const longest = parseWeeklyNote('2026-W50', words(120));
  assert.ok('note' in longest);
  assert.equal(longest.note.link, null);
});

test('E11.8-03 validation red paths: length, off-origin link, image, HTML, merge field and the copy rules', () => {
  // Length.
  assert.match(
    problemsOf(words(121)),
    /the note has 121 words; at most 120 are allowed/u,
  );
  // An off-origin link, in every form, and a second link.
  for (const target of [
    'https://example.com/offer',
    'http://valstara.com.example.net/',
    '//example.com/offer',
    'mailto:someone@example.com',
    'javascript:void',
    'trust-ledger',
    '/\\example.com',
    'https://valstara.com/trust-ledger',
  ])
    assert.match(
      problemsOf(`Read [this page](${target}) today.`),
      /must be a path on the site/u,
      target,
    );
  assert.match(
    problemsOf('See [one](/trust-ledger) and [two](/guarantee).'),
    /the note has 2 links; at most 1 is allowed/u,
  );
  // A written address a mail client would turn into an off-origin link.
  for (const prose of [
    'Visit example.com for more.',
    'Visit www.example.com for more.',
    'Write to someone@example.com.',
  ])
    assert.match(problemsOf(prose), /web or email address/u, prose);
  // An image.
  assert.match(
    problemsOf('Look at this ![our logo](/images/logo.png) today.'),
    /the note contains an image/u,
  );
  // HTML, as a tag and as an entity.
  assert.match(
    problemsOf('A <strong>bold</strong> claim.'),
    /the note contains HTML/u,
  );
  assert.match(problemsOf('Fish &amp; chips.'), /the note contains HTML/u);
  // A merge field, in every common syntax.
  for (const field of [
    'Hi {{ contact.FIRSTNAME }}, thanks.',
    'Hi {name}, thanks.',
    'Hi *|FNAME|*, thanks.',
    'Hi %%firstname%%, thanks.',
    'Hi [[name]], thanks.',
    'Hi %FIRSTNAME%, thanks.',
  ])
    assert.match(problemsOf(field), /merge field/u, field);
  // Plain prose only, and the copy rules.
  assert.match(problemsOf('# A heading\n\nText.'), /markdown structure/u);
  assert.match(problemsOf('- a list item'), /markdown structure/u);
  assert.match(problemsOf('---\ntitle: x\n---\nText.'), /markdown structure/u);
  assert.match(problemsOf('Some **bold** text.'), /markdown formatting/u);
  assert.match(problemsOf('Big news today!'), /exclamation mark/u);
  assert.match(
    problemsOf('Unlimited savings for everyone.'),
    /forbidden copy "unlimited"/u,
  );
  assert.match(problemsOf('A [stray bracket.'), /square brackets/u);
  assert.match(problemsOf('   \n\n'), /the note has no text/u);
  // The file name must name a week that exists.
  for (const isoWeek of ['2026-W00', '2026-W54', '2025-W53', '2026-50', 'x'])
    assert.match(
      problemsOf('Plain prose.', isoWeek),
      /the file name must be YYYY-Www\.md/u,
      isoWeek,
    );
});

test('E11.8-03 ISO weeks: week 53 exists only in long years', () => {
  assert.equal(isIsoWeek('2026-W53'), true);
  assert.equal(isIsoWeek('2020-W53'), true);
  assert.equal(isIsoWeek('2025-W53'), false);
  assert.equal(isIsoWeek('2027-W52'), true);
  assert.equal(isIsoWeek('2027-W53'), false);
  assert.equal(isIsoWeek('2026-W01'), true);
});

test('E11.8-03 the folder check names each bad file, and reading throws on an invalid note', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'valstara-weekly-notes-'));
  try {
    assert.deepEqual(checkWeeklyNotes(join(folder, 'absent')), []);
    await writeFile(join(folder, '.gitkeep'), '');
    await writeFile(join(folder, '2026-W50.md'), noteA);
    assert.deepEqual(checkWeeklyNotes(folder), []);
    assert.equal(
      readWeeklyNote('2026-W50', folder)?.hash,
      weeklyNoteHash(noteA),
    );
    assert.equal(readWeeklyNote('2026-W51', folder), null);
    await writeFile(join(folder, '2026-W51.md'), 'Big news!');
    await writeFile(join(folder, 'draft.md'), 'Plain prose.');
    await writeFile(join(folder, 'notes.txt'), 'Plain prose.');
    const problems = checkWeeklyNotes(folder).join('\n');
    assert.match(problems, /2026-W51\.md: the note has an exclamation mark/u);
    assert.match(problems, /draft\.md: the file name must be YYYY-Www\.md/u);
    assert.match(problems, /notes\.txt: only YYYY-Www\.md note files/u);
    assert.throws(
      () => readWeeklyNote('2026-W51', folder),
      (error: unknown) =>
        error instanceof WeeklyNoteError &&
        error.problems.some((problem) => /exclamation/u.test(problem)),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('E11.8-03 a note that fails validation fails the build: the check runs before every build', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts.prebuild ?? '',
    /tsx scripts\/ci\/weekly-notes-check\.ts/u,
  );
  // The image builds and the bundled-build inputs carry the check too, and
  // the runtime image carries the notes the worker reads.
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assert.match(
    dockerfile,
    /COPY scripts\/ci\/weekly-notes-check\.ts \.\/scripts\/ci\/weekly-notes-check\.ts/u,
  );
  assert.match(
    dockerfile,
    /COPY --chown=node:node --from=build \/app\/src\/content\/weekly-notes \.\/src\/content\/weekly-notes/u,
  );
  for (const file of [
    'scripts/ci/app-build.mjs',
    'test/helpers/price-fixture-site.mjs',
  ])
    assert.match(
      await readFile(file, 'utf8'),
      /'scripts\/ci\/weekly-notes-check\.ts'/u,
      file,
    );

  const run = promisify(execFile);
  const script = resolve('scripts/ci/weekly-notes-check.ts');
  const tsx = resolve('node_modules/.bin/tsx');
  const root = await mkdtemp(join(tmpdir(), 'valstara-weekly-note-build-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await copyFile(
      'scripts/forbidden-copy.json',
      join(root, 'scripts/forbidden-copy.json'),
    );
    // No folder at all holds no notes.
    await run(tsx, [script], { cwd: root });
    const folder = join(root, 'src/content/weekly-notes');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '.gitkeep'), '');
    await writeFile(join(folder, '2026-W50.md'), noteA);
    await run(tsx, [script], { cwd: root });
    const cases: readonly (readonly [string, RegExp])[] = [
      [words(121), /the note has 121 words/u],
      ['Read [this](https://example.com) now.', /must be a path on the site/u],
      ['See ![logo](/logo.png).', /the note contains an image/u],
      ['A <b>bold</b> line.', /the note contains HTML/u],
      ['Hi {{ contact.FIRSTNAME }}.', /merge field/u],
      // A forbidden-copy term fails the build, not only the CI scan.
      ['Unlimited savings for everyone.', /forbidden copy "unlimited"/u],
    ];
    for (const [source, expected] of cases) {
      await writeFile(join(folder, '2026-W51.md'), source);
      await assert.rejects(
        run(tsx, [script], { cwd: root }),
        (error: Error) => {
          const stderr = String((error as Error & { stderr?: string }).stderr);
          assert.match(stderr, /A weekly note failed its checks/u);
          assert.match(stderr, /2026-W51\.md: /u);
          assert.match(stderr, expected);
          return true;
        },
        source,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E11.8-03 the repository folder holds only valid notes', () => {
  const policy = JSON.parse(
    readFileSync('scripts/forbidden-copy.json', 'utf8'),
  ) as { entries: { term: string }[] };
  assert.deepEqual(
    checkWeeklyNotes(undefined, {
      forbiddenTerms: policy.entries.map(({ term }) => term),
    }),
    [],
  );
});

// ── Rendering ───────────────────────────────────────────────────────────────

const snapshot: SharedLeaderboardSnapshot = {
  id: randomUUID(),
  asOf: '2026-10-06T08:55:00.000Z',
  entries: [
    { rank: 1, displayHandle: 'BQBao_sEnxqw', confirmedReferrals: 7 },
    { rank: 2, displayHandle: 'Zk3Lm9Qp2Rt4', confirmedReferrals: 3 },
  ],
} as SharedLeaderboardSnapshot;

function parsedNote(isoWeek: string, source: string): WeeklyNote {
  const parsed = parseWeeklyNote(isoWeek, source);
  assert.ok('note' in parsed);
  return parsed.note;
}

function renderWith(
  note: Parameters<typeof createWeeklyTemplate>[0]['note'],
  payload: Record<string, unknown>,
): Promise<Message> {
  return createWeeklyTemplate({
    baseUrl: origin,
    sendingDomain: 'mail.valstara.com',
    snapshotById: async () => snapshot,
    ...(note === undefined ? {} : { note }),
  }).render({
    email: 'reader@example.test',
    payload,
    token: async () => 'status-token',
    unsubscribePageUrl: `${origin}/unsubscribe?t=bound-token`,
  });
}

test('E11.8-03 the note renders in both parts, after the top-10 block and before the status button', async () => {
  const asked: string[] = [];
  const message = await renderWith(
    {
      forDispatch: async (isoWeek) => {
        asked.push(isoWeek);
        return parsedNote('2026-W41', noteA);
      },
    },
    {
      snapshot_id: snapshot.id,
      status_token_id: randomUUID(),
      period: '2026-W41',
    },
  );
  assert.deepEqual(asked, ['2026-W41']);
  const html = message.html ?? '';
  for (const part of [message.text, html]) {
    const lastEntry = part.indexOf('2. Zk3Lm9Qp2Rt4: 3 confirmed referrals');
    const heading = part.indexOf(emailCopy.weekly.noteHeading);
    const prose = part.indexOf(noteAProse);
    const second = part.indexOf(
      'The numbers are in the Trust Ledger, the bad ones included.',
    );
    const status = part.indexOf(emailCopy.status);
    assert.ok(lastEntry > 0, 'the top-10 block renders');
    assert.ok(lastEntry < heading, 'the note follows the top-10 block');
    assert.ok(heading < prose && prose < second);
    assert.ok(second < status, 'the status link follows the note');
  }
  assert.match(
    message.text,
    /the Trust Ledger: https:\/\/valstara\.com\/trust-ledger\n/u,
  );
  assert.match(
    html,
    /<a href="https:\/\/valstara\.com\/trust-ledger">the Trust Ledger<\/a>/u,
  );
  // The note's link is a 44px tap target like every other text link.
  assert.match(
    html,
    /<td class="v-text v-link"[^>]*><a href="https:\/\/valstara\.com\/trust-ledger">/u,
  );
  // Nothing about the note reaches the subject or the preheader.
  assert.equal(message.subject, emailCopy.weekly.subject);
  assert.doesNotMatch(html, /\[the Trust Ledger\]|\(\/trust-ledger\)/u);
});

test('E11.8-03 without a note the weekly update is unchanged', async () => {
  const payload = { snapshot_id: snapshot.id, status_token_id: randomUUID() };
  const today = await renderWith(undefined, payload);
  // No recorded note: the renderer never asks for one.
  const notAsked = await renderWith(
    {
      forDispatch: async () => assert.fail('no run recorded a note'),
    },
    payload,
  );
  // A run that recorded a note whose note is now left out or switched off.
  const leftOut = await renderWith(
    { forDispatch: async () => null },
    { ...payload, period: '2026-W41' },
  );
  // A renderer built without the note dependency never adds one.
  const unwired = await renderWith(undefined, {
    ...payload,
    period: '2026-W41',
  });
  assert.deepEqual(notAsked, today);
  assert.deepEqual(leftOut, today);
  assert.deepEqual(unwired, today);
  assert.doesNotMatch(
    `${today.text}${today.html ?? ''}`,
    new RegExp(emailCopy.weekly.noteHeading, 'u'),
  );
  // The layout's note section is optional: absent, every message is
  // byte-identical to the layout without it.
  const document = {
    subject: 's',
    preheader: 'p',
    paragraphs: ['One.'],
    facts: ['A fact.'],
    links: [{ label: 'Go', url: `${origin}/me` }] as const,
  };
  const base = { from: 'a@b.c', to: 'r@x.test', unsubscribePageUrl: origin };
  assert.deepEqual(
    renderEmailDocument({
      ...base,
      document: { ...document, note: undefined },
    }),
    renderEmailDocument({ ...base, document }),
  );
  await assert.rejects(
    renderWith({ forDispatch: async () => null }, { ...payload, period: 41 }),
    /weekly_reference_missing/u,
  );
});

test('E11.8-03 the flag is registered off and the worker wires it to both the run and dispatch', async () => {
  assert.equal(campaignFlagRegistry['email.weekly_note'], false);
  const maintenance = await readFile(
    'src/server/subscriber/run-maintenance.ts',
    'utf8',
  );
  assert.match(
    maintenance,
    /weeklyCampaign: createWeeklyCampaignJob\(\{[\s\S]*?note: createWeeklyNoteService\(\{[\s\S]*?isEnabled: \(\) => broadcastFlags\.isEnabled\('email\.weekly_note'\)/u,
  );
  assert.match(
    maintenance,
    /isWeeklyNoteEnabled: \(\) =>\s*broadcastFlags\.isEnabled\('email\.weekly_note'\)/u,
  );
  assert.match(
    await readFile('src/server/email/resend-dispatch.ts', 'utf8'),
    /createWeeklyTemplate\(\{[\s\S]*?note: createWeeklyNoteService\(\{[\s\S]*?isEnabled:\s*broadcast\.isWeeklyNoteEnabled \?\? \(async \(\) => false\)/u,
  );
});

test('E11.8-03 with the flag off or unreadable, a starting run records no note and reads no file', async () => {
  for (const isEnabled of [
    async () => false,
    async () => {
      throw new Error('flag store down');
    },
  ]) {
    const service = createWeeklyNoteService({
      database: {} as DatabasePool,
      isEnabled,
      clock: () => new Date('2026-10-06T09:00:00Z'),
      read: () => assert.fail('a note was read while the flag was off'),
      reportP3: () => assert.fail('no P3 while the flag is off'),
    });
    assert.equal(await service.atRunStart('2026-W41'), null);
    assert.equal(await service.forDispatch('2026-W41'), null);
  }
});

// ── Against a real database ─────────────────────────────────────────────────

interface Fixture {
  readonly owner: DatabasePool;
  readonly app: DatabasePool;
}

async function withDatabase(
  label: string,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const name = `valstara_e11803_${label}_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(adminUrl);
  await admin.execute({ text: `CREATE DATABASE "${name}"` });
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  const owner = createPool(ownerUrl.toString());
  let app: DatabasePool | undefined;
  try {
    await runMigrations(owner, {
      applicationRolePassword: appPassword,
      release: `e11-8-03-${label}`,
    });
    app = createPool(appUrl.toString());
    await body({ owner, app });
  } finally {
    await app?.close();
    await owner.close();
    await admin.execute({ text: `DROP DATABASE "${name}" WITH (FORCE)` });
    await admin.close();
  }
}

async function insertMembers(
  owner: DatabasePool,
  count: number,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID()).sort();
  for (const id of ids)
    await owner.execute({
      text: `INSERT INTO subscriber
        (id, email, email_normalised, email_domain, status, verified_at,
         marketing_consent_at, marketing_consent_version, marketing_consent_source)
        VALUES ($1, $2, $2, 'example.test', 'verified', $3, $3, 'v1', 'signup')`,
      values: [id, `${id}@example.test`, new Date('2026-09-30T00:00:00Z')],
    });
  return ids;
}

interface Harness {
  readonly job: ReturnType<typeof createWeeklyCampaignJob>;
  readonly dispatch: (
    limit: number,
  ) => ReturnType<ReturnType<typeof createEmailService>['dispatch']>;
  readonly sent: { to: string; message: Message }[];
  readonly p3: WeeklyNoteP3[];
  readonly service: ReturnType<typeof createWeeklyNoteService>;
  setNow(value: string): void;
  setFlag(value: boolean): void;
}

async function harness(app: DatabasePool, notes: string): Promise<Harness> {
  let now = new Date('2026-10-06T08:00:00Z');
  let flag = false;
  const clock = () => now;
  const store = createSharedLeaderboardSnapshotStore(
    app,
    { leaderboardCandidates: async () => [] },
    clock,
  );
  await store.refresh();
  const p3: WeeklyNoteP3[] = [];
  const service = createWeeklyNoteService({
    database: app,
    isEnabled: async () => flag,
    clock,
    read: (isoWeek) => readWeeklyNote(isoWeek, notes),
    reportP3: (event) => p3.push(event),
  });
  const queue = createEmailService(app, {
    clock,
    tokenSecret: secret,
    baseUrl: origin,
    providers: new Map(),
    renderers: new Map(),
    isBroadcastEnabled: async () => false,
    operatorTask: async () => undefined,
  });
  const dependencies: WeeklyCampaignDependencies = {
    database: app,
    flags: { isEnabled: async (key) => key === 'email.broadcast' },
    snapshot: store,
    email: { queue: (input, connection) => queue.queue(input, connection) },
    alerts: { send: async () => undefined },
    clock,
    tokenSecret: secret,
    schedule,
    note: service,
  };
  const sent: { to: string; message: Message }[] = [];
  const brevo: EmailProvider = {
    id: 'brevo',
    sendingDomain: 'mail.valstara.com',
    capabilities: { broadcast: true, contactSync: true, dailyFreeCap: 300 },
    async send({ message }) {
      sent.push({ to: message.to, message });
      return { providerMessageId: randomUUID() };
    },
  };
  const operatorTasks: string[] = [];
  const sending = createEmailService(app, {
    clock,
    tokenSecret: secret,
    baseUrl: origin,
    providers: new Map([['brevo', brevo]]),
    renderers: new Map([
      [
        'weekly_campaign_update',
        createWeeklyTemplate({
          baseUrl: origin,
          sendingDomain: 'mail.valstara.com',
          snapshotById: (id) => store.byId(id),
          note: service,
        }),
      ],
    ]),
    isBroadcastEnabled: async () => true,
    operatorTask: async ({ code }) => {
      operatorTasks.push(code);
    },
  });
  return {
    job: createWeeklyCampaignJob(dependencies),
    async dispatch(limit) {
      const summary = await sending.dispatch(limit);
      assert.deepEqual(operatorTasks, [], 'no send failed to render');
      return summary;
    },
    sent,
    p3,
    service,
    setNow(value) {
      now = new Date(value);
    },
    setFlag(value) {
      flag = value;
    },
  };
}

async function runRow(owner: DatabasePool, isoWeek: string) {
  return owner.readOne<{
    note_hash: string | null;
    note_left_out_at: Date | null;
  }>({
    text: 'SELECT note_hash, note_left_out_at FROM weekly_campaign_run WHERE iso_week = $1',
    values: [isoWeek],
  });
}

async function payloads(owner: DatabasePool, isoWeek: string) {
  return owner.list<{ payload: Record<string, string> }>(
    {
      text: `SELECT payload FROM email_send
        WHERE business_key LIKE 'weekly:' || $1 || ':%' ORDER BY business_key`,
      values: [isoWeek],
    },
    20,
  );
}

function hasNote(message: Message, prose: string): boolean {
  const inText = message.text.includes(prose);
  const inHtml = (message.html ?? '').includes(prose);
  assert.equal(inText, inHtml, 'both parts carry the same note');
  return inText;
}

test('E11.8-03 week matching against a real database: flag off sends the unchanged update, a week without a note sends it unchanged, and a note is used only in its own week', async () => {
  const notes = await mkdtemp(join(tmpdir(), 'valstara-weekly-notes-db-'));
  try {
    await withDatabase('weeks', async ({ owner, app }) => {
      const members = await insertMembers(owner, 2);
      for (const isoWeek of ['2026-W40', '2026-W41', '2026-W43', '2026-W44'])
        await writeFile(
          join(notes, `${isoWeek}.md`),
          `The note written for ${isoWeek.replace('-', ' ')} only.\n`,
        );
      const h = await harness(app, notes);
      const allNotes = (message: Message) =>
        ['2026 W40', '2026 W41', '2026 W42', '2026 W43', '2026 W44'].filter(
          (week) => hasNote(message, `for ${week} only`),
        );

      // Week 41, flag off: no note recorded, the payload is E8-07's, and the
      // update carries no note although one exists for the week.
      h.setNow('2026-10-06T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      assert.deepEqual(await runRow(owner, '2026-W41'), {
        note_hash: null,
        note_left_out_at: null,
      });
      for (const { payload } of await payloads(owner, '2026-W41'))
        assert.deepEqual(Object.keys(payload).sort(), [
          'snapshot_id',
          'status_token_id',
        ]);
      // Switching the flag on mid-run changes nothing for a run that
      // recorded no note.
      h.setFlag(true);
      assert.equal((await h.dispatch(10)).sent, 2);
      for (const { message } of h.sent) {
        assert.deepEqual(allNotes(message), []);
        assert.ok(!message.text.includes(emailCopy.weekly.noteHeading));
      }
      assert.deepEqual(
        h.sent.map(({ to }) => to).sort(),
        members.map((id) => `${id}@example.test`),
      );

      // Week 42, flag on, no note for week 42 (notes exist for the weeks
      // either side): the update is unchanged.
      h.sent.length = 0;
      h.setNow('2026-10-13T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      assert.equal((await runRow(owner, '2026-W42'))?.note_hash, null);
      for (const { payload } of await payloads(owner, '2026-W42'))
        assert.equal(payload.period, undefined);
      assert.equal((await h.dispatch(10)).sent, 2);
      for (const { message } of h.sent) {
        assert.deepEqual(allNotes(message), []);
        assert.ok(!message.text.includes(emailCopy.weekly.noteHeading));
      }

      // Week 43, flag on: its own note, and no other week's.
      h.sent.length = 0;
      h.setNow('2026-10-20T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      assert.equal(
        (await runRow(owner, '2026-W43'))?.note_hash,
        weeklyNoteHash('The note written for 2026 W43 only.\n'),
      );
      for (const { payload } of await payloads(owner, '2026-W43'))
        assert.equal(payload.period, '2026-W43');
      assert.equal((await h.dispatch(10)).sent, 2);
      for (const { message } of h.sent) {
        assert.deepEqual(allNotes(message), ['2026 W43']);
        assert.ok(message.text.includes(emailCopy.weekly.noteHeading));
      }

      // The flag-off path at dispatch: a week-44 run recorded its note, the
      // flag goes off, and what is sent carries no note.
      h.sent.length = 0;
      h.setNow('2026-10-27T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      assert.notEqual((await runRow(owner, '2026-W44'))?.note_hash, null);
      h.setFlag(false);
      assert.equal((await h.dispatch(10)).sent, 2);
      for (const { message } of h.sent) assert.deepEqual(allNotes(message), []);
      assert.deepEqual(h.p3, []);
    });
  } finally {
    await rm(notes, { recursive: true, force: true });
  }
});

test('E11.8-03 a note changed during the send window is left out of the rest of the run, with one P3, and no run mixes two notes', async () => {
  const notes = await mkdtemp(join(tmpdir(), 'valstara-weekly-notes-mid-'));
  try {
    await withDatabase('midrun', async ({ owner, app }) => {
      await insertMembers(owner, 4);
      const path = join(notes, '2026-W41.md');
      await writeFile(path, noteA);
      const h = await harness(app, notes);
      h.setFlag(true);
      h.setNow('2026-10-06T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      assert.equal(
        (await runRow(owner, '2026-W41'))?.note_hash,
        weeklyNoteHash(noteA),
      );

      // The first message goes out with note A.
      assert.equal((await h.dispatch(1)).sent, 1);
      assert.equal(hasNote(h.sent[0]!.message, noteAProse), true);

      // A deploy changes the note. Every caller at once sees the change;
      // exactly one records it, and exactly one P3 is raised.
      await writeFile(path, noteB);
      h.setNow('2026-10-06T10:00:00Z');
      const concurrent = await Promise.all(
        Array.from({ length: 6 }, () => h.service.forDispatch('2026-W41')),
      );
      assert.deepEqual(concurrent, Array(6).fill(null));
      assert.deepEqual(h.p3, [
        {
          isoWeek: '2026-W41',
          reason: 'changed',
          occurredAt: new Date('2026-10-06T10:00:00Z'),
        },
      ]);
      const leftOut = await runRow(owner, '2026-W41');
      assert.equal(leftOut?.note_hash, weeklyNoteHash(noteA));
      assert.equal(
        leftOut?.note_left_out_at?.toISOString(),
        '2026-10-06T10:00:00.000Z',
      );

      // The rest of the run carries neither note, and the P3 is not repeated.
      assert.equal((await h.dispatch(2)).sent, 2);
      // Reverting the deploy does not bring the note back to this run.
      await writeFile(path, noteA);
      assert.equal((await h.dispatch(10)).sent, 1);
      assert.equal(h.sent.length, 4);
      for (const { message } of h.sent.slice(1)) {
        assert.equal(hasNote(message, noteAProse), false);
        assert.equal(hasNote(message, noteBProse), false);
        assert.ok(!message.text.includes(emailCopy.weekly.noteHeading));
      }
      assert.ok(
        h.sent.every(({ message }) => !hasNote(message, noteBProse)),
        'no message in the run carries the second note',
      );
      assert.equal(h.p3.length, 1);

      // The recorded hash cannot be changed by the application, and a
      // left-out mark needs a recorded note.
      await assert.rejects(
        app.execute({
          text: 'UPDATE weekly_campaign_run SET note_hash = $2 WHERE iso_week = $1',
          values: ['2026-W41', weeklyNoteHash(noteB)],
        }),
        /permission denied/u,
      );
      await assert.rejects(
        owner.execute({
          text: `INSERT INTO weekly_campaign_run
            (iso_week, state, recorded_at, note_left_out_at)
            VALUES ('2026-W39', 'skipped', now(), now())`,
        }),
        /weekly_note_left_out_has_note/u,
      );
      await assert.rejects(
        owner.execute({
          text: `INSERT INTO weekly_campaign_run
            (iso_week, state, recorded_at, note_hash)
            VALUES ('2026-W38', 'skipped', now(), 'not-a-hash')`,
        }),
        /check constraint/u,
      );

      // A note removed by a deploy is left out the same way ("missing").
      h.sent.length = 0;
      await writeFile(join(notes, '2026-W42.md'), noteA);
      h.setNow('2026-10-13T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      await unlink(join(notes, '2026-W42.md'));
      assert.equal((await h.dispatch(10)).sent, 4);
      assert.ok(h.sent.every(({ message }) => !hasNote(message, noteAProse)));
      assert.deepEqual(
        h.p3.slice(1).map(({ isoWeek, reason }) => [isoWeek, reason]),
        [['2026-W42', 'missing']],
      );

      // An invalid note at the run's start is not recorded, with a P3, and
      // the update still goes out.
      h.sent.length = 0;
      await writeFile(join(notes, '2026-W43.md'), 'Big news!');
      h.setNow('2026-10-20T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      assert.equal((await runRow(owner, '2026-W43'))?.note_hash, null);
      assert.equal((await h.dispatch(10)).sent, 4);
      assert.deepEqual(
        h.p3.slice(2).map(({ isoWeek, reason }) => [isoWeek, reason]),
        [['2026-W43', 'invalid']],
      );
    });
  } finally {
    await rm(notes, { recursive: true, force: true });
  }
});

test('E11.8-03 the dispatch re-check still refuses an unsubscribed or suppressed member while a note is present', async () => {
  const notes = await mkdtemp(join(tmpdir(), 'valstara-weekly-notes-check-'));
  try {
    await withDatabase('recheck', async ({ owner, app }) => {
      const [kept, unsubscribed, suppressed] = await insertMembers(owner, 3);
      await writeFile(join(notes, '2026-W41.md'), noteA);
      const h = await harness(app, notes);
      h.setFlag(true);
      h.setNow('2026-10-06T09:00:00Z');
      assert.equal((await h.job.run()).state, 'completed');
      assert.equal((await payloads(owner, '2026-W41')).length, 3);
      // After queueing: one member withdraws marketing consent (what an
      // unsubscribe from the weekly update writes), another is suppressed.
      await owner.execute({
        text: `UPDATE subscriber SET marketing_consent_at = NULL,
          marketing_consent_version = NULL, marketing_consent_source = NULL
          WHERE id = $1`,
        values: [unsubscribed],
      });
      await owner.execute({
        text: `INSERT INTO suppression (email_normalised, reason, source)
          VALUES ($1, 'manual', 'test')`,
        values: [`${suppressed}@example.test`],
      });
      const summary = await h.dispatch(10);
      assert.equal(summary.sent, 1);
      assert.equal(summary.suppressed, 2);
      assert.deepEqual(
        h.sent.map(({ to }) => to),
        [`${kept}@example.test`],
      );
      assert.equal(hasNote(h.sent[0]!.message, noteAProse), true);
      const refused = await owner.list<{ subscriber_id: string }>(
        {
          text: `SELECT subscriber_id FROM email_send
            WHERE state = 'failed' AND last_error = 'recipient_ineligible'
            ORDER BY subscriber_id`,
        },
        10,
      );
      assert.deepEqual(
        refused.map(({ subscriber_id }) => subscriber_id),
        [unsubscribed, suppressed].sort(),
      );
    });
  } finally {
    await rm(notes, { recursive: true, force: true });
  }
});
