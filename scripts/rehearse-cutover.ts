import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createAuditService } from '../src/server/audit/service.ts';
import { runMigrations } from '../src/server/db/migration.ts';
import { createPool } from '../src/server/db/pool.ts';
import { createFlagService } from '../src/server/flags/service.ts';
import { createFinalReminderJob } from '../src/server/subscriber/final-reminder.ts';
import { recordHandoffFreeze } from '../src/server/subscriber/handoff-freeze.ts';
import { createVerificationCompletionService } from '../src/server/verification/complete.ts';
import { deriveEmailToken } from '../src/server/verification/token-derivation.ts';

const execFile = promisify(execFileCallback);
const HOUR_MS = 60 * 60 * 1_000;
const clockStart = new Date('2027-03-15T10:00:00.000Z');
const actor = 'e11-07-rehearsal-operator';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
const tokenSecret =
  process.env.EMAIL_TOKEN_SECRET ?? 'local-only-email-token-secret-32-chars';
process.env.EMAIL_TOKEN_SECRET = tokenSecret;
process.env.EMAIL_BASE_URL ??= 'http://localhost:4321';

function argument(name: string): string {
  const value = process.argv
    .slice(2)
    .find((part) => part.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
  if (!value) throw new Error(`Missing --${name}= argument.`);
  return value;
}

const evidencePath = argument('evidence');
const verificationWindowHours = Number(argument('verification-window-hours'));
if (
  !Number.isInteger(verificationWindowHours) ||
  verificationWindowHours < 1 ||
  verificationWindowHours >= 7 * 24
)
  throw new Error(
    'The verification window must be an integer from 1 to 167 hours.',
  );

const adminUrl = new URL(
  process.env.TEST_DATABASE_URL ??
    'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
);
const databaseName = `valstara_e1107_${randomUUID().replaceAll('-', '')}`;
const sourceUrl = new URL(adminUrl);
sourceUrl.pathname = `/${databaseName}`;
const applicationUrl = new URL(sourceUrl);
applicationUrl.username = 'valstara_app';
applicationUrl.password = applicationRolePassword;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'valstara-e1107-'));
const exportPath = join(temporaryDirectory, 'handoff.ndjson');
const importEvidencePath = join(temporaryDirectory, 'import-evidence.json');
const admin = createPool(adminUrl.toString());
let owner: ReturnType<typeof createPool> | undefined;
let application: ReturnType<typeof createPool> | undefined;
const steps: {
  step: number;
  name: string;
  elapsedMs: number;
  result: unknown;
}[] = [];
let databaseCreated = false;

async function timeStep<T>(
  step: number,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = process.hrtime.bigint();
  const result = await run();
  steps.push({
    step,
    name,
    elapsedMs:
      Math.round(Number(process.hrtime.bigint() - started) / 10_000) / 100,
    result,
  });
  return result;
}

try {
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  databaseCreated = true;
  owner = createPool(sourceUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'e11-07-cutover-rehearsal',
  });
  application = createPool(applicationUrl.toString());

  const verifiedId = randomUUID();
  const pendingId = randomUUID();
  await owner.execute({
    text: `INSERT INTO subscriber
      (id,email,email_normalised,email_domain,status,access_window,verified_at)
      VALUES ($1,'verified@example.test','verified@example.test','example.test','verified','wave-1',$3),
             ($2,'pending@example.test','pending@example.test','example.test','pending',NULL,NULL)`,
    values: [verifiedId, pendingId, clockStart],
  });
  const awardId = randomUUID();
  await owner.execute({
    text: `INSERT INTO milestone_award(id,subscriber_id,tier,reward_kind,state)
      VALUES ($1,$2,1,'discount','held')`,
    values: [awardId, verifiedId],
  });

  await timeStep(1, 'Close signups and audit', async () => {
    await createFlagService(application!).set('signup.enabled', false, actor);
    assert.equal(
      await createFlagService(application!).isEnabled('signup.enabled'),
      false,
    );
    return { flag: 'signup.enabled', enabled: false };
  });

  await timeStep(2, 'Queue final reminder and verify idempotency', async () => {
    const job = createFinalReminderJob(application!, () => clockStart);
    const first = await job.run(null);
    assert.equal(first.queued, 1);
    await createAuditService(application!).record({
      action: 'handoff.final_reminders_queued',
      actor,
      subjectType: 'handoff',
      subjectId: null,
      detail: { scanned: first.scanned, queued: first.queued },
    });
    const { stdout } = await execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/send-final-reminder.ts', `--actor=${actor}`],
      {
        env: { ...process.env, DATABASE_URL: applicationUrl.toString() },
        maxBuffer: 1024 * 1024,
      },
    );
    const repeated = JSON.parse(stdout) as { queued: number };
    assert.equal(repeated.queued, 0);
    return { queued: first.queued, replayQueued: repeated.queued };
  });

  await timeStep(3, 'Verify within the configured window', async () => {
    const row = await owner!.readOne<{ token_id: string; expires_at: Date }>({
      text: `SELECT t.id AS token_id,t.expires_at FROM verification_token t
        JOIN email_send e ON e.payload->>'token_id'=t.id::text
        WHERE e.business_key=$1`,
      values: [`verify-reminder-final:${pendingId}`],
    });
    assert.ok(row);
    assert.equal(
      row.expires_at.getTime() - clockStart.getTime(),
      7 * 24 * HOUR_MS,
    );
    const token = deriveEmailToken(row.token_id, tokenSecret);
    const at = new Date(
      clockStart.getTime() + verificationWindowHours * HOUR_MS,
    );
    const completion = await createVerificationCompletionService(application!, {
      clock: () => at,
      referralEnabled: false,
    })(token);
    assert.equal(completion.outcome, 'verified');
    return {
      configuredHours: verificationWindowHours,
      tokenLifetimeHours: 168,
      actualWaitMs: 0,
      verifiedAtWindowEnd: true,
    };
  });

  await owner.execute({
    text: `INSERT INTO referral_edge(id,referrer_id,referred_id,state,reward_state)
      VALUES ($1,$2,$3,'confirmed','settled')`,
    values: [randomUUID(), verifiedId, pendingId],
  });
  const unsubscribeId = randomUUID();
  const unsubscribeHash = createHash('sha256')
    .update('local-rehearsal-token')
    .digest();
  await owner.execute({
    text: `INSERT INTO verification_token
      (id,subscriber_id,token_hash,purpose,expires_at)
      VALUES ($1,$2,$3,'unsubscribe',$4)`,
    values: [
      unsubscribeId,
      verifiedId,
      unsubscribeHash,
      new Date(clockStart.getTime() + 90 * 24 * HOUR_MS),
    ],
  });
  await owner.execute({
    text: `INSERT INTO email_send
      (id,subscriber_id,template,provider,business_key,state,unsubscribe_token_id)
      VALUES ($1,$2,'weekly_campaign','brevo',$3,'sent',$4)`,
    values: [randomUUID(), verifiedId, `weekly:${verifiedId}`, unsubscribeId],
  });

  // A synthetic published draw satisfies the export preflight. The draw service's
  // reproducibility is covered by E7-05; this fixture tests the cutover boundary.
  const drawId = randomUUID();
  const snapshotAt = new Date(clockStart.getTime() - HOUR_MS);
  const targetAt = new Date(snapshotAt.getTime() + 10 * 60_000);
  const seededAt = new Date(snapshotAt.getTime() + 20 * 60_000);
  await owner.execute({
    text: `INSERT INTO giveaway_draw(id,executed_by) VALUES ($1,$2)`,
    values: [drawId, actor],
  });
  await owner.execute({
    text: `UPDATE giveaway_draw SET snapshot_committed_at=$2,
      entry_snapshot_hash=$3,prize_count=1,rules_version='VAL-GW-LAUNCH-20261009-r1',
      rules_sha256=$3,drand_chain_hash=$3,drand_chain_info='{}'::jsonb,
      target_round=1,target_round_at=$4 WHERE id=$1`,
    values: [drawId, snapshotAt, Buffer.alloc(32), targetAt],
  });
  await owner.execute({
    text: `UPDATE giveaway_draw SET state='published',seed=$2,
      seed_generated_at=$3,beacon_round=1,beacon_randomness=$4,
      beacon_signature=$4,beacon_relay_used='local-fixture',
      beacon_verified_relays='["local-a","local-b"]'::jsonb,
      winners='["local-fixture"]'::jsonb,
      executed_at=$3,reproduced_at=$3,published_at=$3 WHERE id=$1`,
    values: [drawId, '0'.repeat(64), seededAt, Buffer.alloc(32)],
  });

  await timeStep(4, 'Record operational full freeze', async () => {
    await recordHandoffFreeze(application!, actor, 'local_rehearsal');
    return {
      publicWriteBlock: 'local route fixture',
      maintenance: 'not running',
    };
  });

  await timeStep(5, 'pgBackRest differential snapshot', async () => {
    await execFile(
      'docker',
      [
        'compose',
        '-f',
        'infra/compose/docker-compose.yml',
        'exec',
        '-T',
        '-u',
        'postgres',
        'postgres',
        'pgbackrest',
        '--stanza=valstara',
        'backup',
        '--type=diff',
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const { stdout } = await execFile(
      'docker',
      [
        'compose',
        '-f',
        'infra/compose/docker-compose.yml',
        'exec',
        '-T',
        '-u',
        'postgres',
        'postgres',
        'pgbackrest',
        '--stanza=valstara',
        'info',
        '--output=json',
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const info = JSON.parse(stdout) as Array<{
      backup: Array<{ label: string; type: string }>;
    }>;
    const latest = info[0]?.backup.at(-1);
    assert.equal(latest?.type, 'diff');
    return {
      kind: 'pgBackRest differential',
      label: latest.label,
      includesDisposableSource: true,
    };
  });

  const exported = await timeStep(6, 'Export frozen handoff', async () => {
    const { stdout } = await execFile(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/export-handoff.ts',
        `--output=${exportPath}`,
        `--actor=${actor}`,
        '--store-launch-at=2027-03-18T10:00:00.000Z',
      ],
      {
        env: { ...process.env, DATABASE_URL: applicationUrl.toString() },
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(stdout) as Record<string, number>;
  });
  assert.equal(exported.customers, 2);
  assert.equal(exported.heldDiscounts, 1);
  assert.equal(exported.confirmedReferrals, 1);
  assert.ok(exported.unsubscribeTokens >= 1);

  const imported = await timeStep(
    7,
    'Import twice into two scratch databases',
    async () => {
      await execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/import-rehearsal.ts',
          `--input=${exportPath}`,
          `--evidence=${importEvidencePath}`,
        ],
        {
          env: {
            ...process.env,
            HANDOFF_REHEARSAL_ADMIN_URL: adminUrl.toString(),
          },
          maxBuffer: 1024 * 1024,
        },
      );
      return JSON.parse(await readFile(importEvidencePath, 'utf8')) as {
        rehearsals: Array<{
          firstImport: Record<string, number>;
          secondImport: Record<string, number>;
          finalCounts: Record<string, number>;
        }>;
      };
    },
  );
  for (const rehearsal of imported.rehearsals) {
    assert.equal(rehearsal.firstImport.createdCustomers, 2);
    assert.ok(
      Object.values(rehearsal.secondImport).every((count) => count === 0),
    );
  }

  await timeStep(8, 'Verify customer groups', async () => {
    assert.ok(imported.rehearsals.every((r) => r.finalCounts.groups >= 2));
    return {
      scratchDatabases: imported.rehearsals.length,
      groups: imported.rehearsals[0]?.finalCounts.groups,
    };
  });
  await timeStep(9, 'Verify confirmed referral import', async () => {
    assert.ok(imported.rehearsals.every((r) => r.finalCounts.referrals === 1));
    return { referrals: 1 };
  });
  await timeStep(10, 'Verify held discount and token import', async () => {
    assert.ok(
      imported.rehearsals.every(
        (r) =>
          r.finalCounts.discounts === 1 &&
          r.finalCounts.tokens === exported.unsubscribeTokens,
      ),
    );
    return { heldDiscounts: 1, unsubscribeTokens: exported.unsubscribeTokens };
  });
  await timeStep(11, 'Run local route cutover fixture', async () => {
    await execFile(
      process.execPath,
      ['--import', 'tsx', '--test', 'test/e11-07-cutover-check.test.ts'],
      { maxBuffer: 1024 * 1024 },
    );
    return { localProbe: 'passed', dnsChanged: false };
  });

  await timeStep(12, 'Restrict routine database writes', async () => {
    await application!.close();
    application = undefined;
    await admin.execute({
      text: `ALTER ROLE valstara_app IN DATABASE "${databaseName}"
        SET default_transaction_read_only = on`,
    });
    const readOnlyApplication = createPool(applicationUrl.toString());
    try {
      await assert.rejects(
        readOnlyApplication.execute({
          text: `INSERT INTO campaign_flag(key,enabled,updated_by)
            VALUES ('signup.enabled',false,$1)
            ON CONFLICT (key) DO UPDATE SET enabled=excluded.enabled`,
          values: [actor],
        }),
        /read-only transaction/u,
      );
      await owner!.execute({
        text: `INSERT INTO audit_log(id,actor,action,subject_type,detail)
          VALUES ($1,$2,'handoff.frozen','handoff','{}'::jsonb)`,
        values: [randomUUID(), actor],
      });
    } finally {
      await readOnlyApplication.close();
    }
    return { routineWriteDenied: true, operatorExceptionAvailable: true };
  });

  const measuredMs = steps.reduce((sum, step) => sum + step.elapsedMs, 0);
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        ticket: 'E11-07',
        mode: 'local disposable database and route fixture',
        verificationWindowHours,
        measuredMs: Math.round(measuredMs * 100) / 100,
        projectedLocalTimelineMs: Math.round(
          measuredMs + verificationWindowHours * HOUR_MS,
        ),
        steps,
        limitations: [
          'No real email was dispatched; the transactional queue and token were exercised.',
          'The proxy block was represented by the local route fixture; no production proxy was changed.',
          'The Medusa customer workflow was represented by the E11-06 scratch import.',
          'A synthetic published draw exercised the export precondition; the draw itself was not replayed.',
          'No DNS change was executed.',
        ],
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(`Cutover rehearsal passed; evidence: ${evidencePath}\n`);
} finally {
  await application?.close();
  await owner?.close();
  if (databaseCreated) {
    await admin.list(
      {
        text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
        values: [databaseName],
      },
      10,
    );
    await admin.execute({ text: `DROP DATABASE "${databaseName}"` });
  }
  await admin.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
