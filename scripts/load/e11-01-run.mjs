import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Agent, request as httpRequest } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import pg from 'pg';

import { generateTotp } from '../../src/server/admin-auth/totp.ts';
import {
  hostileIdentity,
  phaseCount,
  readProfile,
  signupIdentity,
} from './profile.mjs';

const exec = promisify(execFile);
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const monotonicMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const profilePath =
  process.argv[2] ?? new URL('./e11-01-profile.json', import.meta.url);
const resultPath = process.argv[3];
const profile = await readProfile(profilePath);
const baseUrl = process.env.LOAD_BASE_URL;
const requestOrigin = process.env.LOAD_REQUEST_ORIGIN;
const databaseUrl = process.env.LOAD_DATABASE_URL;
const appContainer = process.env.LOAD_APP_CONTAINER;
const postgresContainer = process.env.LOAD_POSTGRES_CONTAINER;
const umamiContainer = process.env.LOAD_UMAMI_CONTAINER;
const adminCredential = process.env.LOAD_ADMIN_CREDENTIAL;
const adminTotpSecret = process.env.LOAD_ADMIN_TOTP_SECRET;
if (
  !baseUrl ||
  !requestOrigin ||
  !databaseUrl ||
  !appContainer ||
  !postgresContainer ||
  !umamiContainer ||
  !adminCredential ||
  !adminTotpSecret
) {
  throw new Error(
    'Set LOAD_BASE_URL, LOAD_REQUEST_ORIGIN, LOAD_DATABASE_URL, all three LOAD_*_CONTAINER values, and the disposable LOAD_ADMIN_* credentials.',
  );
}
if (
  new URL(baseUrl).hostname !== 'localhost' &&
  new URL(baseUrl).hostname !== '127.0.0.1'
) {
  throw new Error('The E11-01 load runner accepts only a loopback target.');
}
if (new URL(requestOrigin).hostname !== 'valstara.com') {
  throw new Error(
    'The trusted-proxy probe must use the configured Valstara Host.',
  );
}

const runId = randomBytes(4).toString('hex');
const database = new pg.Client({ connectionString: databaseUrl });
await database.connect();
const httpAgent = new Agent({ keepAlive: true, maxSockets: 512 });
const stage = (name) => process.stderr.write(`E11-01 ${name} ${new Date().toISOString()}\n`);

function newSummary() {
  return {
    count: 0,
    statuses: {},
    latenciesMs: [],
    invalidWait: 0,
    wrongSnapshot: 0,
    transportErrors: 0,
  };
}

function observe(
  summary,
  status,
  latency,
  waitHeader,
  expectedSnapshot,
  responseBody,
) {
  summary.count += 1;
  summary.statuses[status] = (summary.statuses[status] ?? 0) + 1;
  summary.latenciesMs.push(latency);
  if (status === 429) {
    const seconds = Number(waitHeader);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900)
      summary.invalidWait += 1;
  }
  if (
    expectedSnapshot !== undefined &&
    (status !== 200 ||
      responseBody?.snapshot_id !== expectedSnapshot ||
      !Array.isArray(responseBody?.entries))
  )
    summary.wrongSnapshot += 1;
}

async function postSignup(identity, summary) {
  const began = monotonicMs();
  try {
    const body = new globalThis.URLSearchParams({
      email: identity.email,
      turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX',
    }).toString();
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        new URL('/api/signup', baseUrl),
        {
          method: 'POST',
          agent: httpAgent,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            Host: new URL(requestOrigin).host,
            Origin: requestOrigin,
            'X-Forwarded-For': identity.prefix,
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve(incoming));
          incoming.on('error', reject);
        },
      );
      request.setTimeout(120_000, () =>
        request.destroy(new Error('signup request timed out')),
      );
      request.on('error', reject);
      request.end(body);
    });
    observe(
      summary,
      response.statusCode,
      monotonicMs() - began,
      response.headers['retry-after'],
    );
  } catch {
    summary.transportErrors += 1;
  }
}

async function getLeaderboard(expectedSnapshot, summary) {
  const began = monotonicMs();
  try {
    const response = await globalThis.fetch(
      new URL('/api/leaderboard', baseUrl),
      { signal: globalThis.AbortSignal.timeout(10_000) },
    );
    const body = await response.json().catch(() => null);
    observe(
      summary,
      response.status,
      monotonicMs() - began,
      null,
      expectedSnapshot,
      body,
    );
  } catch {
    summary.transportErrors += 1;
  }
}

async function runPhase(rate, seconds, operation) {
  const count = phaseCount(rate, seconds);
  const began = monotonicMs();
  const pending = new Set();
  for (let index = 0; index < count; index += 1) {
    const target = began + (index * 1000) / rate;
    const delay = target - monotonicMs();
    if (delay > 0) await wait(delay);
    const task = operation(index).finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size > 1000) await Promise.race(pending);
  }
  await Promise.all(pending);
  return {
    scheduled: count,
    elapsedSeconds: (monotonicMs() - began) / 1000,
  };
}

function p95(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(ordered.length * 0.95) - 1]);
}

function parseBytes(label) {
  const match = /^([0-9.]+)\s*([KMGT]?i?B)$/.exec(label.trim());
  if (!match) throw new Error(`Cannot parse Docker memory metric: ${label}`);
  const power = {
    B: 0,
    kB: 1,
    KB: 1,
    KiB: 1,
    MB: 2,
    MiB: 2,
    GB: 3,
    GiB: 3,
    TB: 4,
    TiB: 4,
  }[match[2]];
  if (power === undefined)
    throw new Error(`Unknown Docker memory unit: ${match[2]}`);
  return Math.round(Number(match[1]) * 1024 ** power);
}

async function memorySample(container) {
  const { stdout } = await exec('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{json .}}',
    container,
  ]);
  const stat = JSON.parse(stdout.trim());
  const [used, limit] = stat.MemUsage.split('/').map(parseBytes);
  return { used, limit };
}

const memory = [];
let memoryBusy = false;
async function sampleMemory(phase = 'interval') {
  if (memoryBusy) {
    if (phase === 'interval') return;
    while (memoryBusy) await wait(25);
  }
  memoryBusy = true;
  try {
    const [app, postgres, umami] = await Promise.all([
      memorySample(appContainer),
      memorySample(postgresContainer),
      memorySample(umamiContainer),
    ]);
    memory.push({
      atSeconds: Math.round(monotonicMs() - memoryStart) / 1000,
      phase,
      app,
      postgres,
      umami,
    });
  } finally {
    memoryBusy = false;
  }
}

async function streamExport() {
  const response = await globalThis.fetch(
    new URL('/api/admin/export.csv', baseUrl),
    {
      signal: globalThis.AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${adminCredential}`,
        'X-Valstara-Totp': generateTotp(adminTotpSecret, new Date()),
      },
    },
  );
  assert.equal(
    response.status,
    200,
    'large export must be authorised and available',
  );
  assert.ok(response.body, 'large export must stream');
  let bytes = 0;
  let lines = 0;
  let nextMemoryLine = 10_000;
  await sampleMemory('export');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    for (const byte of chunk) if (byte === 10) lines += 1;
    if (lines >= nextMemoryLine) {
      await sampleMemory('export');
      nextMemoryLine += 10_000;
    }
  }
  await sampleMemory('export');
  assert.ok(
    lines >= profile.exportRows + 1,
    'large export must include every seeded verified row',
  );
  return { bytes, lines };
}

async function warmConnections() {
  const exportUrl = new URL('/api/admin/export.csv', baseUrl);
  const preflight = await globalThis.fetch(exportUrl, {
    signal: globalThis.AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${adminCredential}`,
      'X-Valstara-Totp': generateTotp(adminTotpSecret, new Date()),
    },
  });
  assert.equal(preflight.status, 200, 'export preflight must connect');
  await preflight.arrayBuffer();
  const warmSignup = newSummary();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      postSignup(
        {
          email: `e1101-warm-${runId}-${attempt}-${index}@gmail.com`,
          prefix: `2001:db8:${runId.slice(0, 4)}:${(0xf000 + attempt * 10 + index).toString(16)}::1`,
        },
        warmSignup,
      ),
    );
    await Promise.all(tasks);
    if ((warmSignup.statuses[200] ?? 0) >= 10) break;
  }
  assert.ok(
    (warmSignup.statuses[200] ?? 0) >= 10,
    `signup warm-up did not establish working connections: ${JSON.stringify(warmSignup.statuses)}`,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await globalThis.fetch(exportUrl, {
      signal: globalThis.AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${adminCredential}`,
        'X-Valstara-Totp': generateTotp(adminTotpSecret, new Date()),
      },
    });
    if (response.status === 200) {
      for await (const chunk of response.body) {
        // Consume the stream so its repeatable-read transaction closes.
        void chunk;
      }
      return { signupRequests: warmSignup.count, exportAttempts: attempt + 1 };
    }
    await response.arrayBuffer();
  }
  throw new Error(
    'admin export warm-up did not establish a working connection',
  );
}

async function seedExport() {
  await database.query(
    `INSERT INTO subscriber (id, email, email_normalised, email_domain, status, verified_at)
     SELECT gen_random_uuid(), 'e1101-export-' || $1::text || '-' || n || '@gmail.com',
       'e1101-export-' || $1::text || '-' || n || '@gmail.com',
       'gmail.com', 'verified', CURRENT_TIMESTAMP
     FROM generate_series(1, $2::int) AS n`,
    [runId, profile.exportRows],
  );
}

async function verifySignup(expected) {
  const {
    rows: [subscribers],
  } = await database.query(
    `SELECT count(*)::int AS rows, count(DISTINCT email_normalised)::int AS distinct_rows
     FROM subscriber WHERE email_normalised LIKE $1`,
    [`e1101-${runId}-%`],
  );
  const {
    rows: [emails],
  } = await database.query(
    `SELECT count(*)::int AS rows, count(DISTINCT e.business_key)::int AS distinct_keys,
       count(*) FILTER (WHERE e.state = 'sent')::int AS sent,
       count(*) FILTER (WHERE e.state = 'queued')::int AS queued,
       count(*) FILTER (WHERE e.state = 'failed')::int AS failed
     FROM email_send e JOIN subscriber s ON s.id = e.subscriber_id
     WHERE s.email_normalised LIKE $1 AND e.template = 'verification_test'`,
    [`e1101-${runId}-%`],
  );
  const {
    rows: [queue],
  } = await database.query(
    "SELECT count(*)::int AS queued FROM email_send WHERE state = 'queued'",
  );
  assert.equal(
    subscribers.rows,
    expected,
    'subscriber count must equal accepted unique addresses',
  );
  assert.equal(
    subscribers.distinct_rows,
    expected,
    'normalised email must be unique',
  );
  assert.equal(
    emails.rows,
    expected,
    'one verification mail must exist per accepted unique address',
  );
  assert.equal(
    emails.distinct_keys,
    expected,
    'verification business keys must be unique',
  );
  assert.equal(emails.queued, 0, 'verification queue must drain');
  assert.equal(queue.queued, 0, 'the email queue must fully drain');
  assert.equal(emails.failed, 0, 'verification mail must not fail');
  assert.equal(
    emails.sent,
    expected,
    'fake sink must receive each verification mail',
  );
  return { subscribers, emails, queue };
}

async function seedSnapshot() {
  const id = randomUUID();
  await database.query(
    `INSERT INTO leaderboard_snapshot (id, as_of, entries)
     VALUES ($1, CURRENT_TIMESTAMP, '[{"rank":1,"display_handle":"loadtest0001","confirmed_referrals":7}]'::jsonb)`,
    [id],
  );
  await database.query(
    `INSERT INTO leaderboard_served_snapshot (singleton, snapshot_id)
     VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE
     SET snapshot_id = EXCLUDED.snapshot_id`,
    [id],
  );
  const deadline = monotonicMs() + 60_000;
  while (monotonicMs() < deadline) {
    try {
      const response = await globalThis.fetch(
        new URL('/api/leaderboard', baseUrl),
        { signal: globalThis.AbortSignal.timeout(10_000) },
      );
      const body = await response.json().catch(() => null);
      if (response.status === 200 && body?.snapshot_id === id) return id;
    } catch {
      // The cache starts asynchronously; retry only during this bounded warm-up.
    }
    await wait(500);
  }
  throw new Error('The leaderboard did not load its seeded snapshot');
}

async function queryCounts() {
  const { rows } = await database.query(
    'SELECT query, calls FROM pg_stat_statements',
  );
  const relevant = rows.filter(({ query }) =>
    /\b(subscriber|leaderboard_snapshot)\b/i.test(query),
  );
  return relevant.map(({ query, calls }) => ({
    query: query.replace(/\s+/g, ' ').slice(0, 180),
    calls: Number(calls),
  }));
}

const signup = newSummary();
const hostile = newSummary();
const leaderboard = newSummary();
const startedAt = new Date().toISOString();
const memoryStart = monotonicMs();
const memoryTimer = setInterval(() => {
  void sampleMemory().catch((error) => {
    process.stderr.write(`Memory sampling failed: ${error.message}\n`);
  });
}, profile.memorySampleSeconds * 1000);
let outcome;
try {
  await database.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  stage('snapshot seed');
  const snapshotId = await seedSnapshot();
  stage('snapshot seeded');
  stage('warmup');
  const warmup = await warmConnections();
  stage('seed export');
  await seedExport();
  await database.query('CHECKPOINT');
  await sampleMemory();
  const exportTask = (async () => {
    await wait(10_000);
    return streamExport();
  })().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const hostileTask = runPhase(
    profile.hostileRate,
    profile.hostileSeconds,
    (index) => postSignup(hostileIdentity(index, runId), hostile),
  );
  const sustained = await runPhase(
    profile.signupRate,
    profile.signupSeconds,
    (index) => postSignup(signupIdentity(index, runId), signup),
  );
  const sustainedP95Ms = p95(signup.latenciesMs);
  stage('sustained complete');
  const burst = await runPhase(
    profile.burstRate,
    profile.burstSeconds,
    (index) =>
      postSignup(signupIdentity(sustained.scheduled + index, runId), signup),
  );
  const burstP95Ms = p95(
    signup.latenciesMs.slice(sustained.scheduled),
  );
  stage('burst complete');
  const hostilePhase = await hostileTask;
  const exportResult = await exportTask;
  stage('export complete');
  if ('error' in exportResult) throw exportResult.error;
  const largeExport = exportResult.value;
  assert.equal(
    signup.statuses[429] ?? 0,
    0,
    'ordinary traffic must not be rate limited',
  );
  assert.equal(
    signup.statuses[200] ?? 0,
    sustained.scheduled + burst.scheduled,
  );
  assert.ok(
    (hostile.statuses[429] ?? 0) > 0,
    'hostile prefix must be rate limited',
  );
  assert.equal(
    hostile.invalidWait,
    0,
    'hostile 429s must carry an honest Retry-After',
  );
  const expectedRows =
    (sustained.scheduled + burst.scheduled) * 0.9 +
    Math.min(5, hostilePhase.scheduled);
  const { stdout: drained } = await exec('docker', [
    'exec',
    appContainer,
    'node',
    '/app/scripts/load/drain-email.ts',
  ]);
  stage('email drain complete');
  const signupDatabase = await verifySignup(expectedRows);
  stage('signup verified');
  await database.query('SELECT pg_stat_statements_reset()');
  const boardPhase = await runPhase(
    profile.leaderboardRate,
    profile.leaderboardSeconds,
    () => getLeaderboard(snapshotId, leaderboard),
  );
  stage('leaderboard complete');
  const boardQueries = await queryCounts();
  assert.equal(
    leaderboard.wrongSnapshot,
    0,
    'all leaderboard responses must use the cached snapshot',
  );
  assert.equal(leaderboard.statuses[200] ?? 0, boardPhase.scheduled);
  assert.equal(
    boardQueries.filter(({ query }) => /\bsubscriber\b/i.test(query)).length,
    0,
    'leaderboard load must not query subscriber',
  );
  const snapshotReads = boardQueries
    .filter(({ query }) => /\bleaderboard_snapshot\b/i.test(query))
    .reduce((total, entry) => total + Number(entry.calls), 0);
  assert.ok(
    snapshotReads <= 5,
    'leaderboard reads exceeded the bounded background cache refresh',
  );
  const fiveHundreds = [signup, hostile, leaderboard].reduce(
    (total, phase) =>
      total +
      Object.entries(phase.statuses).reduce(
        (count, [status, hits]) => count + (Number(status) >= 500 ? hits : 0),
        0,
      ),
    0,
  );
  assert.ok(fiveHundreds <= profile.maxFiveHundreds, '5xx tolerance exceeded');
  assert.equal(
    signup.transportErrors +
      hostile.transportErrors +
      leaderboard.transportErrors,
    0,
  );
  await sampleMemory();
  assert.ok(
    memory.some((sample) => sample.phase === 'export'),
    'container memory must be sampled during the large export',
  );
  for (const sample of memory) {
    assert.ok(
      sample.app.used < sample.app.limit,
      'app memory reached its limit',
    );
    assert.ok(
      sample.postgres.used < sample.postgres.limit,
      'PostgreSQL memory reached its limit',
    );
    assert.ok(
      sample.umami.used < sample.umami.limit,
      'Umami memory reached its limit',
    );
  }
  outcome = {
    status: 'passed',
    runId,
    startedAt,
    profile,
    warmup,
    sustained,
    burst,
    hostilePhase,
    boardPhase,
    signup: {
      count: signup.count,
      statuses: signup.statuses,
      p95Ms: p95(signup.latenciesMs),
      sustainedP95Ms,
      burstP95Ms,
    },
    hostile: {
      count: hostile.count,
      statuses: hostile.statuses,
      invalidWait: hostile.invalidWait,
    },
    leaderboard: {
      count: leaderboard.count,
      statuses: leaderboard.statuses,
      p95Ms: p95(leaderboard.latenciesMs),
    },
    largeExport,
    drained: JSON.parse(drained.trim()),
    signupDatabase,
    boardQueries,
    memory,
  };
} catch (error) {
  outcome = {
    status: 'failed',
    runId,
    startedAt,
    profile,
    error: error.message,
    signup: {
      count: signup.count,
      statuses: signup.statuses,
      p95Ms: p95(signup.latenciesMs),
    },
    hostile: {
      count: hostile.count,
      statuses: hostile.statuses,
      invalidWait: hostile.invalidWait,
    },
    leaderboard: {
      count: leaderboard.count,
      statuses: leaderboard.statuses,
      wrongSnapshot: leaderboard.wrongSnapshot,
    },
    memory,
  };
} finally {
  clearInterval(memoryTimer);
  httpAgent.destroy();
  await database.end();
}
if (resultPath)
  await writeFile(resultPath, `${JSON.stringify(outcome, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ ...outcome, memory: { samples: memory.length } })}\n`,
);
if (outcome.status !== 'passed') process.exitCode = 1;
