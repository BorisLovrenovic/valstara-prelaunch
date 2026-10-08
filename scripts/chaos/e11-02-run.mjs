import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { leaderboardRefreshIntervalMilliseconds } from '../../src/server/leaderboard/snapshot.ts';

const exec = promisify(execFile);
const project = `valstara-e1102-${process.pid}`;
const stateDir = await mkdtemp(join(tmpdir(), 'valstara-e1102-'));
const port = Number(process.env.CHAOS_APP_PORT ?? 54322);
const dbPort = Number(process.env.CHAOS_POSTGRES_PORT ?? 55435);
for (const [name, value] of [
  ['CHAOS_APP_PORT', port],
  ['CHAOS_POSTGRES_PORT', dbPort],
]) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
}
const emailTokenSecret = 'local-chaos-email-token-secret-32-chars';
const env = {
  ...process.env,
  ADMIN_CREDENTIAL: 'local-chaos-admin-credential-32-chars',
  ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  CADDY_ORIGIN_CERT_PATH: join(stateDir, 'origin.crt'),
  CADDY_ORIGIN_KEY_PATH: join(stateDir, 'origin.key'),
  EMAIL_BASE_URL: 'https://valstara.com',
  EMAIL_TOKEN_SECRET: emailTokenSecret,
  IP_PREFIX_PEPPER: 'local-chaos-ip-prefix-pepper',
  P1_ALERT_WEBHOOK_TOKEN: 'local-chaos-alert-token',
  P1_ALERT_WEBHOOK_URL: 'http://alerts.local.test/alerts',
  REFERRAL_SIGNING_SECRET: 'local-chaos-referral-secret',
  RESEND_API_KEY: 'local-chaos-resend-key',
  RESEND_DKIM_EXPECTED_VALUE: 'p=local-chaos-public-key',
  RESEND_KEY_MODE: 'test',
  RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
  RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
  RESEND_SENDING_DOMAIN: 'send.valstara.com',
  RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
  BREVO_WEBHOOK_TOKEN: 'local-chaos-brevo-webhook-token-32-chars',
  TURNSTILE_SECRET_KEY: 'local-chaos-turnstile-secret',
  UMAMI_APP_SECRET: 'local-chaos-umami-secret',
  UMAMI_DB_PASSWORD: 'local-chaos-umami-password',
  UMAMI_DB_USER: 'umami',
  VALSTARA_APP_DB_PASSWORD: 'local-chaos-app-password',
  VALSTARA_DB_PASSWORD: 'local-chaos-owner-password',
  VALSTARA_DB_USER: 'valstara',
  VALSTARA_IMAGE: 'valstara-chaos:e11-02',
  VALSTARA_RELEASE: 'e1102e1102e1102e1102e1102e1102e1102e1102e11',
  VALSTARA_CHAOS_SCRIPTS_DIR: resolve('scripts/chaos'),
  VALSTARA_CHAOS_SOURCE_DIR: resolve('src/server'),
  VALSTARA_CHAOS_STATE_DIR: stateDir,
  WEEKLY_SEND_UTC: '2@09:00',
};
const composeFiles = [
  '-f',
  'infra/compose/docker-compose.production.yml',
  '-f',
  'scripts/chaos/docker-compose.chaos.yml',
];
const startedAt = () => Number(process.hrtime.bigint()) / 1_000_000;
const timings = {};
let database;

async function command(program, args, options = {}) {
  const result = await exec(program, args, {
    env: { ...env, ...options.env },
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
  });
  return result.stdout.trim();
}
async function compose(...args) {
  return command('docker', [
    'compose',
    '-p',
    project,
    ...composeFiles,
    ...args,
  ]);
}
async function oneShot(action, extra = [], at = new Date()) {
  const value = await compose(
    'run',
    '--rm',
    '--no-deps',
    '-e',
    `CHAOS_CLOCK=${at.toISOString()}`,
    'app',
    'node',
    '/app/scripts/chaos/one-shot.mjs',
    action,
    ...extra,
  );
  return JSON.parse(value.split('\n').at(-1));
}
async function setMode(name, value) {
  await writeFile(join(stateDir, `${name}-mode`), value);
}
async function sql(text, values = []) {
  return (await database.query(text, values)).rows;
}
async function siteRequest(path, method = 'GET', body = '', headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: {
          Host: 'valstara.com',
          ...(method === 'POST' ? { Origin: 'http://valstara.com' } : {}),
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () =>
          resolveRequest(
            new globalThis.Response(Buffer.concat(chunks), {
              status: incoming.statusCode,
            }),
          ),
        );
        incoming.on('error', rejectRequest);
      },
    );
    request.on('error', rejectRequest);
    request.end(body);
  });
}
async function signup(email, token = 'healthy-token', prefix = '198.51.100.7') {
  const response = await siteRequest(
    '/api/signup',
    'POST',
    new globalThis.URLSearchParams({
      email,
      turnstile_token: token,
    }).toString(),
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': prefix,
    },
  );
  return { status: response.status, body: await response.json() };
}
async function page(path) {
  return siteRequest(path);
}
async function countEmail(email) {
  return Number(
    (
      await sql(
        'SELECT COUNT(*)::integer AS count FROM subscriber WHERE email_normalised=$1',
        [email],
      )
    )[0].count,
  );
}
async function time(label, run) {
  const began = startedAt();
  let detail;
  try {
    detail = await run();
  } catch (error) {
    process.stderr.write(
      `${label} app log:\n${await compose('logs', '--tail', '30', 'app').catch(() => '')}\n`,
    );
    throw error;
  }
  timings[label] = { elapsedMs: Math.round(startedAt() - began), ...detail };
  process.stderr.write(`${label}: ${JSON.stringify(timings[label])}\n`);
}
async function alerts() {
  return (await readFile(join(stateDir, 'alerts.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function connectDatabase() {
  await waitFor(async () => {
    const client = new pg.Client({
      connectionString: `postgresql://valstara:local-chaos-owner-password@127.0.0.1:${dbPort}/valstara_waitlist`,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      database = client;
      return true;
    } catch {
      await client.end().catch(() => {});
      return false;
    }
  }, 'host database port');
}

try {
  await chmod(stateDir, 0o777);
  await writeFile(env.CADDY_ORIGIN_CERT_PATH, 'local-only-unused-cert');
  await writeFile(env.CADDY_ORIGIN_KEY_PATH, 'local-only-unused-key');
  await writeFile(join(stateDir, 'alerts.jsonl'), '');
  await setMode('turnstile', 'healthy');
  await setMode('resend', 'healthy');
  await chmod(join(stateDir, 'alerts.jsonl'), 0o666);
  await compose(
    'up',
    '-d',
    '--wait',
    'postgres',
    'migrate',
    'umami',
    'app',
  ).catch(async (error) => {
    process.stderr.write(`${await compose('logs', 'app', 'migrate')}\n`);
    throw error;
  });
  await connectDatabase();

  await time('drill1_postgres_mid_signup', async () => {
    // Hold this request after its subscriber INSERT has run but before the
    // transaction can commit. The waiting advisory lock makes the failure
    // point observable instead of guessing from a wall-clock delay.
    await sql(`CREATE FUNCTION chaos_hold_subscriber_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.email_normalised = 'chaos-db@gmail.com' THEN
          PERFORM pg_advisory_xact_lock(1102, 1);
        END IF;
        RETURN NEW;
      END; $$`);
    await sql(`CREATE TRIGGER chaos_hold_subscriber_insert
      AFTER INSERT ON subscriber FOR EACH ROW
      EXECUTE FUNCTION chaos_hold_subscriber_insert()`);
    await sql('SELECT pg_advisory_lock(1102, 1)');
    const request = signup(
      'chaos-db@gmail.com',
      'healthy-token',
      '198.51.101.7',
    ).then(
      (outcome) => ({ outcome }),
      (error) => ({ error }),
    );
    await waitFor(async () => {
      const rows = await sql(`SELECT pid FROM pg_stat_activity
        WHERE usename = 'valstara_app'
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE '%INSERT INTO subscriber%'`);
      return rows.length > 0;
    }, 'signup subscriber INSERT blocked after row write');
    await compose('kill', '-s', 'SIGKILL', 'postgres');
    const completed = await request;
    if ('error' in completed) throw completed.error;
    const { outcome } = completed;
    assert.equal(outcome.status, 503, JSON.stringify(outcome));
    assert.equal(outcome.body.error.code, 'unavailable');
    await compose('up', '-d', '--wait', 'postgres');
    await database.end().catch(() => {});
    await connectDatabase();
    assert.equal(await countEmail('chaos-db@gmail.com'), 0);
    return { response: outcome.status, insertReached: true, partialRows: 0 };
  });

  await time('drill2_resend_revoked', async () => {
    const email = 'chaos-mail@gmail.com';
    const accepted = await signup(email, 'healthy-token', '198.51.102.7');
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    const before = (
      await sql(
        `SELECT e.id,e.state,e.attempts FROM email_send e JOIN subscriber s ON s.id=e.subscriber_id WHERE s.email_normalised=$1 AND e.template='verification_test'`,
        [email],
      )
    )[0];
    assert.equal(before.state, 'queued');
    await setMode('resend', 'revoked');
    const failed = await oneShot('dispatch');
    assert.ok(failed.retried > 0);
    const deferred = (
      await sql(
        'SELECT state,attempts,next_attempt_at FROM email_send WHERE id=$1',
        [before.id],
      )
    )[0];
    assert.equal(deferred.state, 'queued');
    assert.equal(deferred.attempts, 1);
    await setMode('resend', 'healthy');
    const recovered = await oneShot(
      'dispatch',
      [],
      new Date(deferred.next_attempt_at.getTime() + 1_000),
    );
    assert.ok(recovered.sent > 0);
    const after = (
      await sql('SELECT state,attempts FROM email_send WHERE id=$1', [
        before.id,
      ])
    )[0];
    assert.equal(after.state, 'sent');
    assert.equal(after.attempts, 2);
    return {
      committedRows: await countEmail(email),
      attempts: after.attempts,
      queuedAfterRecovery: 0,
    };
  });

  await time('drill3_turnstile', async () => {
    const invalid = await signup(
      'chaos-invalid@gmail.com',
      'invalid-token',
      '198.51.103.7',
    );
    const replay = await signup(
      'chaos-replay@gmail.com',
      'replayed-token',
      '198.51.104.7',
    );
    assert.equal(invalid.status, 400);
    assert.equal(replay.status, 400);
    assert.equal(await countEmail('chaos-invalid@gmail.com'), 0);
    assert.equal(await countEmail('chaos-replay@gmail.com'), 0);
    await setMode('turnstile', 'secret');
    const prefix = '198.51.105.7';
    for (let index = 0; index < 3; index += 1) {
      const result = await signup(
        `chaos-secret-${index}@gmail.com`,
        'healthy-token',
        prefix,
      );
      assert.equal(result.status, index < 2 ? 200 : 429);
    }
    const rows = await sql(
      `SELECT s.id, COUNT(f.id)::integer AS flags FROM subscriber s LEFT JOIN fraud_flag f ON f.subscriber_id=s.id AND f.kind='challenge_timeout' WHERE s.email_normalised LIKE 'chaos-secret-%@gmail.com' GROUP BY s.id`,
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.flags === 1));
    const p1 = (await alerts()).filter(
      (alert) =>
        alert.event === 'turnstile_unavailable' && alert.severity === 'P1',
    );
    assert.equal(p1.length, 1);
    assert.deepEqual(p1[0].detail, { reason: 'secret_configuration' });
    await setMode('turnstile', 'healthy');
    const healthy = await signup(
      'chaos-restored@gmail.com',
      'healthy-token',
      '198.51.106.7',
    );
    assert.equal(healthy.status, 200);
    const restoredFlags = await sql(
      `SELECT COUNT(f.id)::integer AS count FROM subscriber s LEFT JOIN fraud_flag f ON f.subscriber_id=s.id WHERE s.email_normalised='chaos-restored@gmail.com'`,
    );
    assert.equal(restoredFlags[0].count, 0);
    return {
      invalidRows: 0,
      replayRows: 0,
      strictAccepted: 2,
      strictLimited: 1,
      flagged: 2,
      p1Alerts: 1,
      restored: true,
    };
  });

  await time('drill4_snapshot_job_stopped', async () => {
    const worker = `${project}-snapshot-worker`;
    const at = new Date();
    await compose(
      'run',
      '-d',
      '--no-deps',
      '--name',
      worker,
      '-e',
      `CHAOS_CLOCK=${at.toISOString()}`,
      'app',
      'node',
      '/app/scripts/chaos/snapshot-worker.mjs',
    );
    try {
      await waitFor(
        async () =>
          (
            await sql(
              'SELECT id FROM leaderboard_snapshot ORDER BY as_of DESC LIMIT 1',
            )
          )[0],
        'snapshot',
      );
      const first = await waitFor(async () => {
        const response = await page('/api/leaderboard');
        return response.status === 200 ? response : null;
      }, 'site snapshot cache');
      const body = await first.json();
      await command('docker', ['kill', worker]);
      const stoppedAt = startedAt();
      await new Promise((resolve) =>
        globalThis.setTimeout(
          resolve,
          leaderboardRefreshIntervalMilliseconds + 1_000,
        ),
      );
      const stoppedForMs = Math.round(startedAt() - stoppedAt);
      assert.ok(stoppedForMs > leaderboardRefreshIntervalMilliseconds);
      assert.equal(
        await command('docker', [
          'inspect',
          '--format',
          '{{.State.Running}}',
          worker,
        ]),
        'false',
      );
      const latest = (
        await sql(
          'SELECT id, as_of FROM leaderboard_snapshot ORDER BY as_of DESC LIMIT 1',
        )
      )[0];
      assert.equal(latest.id, body.snapshot_id);
      assert.equal(latest.as_of.toISOString(), body.as_of);
      const second = await page('/api/leaderboard');
      assert.equal(second.status, 200);
      const stale = await second.json();
      assert.equal(stale.snapshot_id, body.snapshot_id);
      assert.equal(stale.as_of, body.as_of);
      return {
        snapshotId: body.snapshot_id,
        asOf: body.as_of,
        stoppedForMs,
        staleServed: true,
      };
    } finally {
      await command('docker', ['rm', '-f', worker]).catch(() => {});
    }
  });

  await time('drill5_counter_repair', async () => {
    const referrer = randomUUID();
    const referred = randomUUID();
    for (const id of [referrer, referred]) {
      await sql(
        `INSERT INTO subscriber(id,email,email_normalised,email_domain,status,verified_at) VALUES($1,$2,$2,'gmail.com','verified',$3)`,
        [id, `${id}@gmail.com`, new Date()],
      );
    }
    await sql(
      `INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state,confirmed_at) VALUES($1,$2,$3,'confirmed','settled',$4)`,
      [randomUUID(), referrer, referred, new Date()],
    );
    await sql('UPDATE subscriber SET confirmed_referrals=9 WHERE id=$1', [
      referrer,
    ]);
    const result = await oneShot('repair');
    assert.ok(result.corrected >= 1);
    const repaired = (
      await sql('SELECT confirmed_referrals FROM subscriber WHERE id=$1', [
        referrer,
      ])
    )[0];
    assert.equal(repaired.confirmed_referrals, 1);
    const audit = await sql(
      `SELECT detail FROM audit_log WHERE action='referral.counters_repaired' ORDER BY at DESC LIMIT 1`,
    );
    assert.ok(audit.length === 1);
    const p2 = (await alerts()).filter(
      (alert) =>
        alert.event === 'referral_counters_corrected' &&
        alert.severity === 'P2',
    );
    assert.equal(p2.length, 1);
    return {
      corrected: result.corrected,
      restoredCount: 1,
      p2Alerts: p2.length,
      auditRows: audit.length,
    };
  });

  await time('drill6_leaderboard_kill_switch', async () => {
    const before = await page('/leaderboard');
    assert.ok((await before.text()).includes('data-leaderboard-section'));
    const { changedAtMs } = await oneShot('flag', ['off']);
    await waitFor(async () => {
      const response = await page('/leaderboard');
      return !(await response.text()).includes('data-leaderboard-section');
    }, 'leaderboard removal');
    const removalMs = Math.round(startedAt() - changedAtMs);
    assert.ok(removalMs <= 5_000, `kill switch took ${removalMs} ms`);
    await oneShot('flag', ['on']);
    await waitFor(
      async () =>
        (await page('/leaderboard'))
          .text()
          .then((html) => html.includes('data-leaderboard-section')),
      'leaderboard restoration',
    );
    return { removalMs, restored: true, deploys: 0 };
  });

  await time('drill8_replays', async () => {
    const email = 'chaos-verify@gmail.com';
    assert.equal(
      (await signup(email, 'healthy-token', '198.51.107.7')).status,
      200,
    );
    const tokenRow = (
      await sql(
        `SELECT t.id FROM verification_token t JOIN subscriber s ON s.id=t.subscriber_id WHERE s.email_normalised=$1 AND t.purpose='verify' ORDER BY t.created_at DESC LIMIT 1`,
        [email],
      )
    )[0];
    assert.ok(tokenRow);
    const token = createHmac('sha256', emailTokenSecret)
      .update(tokenRow.id, 'utf8')
      .digest('base64url');
    async function verify() {
      return siteRequest(
        '/verify',
        'POST',
        new globalThis.URLSearchParams({ token }).toString(),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
      );
    }
    async function verificationEffects() {
      const rows = await sql(
        `SELECT s.status, s.verified_at, s.updated_at, s.access_window,
                s.referral_code, t.consumed_at,
                (SELECT COUNT(*)::integer FROM email_send e WHERE e.subscriber_id=s.id) AS email_sends,
                (SELECT COUNT(*)::integer FROM giveaway_entry g WHERE g.subscriber_id=s.id) AS giveaway_entries,
                (SELECT COUNT(*)::integer FROM referral_edge r WHERE r.referred_id=s.id) AS referral_edges,
                (SELECT COUNT(*)::integer FROM milestone_award m WHERE m.subscriber_id=s.id) AS milestone_awards,
                (SELECT COUNT(*)::integer FROM audit_log a WHERE a.subject_id=s.id::text) AS audit_rows
         FROM subscriber s JOIN verification_token t ON t.subscriber_id=s.id
         WHERE s.email_normalised=$1 AND t.id=$2`,
        [email, tokenRow.id],
      );
      assert.equal(rows.length, 1);
      return rows[0];
    }
    const first = await verify();
    assert.equal(first.status, 200);
    assert.ok((await first.text()).includes('verification-success'));
    const beforeReplay = await verificationEffects();
    assert.equal(beforeReplay.status, 'verified');
    assert.ok(beforeReplay.verified_at);
    assert.ok(beforeReplay.consumed_at);
    const second = await verify();
    assert.equal(second.status, 200);
    assert.ok((await second.text()).includes('verification-success'));
    assert.deepEqual(await verificationEffects(), beforeReplay);
    const turnstileReplay = await signup(
      'chaos-token-replay@gmail.com',
      'replayed-token',
      '198.51.108.7',
    );
    assert.equal(turnstileReplay.status, 400);
    assert.equal(await countEmail('chaos-token-replay@gmail.com'), 0);
    const webhookBody = JSON.stringify({
      event: 'hard_bounce',
      email,
      'message-id': 'chaos-webhook-message',
    });
    async function webhook() {
      return siteRequest('/api/webhooks/brevo', 'POST', webhookBody, {
        Authorization: `Bearer ${env.BREVO_WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      });
    }
    assert.equal((await webhook()).status, 200);
    assert.equal((await webhook()).status, 200);
    const events = await sql(
      'SELECT COUNT(*)::integer AS count FROM email_webhook_event',
    );
    const suppressions = await sql(
      'SELECT COUNT(*)::integer AS count FROM suppression WHERE email_normalised=$1',
      [email],
    );
    assert.equal(events[0].count, 1);
    assert.equal(suppressions[0].count, 1);
    return {
      verificationReplay: 'success',
      verificationEffectsUnchanged: true,
      turnstileReplay: 'rejected',
      webhookEvents: 1,
      suppressionRows: 1,
    };
  });

  const result = {
    ticket: 'E11-02',
    stack: 'isolated local production Compose with provider fault injection',
    image: env.VALSTARA_IMAGE,
    drills: timings,
    deferredToE1206: [7, 9, 10],
  };
  await writeFile(
    'docs/testing/e11-02-results.json',
    `${JSON.stringify(result, null, 2)}\n`,
  );
} finally {
  await database?.end().catch(() => {});
  await compose('down', '-v', '--remove-orphans').catch(() => {});
  for (const kind of ['container', 'volume', 'network']) {
    const names = await command('docker', [
      kind === 'container' ? 'ps' : `${kind} ls`,
      kind === 'container' ? '-aq' : '-q',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ]).catch(() => '');
    if (names)
      await command('docker', [
        kind === 'container' ? 'rm' : `${kind} rm`,
        ...(kind === 'container' ? ['-f'] : []),
        ...names.split('\n'),
      ]).catch(() => {});
  }
  await rm(stateDir, { recursive: true, force: true });
}
