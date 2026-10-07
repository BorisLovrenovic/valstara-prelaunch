import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  appEnvironmentKeys,
  ConfigurationError,
  getDatabaseUrl,
  getBrevoConfiguration,
  getGiveawayEntryPeriodStart,
  getIpVelocityConfiguration,
  getP1AlertConfiguration,
  getResendDispatchConfiguration,
  productionResendSendingDomain,
  getVerificationRateConfiguration,
  getReferralAttributionConfiguration,
  getWeeklySendConfiguration,
  getEmailQuotaConfiguration,
  getTrustpilotConfiguration,
  turnstileTestSiteKey,
  validateConfig,
} from '../src/server/config.ts';

const execFileAsync = promisify(execFile);

const validEnvironment: NodeJS.ProcessEnv = {
  ADMIN_CREDENTIAL: 'local-test-admin-credential-32-chars',
  ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  DATABASE_URL:
    'postgresql://valstara_app:local-password@127.0.0.1:5434/valstara_waitlist',
  EMAIL_BASE_URL: 'http://localhost:4321',
  EMAIL_TOKEN_SECRET: 'local-only-email-token-secret-32-chars',
  HOST: '127.0.0.1',
  IP_PREFIX_PEPPER: 'local-test-prefix-pepper',
  REFERRAL_SIGNING_SECRET: 'local-test-referral-signing-secret',
  NODE_ENV: 'test',
  PORT: '4321',
  RESEND_API_KEY: 'local-test-resend-key',
  RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
  BREVO_WEBHOOK_TOKEN: 'local-only-brevo-webhook-token-32-chars',
  RESEND_DKIM_EXPECTED_VALUE: 'p=local-test-public-key',
  RESEND_KEY_MODE: 'test',
  RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
  RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
  RESEND_SENDING_DOMAIN: 'send.valstara.com',
  TURNSTILE_SECRET_KEY: 'local-test-turnstile-secret',
};

function withVariable(
  key: string,
  value: string | undefined,
): NodeJS.ProcessEnv {
  const environment = { ...validEnvironment };
  if (value === undefined) {
    delete environment[key];
  } else {
    environment[key] = value;
  }
  return environment;
}

async function assertBootRejects(
  environment: NodeJS.ProcessEnv,
  key: string,
): Promise<void> {
  const bootEnvironment = { ...process.env, ...environment };
  delete bootEnvironment[key];
  await assert.rejects(
    execFileAsync(process.execPath, ['./src/server/config.ts'], {
      cwd: new URL('..', import.meta.url),
      env: bootEnvironment,
    }),
    (error) => {
      assert.ok(
        typeof error === 'object' &&
          error !== null &&
          'stderr' in error &&
          typeof error.stderr === 'string',
      );
      assert.match(error.stderr, new RegExp(`${key} is required`, 'u'));
      assert.doesNotMatch(error.stderr, /local-test/u);
      return true;
    },
  );
}

test('E1-12 validates and types the complete application environment', () => {
  assert.deepEqual(validateConfig(validEnvironment), {
    brevo: null,
    adminAuth: {
      credential: 'local-test-admin-credential-32-chars',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    },
    databaseUrl: validEnvironment.DATABASE_URL,
    emailBaseUrl: 'http://localhost:4321',
    emailTokenSecret: validEnvironment.EMAIL_TOKEN_SECRET,
    drand: null,
    giveawaySanctionedCountries: [],
    giveawaySubstitutionDays: 14,
    host: '127.0.0.1',
    ipPrefixPepper: 'local-test-prefix-pepper',
    ipVelocity: { threshold: 10, windowMinutes: 60 },
    referralSigningSecret: 'local-test-referral-signing-secret',
    nodeEnvironment: 'test',
    port: 4321,
    resendApiKey: 'local-test-resend-key',
    resendWebhookSecret: validEnvironment.RESEND_WEBHOOK_SECRET,
    brevoWebhookToken: validEnvironment.BREVO_WEBHOOK_TOKEN,
    resendWebhookGapMinutes: 120,
    resendDomainAuthentication: {
      dkimExpectedValue: 'p=local-test-public-key',
      rsendCnameExpectedTarget: 'rsend-euw1.forge.rmta.net',
      sendCnameExpectedTarget: 'send.forge.rmta.net',
    },
    resendKeyMode: 'test',
    resendSendingDomain: productionResendSendingDomain,
    resendTestRecipient: undefined,
    turnstileSecretKey: 'local-test-turnstile-secret',
    turnstileSiteKey: turnstileTestSiteKey,
    verificationRate: {
      baselineDays: 7,
      cohortHours: 24,
      collapsePercent: 50,
      minimumSignups: 50,
    },
    referralAttribution: {
      baselineDays: 7,
      cohortHours: 24,
      dropPercent: 50,
      minimumSignups: 50,
    },
    waitlistLiveAt: null,
    weeklySendUtc: null,
    emailQuota: {
      resend: { tier: 'free', cap: 100 },
      brevo: { tier: 'free', cap: 300 },
    },
    trustpilot: {
      minimumReviews: 50,
      reviewCount: 0,
      businessUnitId: '',
      templateId: '',
    },
  });
});

test('E10-05 validates configurable attribution windows and thresholds', () => {
  assert.deepEqual(getReferralAttributionConfiguration({}), {
    baselineDays: 7,
    cohortHours: 24,
    dropPercent: 50,
    minimumSignups: 50,
  });
  assert.deepEqual(
    getReferralAttributionConfiguration({
      REFERRAL_ATTRIBUTION_BASELINE_DAYS: '14',
      REFERRAL_ATTRIBUTION_COHORT_HOURS: '12',
      REFERRAL_ATTRIBUTION_DROP_PERCENT: '40',
      REFERRAL_ATTRIBUTION_MINIMUM_SIGNUPS: '100',
    }),
    {
      baselineDays: 14,
      cohortHours: 12,
      dropPercent: 40,
      minimumSignups: 100,
    },
  );
  for (const [key, value] of [
    ['REFERRAL_ATTRIBUTION_BASELINE_DAYS', '0'],
    ['REFERRAL_ATTRIBUTION_COHORT_HOURS', '-1'],
    ['REFERRAL_ATTRIBUTION_DROP_PERCENT', '101'],
    ['REFERRAL_ATTRIBUTION_MINIMUM_SIGNUPS', 'invalid'],
  ] as const) {
    assert.throws(
      () => getReferralAttributionConfiguration({ [key]: value }),
      (error) =>
        error instanceof ConfigurationError && error.variableName === key,
    );
  }
});

test('E9-08 validates all four Trustpilot settings at boot', () => {
  assert.deepEqual(getTrustpilotConfiguration({}), {
    minimumReviews: 50,
    reviewCount: 0,
    businessUnitId: '',
    templateId: '',
  });
  assert.deepEqual(
    validateConfig({
      ...validEnvironment,
      TRUSTPILOT_MIN_REVIEWS: '50',
      TRUSTPILOT_REVIEW_COUNT: '49',
      TRUSTPILOT_BUSINESS_UNIT_ID: 'business-unit',
      TRUSTPILOT_TEMPLATE_ID: 'template-id',
    }).trustpilot,
    {
      minimumReviews: 50,
      reviewCount: 49,
      businessUnitId: 'business-unit',
      templateId: 'template-id',
    },
  );
  for (const [key, value] of [
    ['TRUSTPILOT_MIN_REVIEWS', '0'],
    ['TRUSTPILOT_REVIEW_COUNT', '-1'],
    ['TRUSTPILOT_REVIEW_COUNT', '1.5'],
    ['TRUSTPILOT_BUSINESS_UNIT_ID', 'bad id'],
    ['TRUSTPILOT_TEMPLATE_ID', 'bad/id'],
  ] as const) {
    assert.throws(
      () => validateConfig({ ...validEnvironment, [key]: value }),
      (error) =>
        error instanceof ConfigurationError && error.variableName === key,
    );
  }
});

test('E8-09 quota tiers default free and reject paid with a free cap at boot', () => {
  assert.deepEqual(getEmailQuotaConfiguration({}), {
    resend: { tier: 'free', cap: 100 },
    brevo: { tier: 'free', cap: 300 },
  });
  for (const [tierKey, capKey, freeCap] of [
    ['RESEND_TIER', 'RESEND_DAILY_CAP', 100],
    ['BREVO_TIER', 'BREVO_DAILY_CAP', 300],
  ] as const) {
    assert.throws(
      () =>
        validateConfig({
          ...validEnvironment,
          [tierKey]: 'paid',
          [capKey]: String(freeCap),
        }),
      (error) =>
        error instanceof ConfigurationError && error.variableName === capKey,
    );
    assert.throws(
      () => validateConfig({ ...validEnvironment, [tierKey]: 'invalid' }),
      (error) =>
        error instanceof ConfigurationError && error.variableName === tierKey,
    );
  }
  assert.deepEqual(
    getEmailQuotaConfiguration({
      RESEND_TIER: 'paid',
      RESEND_DAILY_CAP: '250',
      BREVO_TIER: 'paid',
      BREVO_DAILY_CAP: '750',
    }),
    {
      resend: { tier: 'paid', cap: 250 },
      brevo: { tier: 'paid', cap: 750 },
    },
  );
});

test('E8-07 weekly schedule is explicit, UTC and validated', () => {
  assert.deepEqual(getWeeklySendConfiguration({ WEEKLY_SEND_UTC: '2@09:00' }), {
    isoWeekday: 2,
    hour: 9,
    minute: 0,
  });
  assert.throws(
    () => getWeeklySendConfiguration({ WEEKLY_SEND_UTC: '2@24:00' }),
    /WEEKLY_SEND_UTC/u,
  );
  assert.throws(() => getWeeklySendConfiguration({}), /WEEKLY_SEND_UTC/u);
});

test('maintenance validates Resend dispatch settings without unrelated app secrets', () => {
  const environment = {
    EMAIL_BASE_URL: 'https://valstara.com',
    EMAIL_TOKEN_SECRET: 'maintenance-email-secret-32-characters',
    NODE_ENV: 'production',
    RESEND_API_KEY: 'maintenance-resend-key',
    RESEND_DKIM_EXPECTED_VALUE: 'p=maintenance-public-key',
    RESEND_KEY_MODE: 'live',
    RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
    RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
    RESEND_SENDING_DOMAIN: 'send.valstara.com',
  };
  assert.deepEqual(getResendDispatchConfiguration(environment), {
    emailBaseUrl: 'https://valstara.com',
    emailTokenSecret: 'maintenance-email-secret-32-characters',
    resendApiKey: 'maintenance-resend-key',
    resendDomainAuthentication: {
      dkimExpectedValue: 'p=maintenance-public-key',
      rsendCnameExpectedTarget: 'rsend-euw1.forge.rmta.net',
      sendCnameExpectedTarget: 'send.forge.rmta.net',
    },
    resendKeyMode: 'live',
    resendSendingDomain: 'send.valstara.com',
    resendTestRecipient: undefined,
  });
  assert.throws(
    () =>
      getResendDispatchConfiguration({
        ...environment,
        RESEND_API_KEY: '',
      }),
    (error) =>
      error instanceof ConfigurationError &&
      error.variableName === 'RESEND_API_KEY',
  );
  assert.throws(
    () =>
      getResendDispatchConfiguration({
        ...environment,
        RESEND_TEST_RECIPIENT: '',
      }),
    (error) =>
      error instanceof ConfigurationError &&
      error.variableName === 'RESEND_TEST_RECIPIENT',
  );
});

test('Brevo configuration fails closed on partial or wrong-domain settings', () => {
  assert.equal(getBrevoConfiguration({}), null);
  assert.deepEqual(
    getBrevoConfiguration({
      BREVO_API_KEY: 'local-only-key',
      BREVO_LIST_ID: '42',
      BREVO_SENDING_DOMAIN: 'mail.valstara.com',
    }),
    {
      apiKey: 'local-only-key',
      listId: 42,
      sendingDomain: 'mail.valstara.com',
    },
  );
  for (const environment of [
    { BREVO_API_KEY: 'local-only-key' },
    {
      BREVO_API_KEY: 'local-only-key',
      BREVO_LIST_ID: '0',
      BREVO_SENDING_DOMAIN: 'mail.valstara.com',
    },
    {
      BREVO_API_KEY: 'local-only-key',
      BREVO_LIST_ID: '42',
      BREVO_SENDING_DOMAIN: 'send.valstara.com',
    },
  ]) {
    assert.throws(() => getBrevoConfiguration(environment), ConfigurationError);
  }
});

test('E8-02 rejects production sandbox configuration and live mode outside production', () => {
  const production = {
    ...validEnvironment,
    EMAIL_BASE_URL: 'https://valstara.com',
    NODE_ENV: 'production',
    RESEND_KEY_MODE: 'live',
  };
  for (const value of [undefined, 'test', 'unexpected']) {
    assert.throws(
      () => validateConfig({ ...production, RESEND_KEY_MODE: value }),
      (error) =>
        error instanceof ConfigurationError &&
        error.variableName === 'RESEND_KEY_MODE',
    );
  }
  for (const recipient of ['', 'delivered@example.test']) {
    assert.throws(
      () =>
        validateConfig({
          ...production,
          RESEND_TEST_RECIPIENT: recipient,
        }),
      (error) =>
        error instanceof ConfigurationError &&
        error.variableName === 'RESEND_TEST_RECIPIENT',
    );
  }
  for (const domain of ['resend.dev', 'mail.valstara.com']) {
    assert.throws(
      () => validateConfig({ ...production, RESEND_SENDING_DOMAIN: domain }),
      (error) =>
        error instanceof ConfigurationError &&
        error.variableName === 'RESEND_SENDING_DOMAIN',
    );
  }
  assert.throws(
    () => validateConfig({ ...validEnvironment, RESEND_KEY_MODE: 'live' }),
    (error) =>
      error instanceof ConfigurationError &&
      error.variableName === 'RESEND_KEY_MODE',
  );
});

test('E8-02 valid production Resend configuration boots', async () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...validEnvironment,
    EMAIL_BASE_URL: 'https://valstara.com',
    NODE_ENV: 'production',
    RESEND_KEY_MODE: 'live',
  };
  delete environment.RESEND_TEST_RECIPIENT;
  assert.equal(validateConfig(environment).resendKeyMode, 'live');
  await execFileAsync(process.execPath, ['./src/server/config.ts'], {
    cwd: new URL('..', import.meta.url),
    env: environment,
  });
});

test('E7-05 requires two distinct drand relay origins', () => {
  const configured = {
    ...validEnvironment,
    DRAND_CHAIN_HASH: 'ab'.repeat(32),
    DRAND_CHAIN_PUBLIC_KEY: 'cd'.repeat(48),
    DRAND_RELAY_URLS: 'https://relay-one.test,https://relay-two.test/',
  };
  assert.deepEqual(validateConfig(configured).drand, {
    chainHash: configured.DRAND_CHAIN_HASH,
    publicKey: configured.DRAND_CHAIN_PUBLIC_KEY,
    relays: ['https://relay-one.test', 'https://relay-two.test'],
  });
  assert.throws(
    () =>
      validateConfig({
        ...configured,
        DRAND_RELAY_URLS: 'https://relay-one.test,https://relay-one.test/',
      }),
    (error) =>
      error instanceof ConfigurationError &&
      error.variableName === 'DRAND_RELAY_URLS',
  );
});

test('E7-03 validates launch time and uses the later of launch and published start', () => {
  assert.equal(getGiveawayEntryPeriodStart({ NODE_ENV: 'production' }), null);
  assert.equal(
    getGiveawayEntryPeriodStart({ NODE_ENV: 'test' })?.toISOString(),
    '2026-10-01T00:00:00.000Z',
  );
  assert.equal(
    getGiveawayEntryPeriodStart({
      WAITLIST_LIVE_AT: '2026-09-30T12:00:00.000Z',
    })?.toISOString(),
    '2026-10-01T00:00:00.000Z',
  );
  assert.equal(
    getGiveawayEntryPeriodStart({
      WAITLIST_LIVE_AT: '2026-10-02T12:00:00.000Z',
    })?.toISOString(),
    '2026-10-02T12:00:00.000Z',
  );
  for (const value of [
    '2026-10-02T12:00:00Z',
    '2026-02-30T12:00:00.000Z',
    '2026-10-02T14:00:00.000+02:00',
  ]) {
    assert.throws(
      () => validateConfig(withVariable('WAITLIST_LIVE_AT', value)),
      (error) =>
        error instanceof ConfigurationError &&
        error.variableName === 'WAITLIST_LIVE_AT',
    );
  }
});

test('a database-only process validates only its required connection URL', () => {
  assert.equal(getDatabaseUrl(validEnvironment), validEnvironment.DATABASE_URL);
  assert.throws(
    () => getDatabaseUrl(withVariable('DATABASE_URL', undefined)),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.variableName, 'DATABASE_URL');
      return true;
    },
  );
});

test('E3-10 validates monitoring defaults and configuration overrides', () => {
  assert.deepEqual(getVerificationRateConfiguration(validEnvironment), {
    baselineDays: 7,
    cohortHours: 24,
    collapsePercent: 50,
    minimumSignups: 50,
  });
  assert.deepEqual(
    getVerificationRateConfiguration({
      ...validEnvironment,
      VERIFICATION_RATE_BASELINE_DAYS: '14',
      VERIFICATION_RATE_COHORT_HOURS: '12',
      VERIFICATION_RATE_COLLAPSE_PERCENT: '40',
      VERIFICATION_RATE_MINIMUM_SIGNUPS: '100',
    }),
    {
      baselineDays: 14,
      cohortHours: 12,
      collapsePercent: 40,
      minimumSignups: 100,
    },
  );
  assert.throws(
    () =>
      getVerificationRateConfiguration({
        ...validEnvironment,
        VERIFICATION_RATE_COLLAPSE_PERCENT: '0',
      }),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.variableName, 'VERIFICATION_RATE_COLLAPSE_PERCENT');
      return true;
    },
  );
});

test('E5-03 validates IP-velocity defaults and overrides', () => {
  assert.deepEqual(getIpVelocityConfiguration(validEnvironment), {
    threshold: 10,
    windowMinutes: 60,
  });
  assert.deepEqual(
    getIpVelocityConfiguration({
      ...validEnvironment,
      IP_VELOCITY_THRESHOLD: '12',
      IP_VELOCITY_WINDOW_MINUTES: '30',
    }),
    { threshold: 12, windowMinutes: 30 },
  );
  assert.throws(
    () =>
      getIpVelocityConfiguration({
        ...validEnvironment,
        IP_VELOCITY_THRESHOLD: '0',
      }),
    /IP_VELOCITY_THRESHOLD/u,
  );
});

test('the P1 alert transport requires authenticated HTTPS configuration in production', () => {
  assert.deepEqual(
    getP1AlertConfiguration({
      NODE_ENV: 'production',
      P1_ALERT_WEBHOOK_TOKEN: 'operator-alert-token',
      P1_ALERT_WEBHOOK_URL: 'https://alerts.example.test/valstara',
    }),
    {
      token: 'operator-alert-token',
      url: 'https://alerts.example.test/valstara',
    },
  );
  assert.throws(
    () =>
      getP1AlertConfiguration({
        NODE_ENV: 'production',
        P1_ALERT_WEBHOOK_TOKEN: 'operator-alert-token',
        P1_ALERT_WEBHOOK_URL: 'http://alerts.example.test/valstara',
      }),
    /P1_ALERT_WEBHOOK_URL/u,
  );
  assert.throws(
    () => getP1AlertConfiguration({ NODE_ENV: 'production' }),
    /P1_ALERT_WEBHOOK_URL/u,
  );
});

test('E3-05 defaults the public site key to the placeholder and honours an override', () => {
  // The public Turnstile site key is not a secret and never fails boot: absent,
  // it falls back to the temporary Cloudflare test key (swapped for the real one
  // in E12-05); present, the provided value wins.
  assert.equal(
    validateConfig(withVariable('TURNSTILE_SITE_KEY', undefined))
      .turnstileSiteKey,
    turnstileTestSiteKey,
  );
  assert.equal(
    validateConfig(withVariable('TURNSTILE_SITE_KEY', '0x4AAAAAAAreal'))
      .turnstileSiteKey,
    '0x4AAAAAAAreal',
  );
  assert.throws(
    () => validateConfig(withVariable('TURNSTILE_SITE_KEY', 'has space')),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.variableName, 'TURNSTILE_SITE_KEY');
      return true;
    },
  );
});

test('E1-12 applies only the documented Node adapter defaults', () => {
  const environment = { ...validEnvironment };
  delete environment.HOST;
  delete environment.NODE_ENV;
  delete environment.PORT;

  const config = validateConfig(environment);
  assert.equal(config.host, undefined);
  assert.equal(config.nodeEnvironment, 'development');
  assert.equal(config.port, undefined);
});

for (const key of [
  'ADMIN_CREDENTIAL',
  'ADMIN_TOTP_SECRET',
  'DATABASE_URL',
  'EMAIL_BASE_URL',
  'EMAIL_TOKEN_SECRET',
  'IP_PREFIX_PEPPER',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'BREVO_WEBHOOK_TOKEN',
  'RESEND_DKIM_EXPECTED_VALUE',
  'RESEND_RSEND_CNAME_EXPECTED_TARGET',
  'RESEND_SEND_CNAME_EXPECTED_TARGET',
  'RESEND_SENDING_DOMAIN',
  'TURNSTILE_SECRET_KEY',
] as const) {
  test(`E1-12 rejects a missing ${key} at boot with a named error`, async () => {
    assert.throws(
      () => validateConfig(withVariable(key, undefined)),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variableName, key);
        assert.match(error.message, new RegExp(key));
        assert.doesNotMatch(error.message, /local-test/u);
        return true;
      },
    );
    await assertBootRejects(withVariable(key, undefined), key);
  });
}

const malformedCases = [
  ['ADMIN_CREDENTIAL', 'too-short'],
  ['ADMIN_CREDENTIAL', 'credential with spaces is not accepted'],
  ['ADMIN_TOTP_SECRET', 'lowercase-is-not-base32'],
  ['ADMIN_TOTP_SECRET', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
  ['DATABASE_URL', 'not-a-url'],
  ['DATABASE_URL', 'https://example.test/database'],
  ['DATABASE_URL', 'postgresql://missing-credentials.example.test/database'],
  ['EMAIL_BASE_URL', 'not-a-url'],
  ['EMAIL_TOKEN_SECRET', 'too-short'],
  ['HOST', 'bad host'],
  ['IP_PREFIX_PEPPER', ' padded-secret'],
  ['NODE_ENV', 'staging'],
  ['PORT', '0'],
  ['PORT', 'not-a-port'],
  ['RESEND_API_KEY', 'key\nwith-control'],
  ['RESEND_WEBHOOK_SECRET', 'not-a-svix-secret'],
  ['BREVO_WEBHOOK_TOKEN', 'short'],
  ['TURNSTILE_SECRET_KEY', 'secret-with-padding '],
] as const;

for (const [key, value] of malformedCases) {
  test(`E1-12 rejects malformed ${key}`, () => {
    assert.throws(
      () => validateConfig(withVariable(key, value)),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variableName, key);
        assert.match(error.message, new RegExp(key));
        assert.doesNotMatch(error.message, new RegExp(value));
        return true;
      },
    );
  });
}

test('E1-12 local, CI, and production commands validate before starting Astro', async () => {
  const [localStart, ciCompose, dockerfile] = await Promise.all([
    readFile(new URL('../infra/compose/run-app.sh', import.meta.url), 'utf8'),
    readFile(
      new URL('../infra/compose/docker-compose.ci.yml', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  ]);

  assert.match(localStart, /node src\/server\/config\.ts\nexec npm run dev/u);
  assert.match(
    ciCompose,
    /node \.\/src\/server\/config\.ts && exec node \.\/dist\/server\/entry\.mjs/u,
  );
  assert.match(
    dockerfile,
    /node \.\/src\/server\/config\.ts && exec node \.\/dist\/server\/entry\.mjs/u,
  );
});

test('E1-12 documented app inventory exactly matches the validated schema', async () => {
  const inventory = await readFile(
    new URL('../infra/ENV.md', import.meta.url),
    'utf8',
  );
  const section = inventory.match(
    /## Application boot schema\n(?<body>[\s\S]*?)\n## /u,
  )?.groups?.body;
  assert.notEqual(
    section,
    undefined,
    'application boot schema section missing',
  );

  const documentedKeys = [
    ...(section ?? '').matchAll(/^\| `([A-Z_]+)`\s+\|/gmu),
  ]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined)
    .sort();

  assert.deepEqual(documentedKeys, [...appEnvironmentKeys].sort());
  for (const key of documentedKeys) {
    assert.match(section ?? '', new RegExp('^\\| `' + key + '`\\s+\\|', 'mu'));
  }
});

test('E1-12 complete inventory documents every repository environment variable', async () => {
  const projectRoot = new URL('..', import.meta.url);
  const inventory = await readFile(
    new URL('../infra/ENV.md', import.meta.url),
    'utf8',
  );
  const documentedKeys = new Set(
    [...inventory.matchAll(/^\| `([A-Z][A-Z0-9_]*)`\s+\|/gmu)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined),
  );
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const sourcePaths = stdout
    .split('\0')
    .filter(Boolean)
    .filter(
      (path) =>
        path !== 'infra/ENV.md' &&
        path !== 'test/config.test.ts' &&
        !path.startsWith('docs/') &&
        !path.startsWith('test/fixtures/'),
    );
  const usedKeys = new Set<string>(appEnvironmentKeys);

  for (const path of sourcePaths) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      'utf8',
    );
    addMatches(
      usedKeys,
      source,
      /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/gu,
    );

    if (/\.(?:sh|ya?ml)$/u.test(path) || path.endsWith('Caddyfile')) {
      addMatches(usedKeys, source, /\$\{([A-Z][A-Z0-9_]*)/gu);
      addMatches(usedKeys, source, /\$([A-Z][A-Z0-9_]*)/gu);
    }
    if (/\.ya?ml$/u.test(path)) {
      addMatches(usedKeys, source, /^\s+([A-Z][A-Z0-9_]*):/gmu);
    }
    if (path === 'Dockerfile') {
      addMatches(usedKeys, source, /(?:^ENV\s+|^\s+)([A-Z][A-Z0-9_]*)=/gmu);
    }
  }

  const undocumentedKeys = [...usedKeys]
    .filter((key) => !documentedKeys.has(key))
    .sort();
  assert.deepEqual(undocumentedKeys, []);
});

function addMatches(keys: Set<string>, source: string, pattern: RegExp): void {
  for (const match of source.matchAll(pattern)) {
    const key = match[1] ?? match[2];
    if (key !== undefined) {
      keys.add(key);
    }
  }
}
