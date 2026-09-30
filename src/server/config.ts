import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const requiredKeys = [
  'ADMIN_CREDENTIAL',
  'ADMIN_TOTP_SECRET',
  'DATABASE_URL',
  'EMAIL_BASE_URL',
  'EMAIL_TOKEN_SECRET',
  'IP_PREFIX_PEPPER',
  'REFERRAL_SIGNING_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'BREVO_WEBHOOK_TOKEN',
  'RESEND_DKIM_EXPECTED_VALUE',
  'RESEND_RSEND_CNAME_EXPECTED_TARGET',
  'RESEND_SEND_CNAME_EXPECTED_TARGET',
  'RESEND_SENDING_DOMAIN',
  'TURNSTILE_SECRET_KEY',
] as const;
const optionalKeys = [
  'HOST',
  'NODE_ENV',
  'PORT',
  'RESEND_KEY_MODE',
  'RESEND_TEST_RECIPIENT',
  'TURNSTILE_SITE_KEY',
  'IP_VELOCITY_WINDOW_MINUTES',
  'IP_VELOCITY_THRESHOLD',
  'VERIFICATION_RATE_BASELINE_DAYS',
  'VERIFICATION_RATE_COHORT_HOURS',
  'VERIFICATION_RATE_COLLAPSE_PERCENT',
  'VERIFICATION_RATE_MINIMUM_SIGNUPS',
  'WAITLIST_LIVE_AT',
  'DRAND_CHAIN_HASH',
  'DRAND_CHAIN_PUBLIC_KEY',
  'DRAND_RELAY_URLS',
  'GIVEAWAY_SANCTIONED_COUNTRIES',
  'GIVEAWAY_SUBSTITUTION_DAYS',
  'SEED_TEST_CONFIG_PATH',
  'BREVO_API_KEY',
  'BREVO_LIST_ID',
  'BREVO_SENDING_DOMAIN',
  'RESEND_WEBHOOK_GAP_MINUTES',
  'WEEKLY_SEND_UTC',
  'RESEND_TIER',
  'BREVO_TIER',
  'RESEND_DAILY_CAP',
  'BREVO_DAILY_CAP',
] as const;
export const p1AlertEnvironmentKeys = [
  'P1_ALERT_WEBHOOK_TOKEN',
  'P1_ALERT_WEBHOOK_URL',
] as const;

// The public Turnstile site key is rendered into the signup page so the widget
// can mount client-side (E3-05, ADR-006). It is public, not a secret, so unlike
// TURNSTILE_SECRET_KEY it carries a working default and never fails boot. The
// default is Cloudflare's documented always-passing TEST site key — a temporary
// placeholder until the founder provisions the real Cloudflare site key, which
// E12-05 swaps in alongside the production Turnstile secret. Overridable by env
// today so the founder can drop the real value in without a code change.
export const turnstileTestSiteKey = '1x00000000000000000000AA';
export const productionResendSendingDomain = 'send.valstara.com';
export const productionBrevoSendingDomain = 'mail.valstara.com';
export const resendFreeDailyCap = 100;
export const brevoFreeDailyCap = 300;

export const appEnvironmentKeys = [...requiredKeys, ...optionalKeys] as const;

export class ConfigurationError extends Error {
  public readonly variableName: EnvironmentKey;

  public constructor(variableName: EnvironmentKey, reason: string) {
    super(`Invalid configuration: ${variableName} ${reason}.`);
    this.name = 'ConfigurationError';
    this.variableName = variableName;
  }
}

export function validateConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const resend = resendConfiguration(environment);
  const config: AppConfig = {
    adminAuth: adminAuth(environment),
    databaseUrl: databaseUrl(environment),
    brevo: getBrevoConfiguration(environment),
    emailBaseUrl: emailBaseUrl(environment),
    emailTokenSecret: emailTokenSecret(environment),
    host: host(environment),
    ipPrefixPepper: requiredValue(environment, 'IP_PREFIX_PEPPER'),
    ipVelocity: ipVelocity(environment),
    referralSigningSecret: requiredValue(
      environment,
      'REFERRAL_SIGNING_SECRET',
    ),
    nodeEnvironment: nodeEnvironment(environment),
    port: port(environment),
    resendApiKey: resend.apiKey,
    resendWebhookSecret: webhookSecret(environment),
    brevoWebhookToken: bearerWebhookToken(environment),
    resendWebhookGapMinutes: positiveInteger(
      environment,
      'RESEND_WEBHOOK_GAP_MINUTES',
      120,
      1440,
    ),
    resendDomainAuthentication: resend.domainAuthentication,
    resendKeyMode: resend.keyMode,
    resendSendingDomain: resend.sendingDomain,
    resendTestRecipient: resend.testRecipient,
    turnstileSecretKey: requiredValue(environment, 'TURNSTILE_SECRET_KEY'),
    turnstileSiteKey: turnstileSiteKey(environment),
    verificationRate: verificationRate(environment),
    waitlistLiveAt: waitlistLiveAt(environment),
    drand: drandConfiguration(environment),
    giveawaySanctionedCountries: getGiveawaySanctionedCountries(environment),
    giveawaySubstitutionDays: getGiveawaySubstitutionDays(environment),
    weeklySendUtc:
      environment.WEEKLY_SEND_UTC === undefined
        ? null
        : getWeeklySendConfiguration(environment),
    emailQuota: getEmailQuotaConfiguration(environment),
  };
  return Object.freeze(config);
}

export interface BrevoConfiguration {
  readonly apiKey: string;
  readonly listId: number;
  readonly sendingDomain: typeof productionBrevoSendingDomain;
}

/** Live Brevo credentials arrive at E12-07. The off flag is safe without them. */
export function getBrevoConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): BrevoConfiguration | null {
  const key = optionalValue(environment, 'BREVO_API_KEY');
  const rawListId = optionalValue(environment, 'BREVO_LIST_ID');
  const domain = optionalValue(environment, 'BREVO_SENDING_DOMAIN');
  if (key === undefined && rawListId === undefined && domain === undefined)
    return null;
  if (key === undefined)
    return invalid('BREVO_API_KEY', 'is required when Brevo is configured');
  if (rawListId === undefined)
    return invalid('BREVO_LIST_ID', 'is required when Brevo is configured');
  if (domain !== productionBrevoSendingDomain)
    return invalid(
      'BREVO_SENDING_DOMAIN',
      `must be ${productionBrevoSendingDomain}`,
    );
  const listId = Number(rawListId);
  if (
    !Number.isSafeInteger(listId) ||
    listId < 1 ||
    String(listId) !== rawListId
  )
    return invalid('BREVO_LIST_ID', 'must be a positive integer');
  return Object.freeze({
    apiKey: key,
    listId,
    sendingDomain: productionBrevoSendingDomain,
  });
}

function adminAuth(environment: NodeJS.ProcessEnv): AdminAuthConfiguration {
  const credential = requiredValue(environment, 'ADMIN_CREDENTIAL');
  if (!/^[!-~]{32,}$/u.test(credential)) {
    return invalid(
      'ADMIN_CREDENTIAL',
      'must be at least 32 printable non-space ASCII characters',
    );
  }

  const totpSecret = requiredValue(environment, 'ADMIN_TOTP_SECRET');
  if (!/^[A-Z2-7]{32,}$/u.test(totpSecret)) {
    return invalid(
      'ADMIN_TOTP_SECRET',
      'must be an uppercase unpadded Base32 secret of at least 160 bits',
    );
  }

  return Object.freeze({ credential, totpSecret });
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= validateConfig(process.env);
  return cachedConfig;
}

export function getDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return databaseUrl(environment);
}

export function getResendDispatchConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<
  AppConfig,
  | 'emailBaseUrl'
  | 'emailTokenSecret'
  | 'resendApiKey'
  | 'resendDomainAuthentication'
  | 'resendKeyMode'
  | 'resendSendingDomain'
  | 'resendTestRecipient'
> {
  const resend = resendConfiguration(environment);
  return Object.freeze({
    emailBaseUrl: emailBaseUrl(environment),
    emailTokenSecret: emailTokenSecret(environment),
    resendApiKey: resend.apiKey,
    resendDomainAuthentication: resend.domainAuthentication,
    resendKeyMode: resend.keyMode,
    resendSendingDomain: resend.sendingDomain,
    resendTestRecipient: resend.testRecipient,
  });
}

export function getEmailWebhookConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<
  AppConfig,
  'resendWebhookSecret' | 'brevoWebhookToken' | 'resendWebhookGapMinutes'
> {
  return Object.freeze({
    resendWebhookSecret: webhookSecret(environment),
    brevoWebhookToken: bearerWebhookToken(environment),
    resendWebhookGapMinutes: positiveInteger(
      environment,
      'RESEND_WEBHOOK_GAP_MINUTES',
      120,
      1440,
    ),
  });
}

function resendConfiguration(
  environment: NodeJS.ProcessEnv,
): ResendConfiguration {
  const runtime = nodeEnvironment(environment);
  const keyMode = environment.RESEND_KEY_MODE;
  if (runtime === 'production' && keyMode !== 'live') {
    return invalid('RESEND_KEY_MODE', 'must be live in production');
  }
  if (runtime !== 'production' && keyMode === 'live') {
    return invalid('RESEND_KEY_MODE', 'must not be live outside production');
  }
  if (
    keyMode !== undefined &&
    keyMode !== '' &&
    keyMode !== 'test' &&
    keyMode !== 'live'
  ) {
    return invalid('RESEND_KEY_MODE', 'must be test or live');
  }

  if (
    runtime === 'production' &&
    environment.RESEND_TEST_RECIPIENT !== undefined
  ) {
    return invalid('RESEND_TEST_RECIPIENT', 'must not be set in production');
  }
  const testRecipient = optionalValue(environment, 'RESEND_TEST_RECIPIENT');

  const sendingDomain = requiredValue(environment, 'RESEND_SENDING_DOMAIN');
  if (sendingDomain !== productionResendSendingDomain) {
    return invalid(
      'RESEND_SENDING_DOMAIN',
      `must be ${productionResendSendingDomain}`,
    );
  }

  return Object.freeze({
    apiKey: requiredValue(environment, 'RESEND_API_KEY'),
    domainAuthentication: Object.freeze({
      dkimExpectedValue: requiredValue(
        environment,
        'RESEND_DKIM_EXPECTED_VALUE',
      ),
      rsendCnameExpectedTarget: dnsTarget(
        environment,
        'RESEND_RSEND_CNAME_EXPECTED_TARGET',
      ),
      sendCnameExpectedTarget: dnsTarget(
        environment,
        'RESEND_SEND_CNAME_EXPECTED_TARGET',
      ),
    }),
    keyMode: keyMode === 'live' ? 'live' : 'test',
    sendingDomain,
    testRecipient,
  });
}

function webhookSecret(environment: NodeJS.ProcessEnv): string {
  const secret = requiredValue(environment, 'RESEND_WEBHOOK_SECRET');
  if (!/^whsec_[A-Za-z0-9+/=_-]{24,}$/u.test(secret))
    return invalid('RESEND_WEBHOOK_SECRET', 'must be a Svix signing secret');
  return secret;
}

function bearerWebhookToken(environment: NodeJS.ProcessEnv): string {
  const token = requiredValue(environment, 'BREVO_WEBHOOK_TOKEN');
  if (!/^[!-~]{32,}$/u.test(token))
    return invalid(
      'BREVO_WEBHOOK_TOKEN',
      'must be at least 32 printable ASCII characters',
    );
  return token;
}

function optionalValue(
  environment: NodeJS.ProcessEnv,
  key: OptionalEnvironmentKey,
): string | undefined {
  const value = environment[key];
  if (value === undefined || value === '') return undefined;
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (value !== value.trim() || hasControlCharacter) {
    return invalid(
      key,
      'must not contain whitespace padding or control characters',
    );
  }
  return value;
}

function dnsTarget(
  environment: NodeJS.ProcessEnv,
  key:
    'RESEND_RSEND_CNAME_EXPECTED_TARGET' | 'RESEND_SEND_CNAME_EXPECTED_TARGET',
): string {
  const value = requiredValue(environment, key)
    .toLowerCase()
    .replace(/\.$/u, '');
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value)
  ) {
    return invalid(key, 'must be a DNS hostname');
  }
  return value;
}

export function getVerificationRateConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): VerificationRateConfiguration {
  return verificationRate(environment);
}

export function getIpVelocityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): IpVelocityConfiguration {
  return ipVelocity(environment);
}

export const giveawayPublishedStart = new Date('2026-10-01T00:00:00.000Z');

/** Production must record the actual launch time before opening the draw. */
export function getGiveawayEntryPeriodStart(
  environment: NodeJS.ProcessEnv = process.env,
): Date | null {
  const liveAt = waitlistLiveAt(environment);
  if (liveAt === null) {
    return nodeEnvironment(environment) === 'production'
      ? null
      : giveawayPublishedStart;
  }
  return liveAt > giveawayPublishedStart ? liveAt : giveawayPublishedStart;
}

function waitlistLiveAt(environment: NodeJS.ProcessEnv): Date | null {
  const value = environment.WAITLIST_LIVE_AT;
  if (value === undefined || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return invalid(
      'WAITLIST_LIVE_AT',
      'must be a UTC ISO timestamp with milliseconds',
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid('WAITLIST_LIVE_AT', 'must be a valid UTC timestamp');
  }
  return parsed;
}

export function getP1AlertConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): P1AlertConfiguration {
  const rawUrl = requiredValue(environment, 'P1_ALERT_WEBHOOK_URL');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return invalid('P1_ALERT_WEBHOOK_URL', 'must be a valid URL');
  }
  const runtime = nodeEnvironment(environment);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    (runtime === 'production' && parsed.protocol !== 'https:')
  ) {
    return invalid(
      'P1_ALERT_WEBHOOK_URL',
      'must be an HTTPS URL without credentials or a fragment in production',
    );
  }

  return Object.freeze({
    token: requiredValue(environment, 'P1_ALERT_WEBHOOK_TOKEN'),
    url: parsed.toString(),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  getConfig();
}

function invalid(variableName: EnvironmentKey, reason: string): never {
  throw new ConfigurationError(variableName, reason);
}

function requiredValue(
  environment: NodeJS.ProcessEnv,
  key: EnvironmentKey,
): string {
  const value = environment[key];
  if (value === undefined || value === '') {
    return invalid(key, 'is required');
  }
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (value !== value.trim() || hasControlCharacter) {
    return invalid(
      key,
      'must not contain whitespace padding or control characters',
    );
  }
  return value;
}

function databaseUrl(environment: NodeJS.ProcessEnv): string {
  const value = requiredValue(environment, 'DATABASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid('DATABASE_URL', 'must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname === '' ||
    parsed.username === '' ||
    parsed.password === '' ||
    parsed.pathname === '' ||
    parsed.pathname === '/'
  ) {
    return invalid(
      'DATABASE_URL',
      'must be a PostgreSQL URL with host, database, username, and password',
    );
  }
  return value;
}

function emailTokenSecret(environment: NodeJS.ProcessEnv): string {
  const value = requiredValue(environment, 'EMAIL_TOKEN_SECRET');
  if (value.length < 32) {
    return invalid('EMAIL_TOKEN_SECRET', 'must contain at least 32 characters');
  }
  return value;
}

function emailBaseUrl(environment: NodeJS.ProcessEnv): string {
  const raw = requiredValue(environment, 'EMAIL_BASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid('EMAIL_BASE_URL', 'must be an absolute URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    (nodeEnvironment(environment) === 'production' &&
      parsed.protocol !== 'https:')
  ) {
    return invalid(
      'EMAIL_BASE_URL',
      'must be a bare HTTPS origin in production',
    );
  }
  return parsed.origin;
}

function nodeEnvironment(environment: NodeJS.ProcessEnv): NodeEnvironment {
  const value = environment.NODE_ENV ?? 'development';
  return value === 'development' || value === 'production' || value === 'test'
    ? value
    : invalid('NODE_ENV', 'must be development, production, or test');
}

function port(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment.PORT;
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    return invalid('PORT', 'must be an integer from 1 to 65535');
  }
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 65_535
    ? parsed
    : invalid('PORT', 'must be an integer from 1 to 65535');
}

function turnstileSiteKey(environment: NodeJS.ProcessEnv): string {
  const value = environment.TURNSTILE_SITE_KEY;
  if (value === undefined || value === '') {
    return turnstileTestSiteKey;
  }
  return value === value.trim() && !/\s/u.test(value)
    ? value
    : invalid('TURNSTILE_SITE_KEY', 'must be a site key without whitespace');
}

function host(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.HOST;
  if (value === undefined || value === '') {
    return undefined;
  }
  return value === value.trim() && !/\s/u.test(value)
    ? value
    : invalid('HOST', 'must be a hostname or address without whitespace');
}

function verificationRate(
  environment: NodeJS.ProcessEnv,
): VerificationRateConfiguration {
  return Object.freeze({
    baselineDays: positiveInteger(
      environment,
      'VERIFICATION_RATE_BASELINE_DAYS',
      7,
    ),
    cohortHours: positiveInteger(
      environment,
      'VERIFICATION_RATE_COHORT_HOURS',
      24,
    ),
    collapsePercent: positiveInteger(
      environment,
      'VERIFICATION_RATE_COLLAPSE_PERCENT',
      50,
      100,
    ),
    minimumSignups: positiveInteger(
      environment,
      'VERIFICATION_RATE_MINIMUM_SIGNUPS',
      50,
    ),
  });
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  key: OptionalEnvironmentKey,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = environment[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    return invalid(key, `must be an integer from 1 to ${maximum}`);
  }
  const parsed = Number(value);
  return parsed >= 1 && parsed <= maximum
    ? parsed
    : invalid(key, `must be an integer from 1 to ${maximum}`);
}

function ipVelocity(environment: NodeJS.ProcessEnv): IpVelocityConfiguration {
  return Object.freeze({
    threshold: positiveInteger(environment, 'IP_VELOCITY_THRESHOLD', 10),
    windowMinutes: positiveInteger(
      environment,
      'IP_VELOCITY_WINDOW_MINUTES',
      60,
    ),
  });
}

type P1AlertEnvironmentKey = (typeof p1AlertEnvironmentKeys)[number];
type NodeEnvironment = 'development' | 'production' | 'test';
type OptionalEnvironmentKey = (typeof optionalKeys)[number];
export type AppEnvironmentKey = (typeof appEnvironmentKeys)[number];
type EnvironmentKey = AppEnvironmentKey | P1AlertEnvironmentKey;

export interface P1AlertConfiguration {
  readonly token: string;
  readonly url: string;
}

export interface VerificationRateConfiguration {
  readonly baselineDays: number;
  readonly cohortHours: number;
  readonly collapsePercent: number;
  readonly minimumSignups: number;
}

export interface IpVelocityConfiguration {
  readonly threshold: number;
  readonly windowMinutes: number;
}

export interface AdminAuthConfiguration {
  readonly credential: string;
  readonly totpSecret: string;
}

export interface ResendDomainAuthenticationConfiguration {
  readonly dkimExpectedValue: string;
  readonly rsendCnameExpectedTarget: string;
  readonly sendCnameExpectedTarget: string;
}

export interface SeedMailboxConfiguration {
  readonly address: string;
  readonly host: string;
  readonly inboxPath: string;
  readonly spamPath: string;
  readonly username: string;
  readonly password?: string;
}

export interface SeedTestConfiguration {
  readonly gmail: SeedMailboxConfiguration & { readonly password: string };
  readonly gmx: SeedMailboxConfiguration & { readonly password: string };
  readonly web_de: SeedMailboxConfiguration & { readonly password: string };
  readonly outlook: SeedMailboxConfiguration & {
    readonly oauth: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
      readonly rotationUrl: string;
      readonly rotationToken: string;
    };
  };
}

/** Seed credentials are optional until E12-07; an incomplete set fails startup. */
export function getSeedTestConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): SeedTestConfiguration | null {
  const path = environment.SEED_TEST_CONFIG_PATH;
  if (path === undefined || path === '') return null;
  if (environment.NODE_ENV !== 'production') {
    return invalid('SEED_TEST_CONFIG_PATH', 'requires production');
  }
  if (!path.startsWith('/'))
    return invalid('SEED_TEST_CONFIG_PATH', 'must be absolute');
  let raw: string;
  try {
    raw = readSecret(path);
  } catch {
    return invalid('SEED_TEST_CONFIG_PATH', 'must be a readable secret file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('SEED_TEST_CONFIG_PATH', 'must contain valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid(
      'SEED_TEST_CONFIG_PATH',
      'must contain four mailbox objects',
    );
  }
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'gmail,gmx,outlook,web_de') {
    return invalid(
      'SEED_TEST_CONFIG_PATH',
      'must contain four mailbox objects',
    );
  }
  const read = (provider: string): Record<string, unknown> => {
    const value = object[provider];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return invalid('SEED_TEST_CONFIG_PATH', 'has an invalid mailbox');
    }
    return value as Record<string, unknown>;
  };
  const string = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value
    ) {
      return invalid('SEED_TEST_CONFIG_PATH', 'has an empty or invalid field');
    }
    return value;
  };
  const common = (provider: string): SeedMailboxConfiguration => {
    const value = read(provider);
    const address = string(value.address);
    const host = string(value.host);
    const inboxPath = string(value.inboxPath);
    const spamPath = string(value.spamPath);
    const username = string(value.username);
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address) ||
      !/^[a-z0-9.-]+$/u.test(host) ||
      inboxPath === spamPath ||
      username !== address
    ) {
      return invalid(
        'SEED_TEST_CONFIG_PATH',
        'has an invalid mailbox address or path',
      );
    }
    return { address, host, inboxPath, spamPath, username };
  };
  const expected = {
    gmail: { host: 'imap.gmail.com', domains: ['gmail.com', 'googlemail.com'] },
    outlook: { host: 'outlook.office365.com', domains: ['outlook.com'] },
    gmx: { host: 'imap.gmx.net', domains: ['gmx.com', 'gmx.net', 'gmx.de'] },
    web_de: { host: 'imap.web.de', domains: ['web.de'] },
  } as const;
  for (const provider of Object.keys(expected) as (keyof typeof expected)[]) {
    const mailbox = common(provider);
    if (
      mailbox.host !== expected[provider].host ||
      !expected[provider].domains.some((domain) =>
        mailbox.address.toLowerCase().endsWith(`@${domain}`),
      )
    ) {
      return invalid(
        'SEED_TEST_CONFIG_PATH',
        'has a mismatched provider mailbox',
      );
    }
  }
  const passwordMailbox = (provider: 'gmail' | 'gmx' | 'web_de') => ({
    ...common(provider),
    password: string(read(provider).password),
  });
  const oauth = read('outlook').oauth;
  if (typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)) {
    return invalid(
      'SEED_TEST_CONFIG_PATH',
      'requires Outlook OAuth credentials',
    );
  }
  const o = oauth as Record<string, unknown>;
  const rotationUrl = string(o.rotationUrl);
  try {
    if (new URL(rotationUrl).protocol !== 'https:') throw new Error();
  } catch {
    return invalid('SEED_TEST_CONFIG_PATH', 'requires an HTTPS rotation URL');
  }
  return {
    gmail: passwordMailbox('gmail'),
    gmx: passwordMailbox('gmx'),
    web_de: passwordMailbox('web_de'),
    outlook: {
      ...common('outlook'),
      oauth: {
        clientId: string(o.clientId),
        clientSecret: string(o.clientSecret),
        refreshToken: string(o.refreshToken),
        rotationUrl,
        rotationToken: string(o.rotationToken),
      },
    },
  };
}

interface ResendConfiguration {
  readonly apiKey: string;
  readonly domainAuthentication: ResendDomainAuthenticationConfiguration;
  readonly keyMode: 'live' | 'test';
  readonly sendingDomain: typeof productionResendSendingDomain;
  readonly testRecipient: string | undefined;
}

export interface AppConfig {
  readonly adminAuth: AdminAuthConfiguration;
  readonly databaseUrl: string;
  readonly brevo: BrevoConfiguration | null;
  readonly emailBaseUrl: string;
  readonly emailTokenSecret: string;
  readonly host: string | undefined;
  readonly ipPrefixPepper: string;
  readonly ipVelocity: IpVelocityConfiguration;
  readonly referralSigningSecret: string;
  readonly nodeEnvironment: NodeEnvironment;
  readonly port: number | undefined;
  readonly resendApiKey: string;
  readonly resendWebhookSecret: string;
  readonly brevoWebhookToken: string;
  readonly resendWebhookGapMinutes: number;
  readonly resendDomainAuthentication: ResendDomainAuthenticationConfiguration;
  readonly resendKeyMode: 'live' | 'test';
  readonly resendSendingDomain: typeof productionResendSendingDomain;
  readonly resendTestRecipient: string | undefined;
  readonly turnstileSecretKey: string;
  readonly turnstileSiteKey: string;
  readonly verificationRate: VerificationRateConfiguration;
  readonly waitlistLiveAt: Date | null;
  readonly drand: DrandConfiguration | null;
  readonly giveawaySanctionedCountries: readonly string[];
  readonly giveawaySubstitutionDays: number;
  readonly weeklySendUtc: {
    readonly isoWeekday: number;
    readonly hour: number;
    readonly minute: number;
  } | null;
  readonly emailQuota: EmailQuotaConfiguration;
}

export interface ProviderQuotaConfiguration {
  readonly tier: 'free' | 'paid';
  readonly cap: number;
}

export interface EmailQuotaConfiguration {
  readonly resend: ProviderQuotaConfiguration;
  readonly brevo: ProviderQuotaConfiguration;
}

export function getEmailQuotaConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): EmailQuotaConfiguration {
  const provider = (
    tierKey: 'RESEND_TIER' | 'BREVO_TIER',
    capKey: 'RESEND_DAILY_CAP' | 'BREVO_DAILY_CAP',
    freeCap: number,
  ): ProviderQuotaConfiguration => {
    const tier = optionalValue(environment, tierKey) ?? 'free';
    if (tier !== 'free' && tier !== 'paid')
      return invalid(tierKey, 'must be free or paid');
    const cap = positiveInteger(environment, capKey, freeCap);
    if (tier === 'paid' && cap <= freeCap)
      return invalid(
        capKey,
        `must exceed the free cap of ${freeCap} when ${tierKey}=paid`,
      );
    return Object.freeze({ tier, cap });
  };
  return Object.freeze({
    resend: provider('RESEND_TIER', 'RESEND_DAILY_CAP', resendFreeDailyCap),
    brevo: provider('BREVO_TIER', 'BREVO_DAILY_CAP', brevoFreeDailyCap),
  });
}

export function getWeeklySendConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): {
  readonly isoWeekday: number;
  readonly hour: number;
  readonly minute: number;
} {
  const raw = requiredValue(environment, 'WEEKLY_SEND_UTC');
  const match = /^([1-7])@([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(raw);
  if (match === null)
    return invalid('WEEKLY_SEND_UTC', 'must be ISO weekday@HH:MM in UTC');
  return Object.freeze({
    isoWeekday: Number(match[1]),
    hour: Number(match[2]),
    minute: Number(match[3]),
  });
}

export function getGiveawaySubstitutionDays(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return positiveInteger(environment, 'GIVEAWAY_SUBSTITUTION_DAYS', 14);
}

/** ISO 3166-1 alpha-2 codes, configured by the founder; an empty list is valid. */
export function getGiveawaySanctionedCountries(
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = environment.GIVEAWAY_SANCTIONED_COUNTRIES;
  if (raw === undefined || raw.trim() === '') return Object.freeze([]);
  const countries = raw.split(',').map((value) => value.trim());
  if (
    countries.some((value) => !/^[A-Z]{2}$/u.test(value)) ||
    new Set(countries).size !== countries.length
  ) {
    return invalid(
      'GIVEAWAY_SANCTIONED_COUNTRIES',
      'must be distinct uppercase two-letter country codes separated by commas',
    );
  }
  return Object.freeze(countries);
}

export interface DrandConfiguration {
  readonly chainHash: string;
  readonly publicKey: string;
  readonly relays: readonly string[];
}

export function getDrandConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): DrandConfiguration | null {
  return drandConfiguration(environment);
}

function drandConfiguration(
  environment: NodeJS.ProcessEnv,
): DrandConfiguration | null {
  const hash = environment.DRAND_CHAIN_HASH;
  const key = environment.DRAND_CHAIN_PUBLIC_KEY;
  const rawRelays = environment.DRAND_RELAY_URLS;
  if (!hash && !key && !rawRelays) return null;
  if (!hash || !/^[a-f0-9]{64}$/u.test(hash)) {
    return invalid(
      'DRAND_CHAIN_HASH',
      'must be a 64-character lowercase hex chain hash',
    );
  }
  if (!key || !/^[a-f0-9]{96,192}$/u.test(key) || key.length % 2 !== 0) {
    return invalid(
      'DRAND_CHAIN_PUBLIC_KEY',
      'must be an even-length lowercase hex public key',
    );
  }
  const relays = (rawRelays ?? '').split(',').map((value) => value.trim());
  if (relays.length < 2) {
    return invalid(
      'DRAND_RELAY_URLS',
      'requires at least two distinct HTTPS relay URLs',
    );
  }
  const origins: string[] = [];
  for (const relay of relays) {
    let url: URL;
    try {
      url = new URL(relay);
    } catch {
      return invalid('DRAND_RELAY_URLS', 'contains an invalid URL');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      return invalid(
        'DRAND_RELAY_URLS',
        'requires HTTPS origins without paths or credentials',
      );
    }
    origins.push(url.origin);
  }
  if (new Set(origins).size !== origins.length) {
    return invalid(
      'DRAND_RELAY_URLS',
      'requires at least two distinct HTTPS relay URLs',
    );
  }
  return Object.freeze({
    chainHash: hash,
    publicKey: key,
    relays: Object.freeze(origins),
  });
}
