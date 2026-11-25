// E11.7-15: the partner programme audit's shared parts. A migrated scratch
// database filled by the local seed (scripts/seed-partner-programme.ts), the
// repository's build served over it, and the list of states the audit reads:
// every new route and every changed surface, each in the states the seeded
// programme gives it. The rendered-page audit (test/e11-7-15-partner-browser
// .test.mjs), the privacy crawl (test/e11-05-page-inventory.test.mjs) and the
// contact sheet (scripts/design/partner-contact-sheet.mjs) all read it, so
// they audit the same states. Only exports; run on its own it does nothing.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';

import { ensureAppBuild } from '../../scripts/ci/app-build.mjs';
import { flagCacheTtlMilliseconds } from '../../src/server/flags/service.ts';
import { startAppServer } from './listen-port.mjs';

const executeFile = promisify(execFile);
export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const appPassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';
export const partnerAuditTokenSecret =
  'partner-audit-email-token-secret-32-chars';

/** The routes E11.7 added. Each must be covered by at least one state. */
export const partnerProgrammeRoutes = Object.freeze([
  '/partners',
  '/partners/apply',
  '/partners/dashboard',
  '/partners/dashboard/flyer',
  '/r/[code]',
]);
/** The existing pages E11.7 changed (the ladder, the perks, the policy). */
export const partnerChangedSurfaces = Object.freeze([
  '/',
  '/verify',
  '/me',
  '/privacy',
]);

// Turnstile's siteverify, stubbed inside the app process so the audit's
// form POSTs pass the challenge with no request leaving the machine, as
// test/partner-pages-rendered.test.mjs does. The app exits normally on
// SIGTERM so V8 records coverage for the routes it rendered.
const siteverifyStub = `data:text/javascript,${encodeURIComponent(`
  process.once('SIGTERM', () => process.exit(0));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      return (body.get('response') ?? '') === ''
        ? Response.json({ success: false, 'error-codes': ['missing-input-response'] })
        : Response.json({ success: true });
    }
    return realFetch(input, init);
  };
`)}`;

/**
 * Runs the seed command against `databaseUrl` (the app role) and returns its
 * manifest of links.
 */
export async function runPartnerSeed(databaseUrl, tokenSecret, baseUrl) {
  const directory = await mkdtemp(join(tmpdir(), 'partner-audit-'));
  try {
    const manifest = join(directory, 'manifest.json');
    await executeFile(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/seed-partner-programme.ts',
        `--json=${manifest}`,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          EMAIL_TOKEN_SECRET: tokenSecret,
          EMAIL_BASE_URL: baseUrl,
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return JSON.parse(await readFile(manifest, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A migrated scratch database holding the seeded programme, and the
 * repository's build served over it. `host` is `0.0.0.0` when a browser
 * container must reach the server.
 */
export async function startPartnerAuditServer({
  label = 'Partner audit',
  host = '127.0.0.1',
} = {}) {
  await ensureAppBuild();
  const name = `valstara_partner_audit_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const appUrl = new URL(url);
  appUrl.username = 'valstara_app';
  appUrl.password = appPassword;
  let server;
  let owner;
  let manifest;
  const dispose = async () => {
    await server?.stop();
    await owner?.end();
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  };
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await executeFile(
      'npx',
      ['tsx', 'src/server/db/run-migrations.ts', 'partner-audit'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: url.toString(),
          VALSTARA_APP_DB_PASSWORD: appPassword,
        },
      },
    );
    manifest = await runPartnerSeed(
      appUrl.toString(),
      partnerAuditTokenSecret,
      'http://localhost:4321',
    );
    owner = new Pool({ connectionString: url.toString() });
    server = await startAppServer({
      label,
      readyPath: '/robots.txt',
      nodeArguments: ['--import', siteverifyStub],
      env: (port) => ({
        ADMIN_CREDENTIAL: 'partner-audit-admin-credential-32-chars',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL: appUrl.toString(),
        EMAIL_BASE_URL: `http://127.0.0.1:${port}`,
        EMAIL_TOKEN_SECRET: partnerAuditTokenSecret,
        IP_PREFIX_PEPPER: 'partner-audit-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'partner-audit-referral-secret',
        RESEND_API_KEY: 'partner-audit-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        HOST: host,
      }),
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  const local = `http://127.0.0.1:${server.port}`;
  const documents = new Map();
  return {
    port: server.port,
    local,
    manifest,
    /** The app role's URL, as the app uses it. */
    databaseUrl: appUrl.toString(),
    /** Sets campaign flags and lets the server's flag cache expire. */
    async setFlags(flags) {
      for (const [key, enabled] of Object.entries(flags))
        await owner.query(
          "INSERT INTO campaign_flag (key, enabled, updated_by) VALUES ($1, $2, 'e11-7-15-audit') ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled",
          [key, enabled],
        );
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, flagCacheTtlMilliseconds + 250),
      );
    },
    /**
     * The page a POST state's form answers with, posted once per server and
     * then reused: a second application POST from the same address would
     * meet the route's own rate limit and render a different state.
     */
    document(state) {
      if (!documents.has(state.state))
        documents.set(state.state, postDocument(state));
      return documents.get(state.state);
    },
    dispose,
  };
  async function postDocument(state) {
    const fields =
      typeof state.post.fields === 'function'
        ? await state.post.fields(local)
        : state.post.fields;
    const response = await globalThis.fetch(`${local}${state.post.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: local,
      },
      body: new globalThis.URLSearchParams(fields),
    });
    return { status: response.status, html: await response.text() };
  }
}

// The route runs the live MX screen, so the address is on a domain that
// has mail exchangers, as test/partner-pages-rendered.test.mjs's is. Nothing
// is ever sent to it.
const application = (code) => [
  ['full_name', 'Sample Applicant'],
  ['email_address', 'e11715.audit.applicant@gmail.com'],
  ['country_of_residence', 'SE'],
  ['partner_type', 'creator'],
  ['channels', 'tiktok'],
  ['channels', 'youtube'],
  ['handles', '@sampleapplicant'],
  ['audience_size', '10k_50k'],
  ['promotion_plan', 'Short videos with the link pinned.'],
  ['requested_code', code],
  ['age_confirmed', 'yes'],
  ['programme_terms_agreed', 'yes'],
  ['turnstile_token', 'audit-token'],
];

async function settingsFields(local, dashboardPath) {
  const html = await (
    await globalThis.fetch(`${local}${dashboardPath}`)
  ).text();
  const token = /name="settings_token" value="([^"]+)"/u.exec(html)?.[1];
  if (token === undefined)
    throw new Error('The dashboard served no settings token.');
  return [
    ['settings_token', token.replaceAll('&amp;', '&')],
    ['display_name', 'Maya Studio'],
    ['show_on_leaderboard', 'yes'],
    ['nonessential_email_enabled', 'yes'],
  ];
}

/**
 * Every state the audit reads, from the seed's manifest. `covers` is the
 * route it audits; `post` makes the state the page a form POST answers
 * with; `flags` is the flag phase it belongs to (flag-on states first);
 * `status` is its status when not 2xx; `protectedForms` is how many
 * Turnstile-protected forms it renders; `partnerKit: false` marks a
 * dashboard that shows no asset kit (a paused partner's).
 */
export function partnerAuditStates(manifest) {
  const partner = (key) => {
    const found = manifest.partners.find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`No seeded partner ${key}.`);
    return found;
  };
  const states = [
    { state: 'partners', path: '/partners', covers: '/partners' },
    {
      state: 'partners-apply',
      path: '/partners/apply',
      covers: '/partners/apply',
      protectedForms: 1,
    },
    {
      state: 'partners-apply-invite-prefill',
      path: '/partners/apply?email=invited%40partner-seed.example.test',
      covers: '/partners/apply',
      protectedForms: 1,
    },
    {
      // The refused form renders back, Turnstile and all.
      state: 'partners-apply-refused-code',
      path: '/partners/apply',
      covers: '/partners/apply',
      post: { path: '/partners/apply', fields: application('NETFLIXDEALS') },
      protectedForms: 1,
    },
    {
      state: 'partners-apply-accepted',
      path: '/partners/apply',
      covers: '/partners/apply',
      post: { path: '/partners/apply', fields: application('SAMPLEAPPLY') },
    },
    {
      state: 'partners-apply-confirm-link',
      path: '/partners/apply?token=emailed-link',
      covers: '/partners/apply',
    },
    {
      state: 'partners-apply-confirm-invalid',
      path: '/partners/apply',
      covers: '/partners/apply',
      post: { path: '/partners/apply', fields: [['token', 'not-a-link']] },
    },
    {
      state: 'partners-dashboard-recovery',
      path: '/partners/apply?operation=dashboard-recovery',
      covers: '/partners/apply',
      protectedForms: 1,
    },
    {
      state: 'partners-dashboard-recovery-sent',
      path: '/partners/apply?operation=dashboard-recovery',
      covers: '/partners/apply',
      post: {
        path: '/partners/apply?operation=dashboard-recovery',
        fields: [
          ['email_address', 'unknown@partner-seed.example.test'],
          ['turnstile_token', 'audit-token'],
        ],
      },
    },
  ];
  for (const key of [
    'active-creator',
    'active-ambassador',
    'active-standard',
    'paused-creator',
    'terminated-standard',
  ])
    states.push({
      state: `partners-dashboard-${key}`,
      path: partner(key).dashboardPath,
      covers: '/partners/dashboard',
      // The asset kit shows only while the partner's link credits signups.
      ...(key === 'paused-creator' ? { partnerKit: false } : {}),
    });
  states.push(
    {
      state: 'partners-dashboard-invalid',
      path: '/partners/dashboard?t=invalid',
      covers: '/partners/dashboard',
    },
    {
      state: 'partners-dashboard-settings-saved',
      path: '/partners/dashboard',
      covers: '/partners/dashboard',
      post: {
        path: '/partners/dashboard',
        fields: (local) =>
          settingsFields(local, partner('active-creator').dashboardPath),
      },
    },
  );
  for (const key of ['active-creator', 'active-ambassador'])
    states.push({
      state: `partners-flyer-${key}`,
      path: partner(key).flyerPath,
      covers: '/partners/dashboard/flyer',
    });
  states.push(
    {
      state: 'partners-flyer-invalid',
      path: '/partners/dashboard/flyer?t=invalid',
      covers: '/partners/dashboard/flyer',
    },
    {
      // `/r/{CODE}` answers 302 to the landing page with the code captured.
      state: 'r-code-active-creator',
      path: partner('active-creator').shortLinkPath,
      covers: '/r/[code]',
      redirectsTo: `/?ref=${partner('active-creator').code}`,
      protectedForms: 1,
    },
    {
      state: 'r-code-paused-creator',
      path: partner('paused-creator').shortLinkPath,
      covers: '/r/[code]',
      redirectsTo: '/',
      protectedForms: 1,
    },
    { state: 'landing', path: '/', covers: '/', protectedForms: 1 },
  );
  for (const entry of manifest.verifyReplays)
    states.push({
      state: `verify-success-${entry.key}`,
      path: '/verify',
      covers: '/verify',
      post: {
        path: '/verify',
        fields: [
          ['token', new URL(entry.path, 'http://x').searchParams.get('token')],
        ],
      },
    });
  for (const entry of [...manifest.members, ...manifest.friends])
    states.push({
      state: `me-${entry.key}`,
      path: entry.path,
      covers: '/me',
      protectedForms: 2,
    });
  states.push({ state: 'privacy', path: '/privacy', covers: '/privacy' });
  // `partners.enabled` off: the programme's paused states.
  const off = { 'partners.enabled': false };
  states.push(
    {
      state: 'partners-apply-paused',
      path: '/partners/apply',
      covers: '/partners/apply',
      flags: off,
    },
    {
      // The programme's paused card answers 503, as `prices.pages` does.
      state: 'partners-dashboard-paused',
      path: partner('active-creator').dashboardPath,
      covers: '/partners/dashboard',
      flags: off,
      status: 503,
    },
    {
      state: 'r-code-programme-paused',
      path: partner('active-creator').shortLinkPath,
      covers: '/r/[code]',
      redirectsTo: '/',
      flags: off,
      protectedForms: 1,
    },
  );
  return states;
}

/** Splits states into flag phases, flag-on first, keeping their order. */
export function flagPhases(states) {
  const phases = new Map();
  for (const state of states) {
    const key = JSON.stringify(state.flags ?? {});
    phases.set(key, [...(phases.get(key) ?? []), state]);
  }
  return [...phases.entries()].map(([key, list]) => ({
    flags: JSON.parse(key),
    states: list,
  }));
}
