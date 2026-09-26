import { fileURLToPath } from 'node:url';

const requiredKeys = [
  'ADMIN_CREDENTIAL',
  'ADMIN_TOTP_SECRET',
  'DATABASE_URL',
  'IP_PREFIX_PEPPER',
  'REFERRAL_SIGNING_SECRET',
  'RESEND_API_KEY',
  'RESEND_TEST_RECIPIENT',
  'TURNSTILE_SECRET_KEY',
] as const;
const optionalKeys = [
  'HOST',
  'NODE_ENV',
  'PORT',
  'TURNSTILE_SITE_KEY',
  'IP_VELOCITY_WINDOW_MINUTES',
  'IP_VELOCITY_THRESHOLD',
  'VERIFICATION_RATE_BASELINE_DAYS',
  'VERIFICATION_RATE_COHORT_HOURS',
  'VERIFICATION_RATE_COLLAPSE_PERCENT',
  'VERIFICATION_RATE_MINIMUM_SIGNUPS',
  'WAITLIST_LIVE_AT',
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
  const config: AppConfig = {
    adminAuth: adminAuth(environment),
    databaseUrl: databaseUrl(environment),
    host: host(environment),
    ipPrefixPepper: requiredValue(environment, 'IP_PREFIX_PEPPER'),
    ipVelocity: ipVelocity(environment),
    referralSigningSecret: requiredValue(
      environment,
      'REFERRAL_SIGNING_SECRET',
    ),
    nodeEnvironment: nodeEnvironment(environment),
    port: port(environment),
    resendApiKey: requiredValue(environment, 'RESEND_API_KEY'),
    resendTestRecipient: recipient(environment),
    turnstileSecretKey: requiredValue(environment, 'TURNSTILE_SECRET_KEY'),
    turnstileSiteKey: turnstileSiteKey(environment),
    verificationRate: verificationRate(environment),
    waitlistLiveAt: waitlistLiveAt(environment),
  };
  return Object.freeze(config);
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

function recipient(environment: NodeJS.ProcessEnv): string {
  const value = requiredValue(environment, 'RESEND_TEST_RECIPIENT');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
    ? value
    : invalid('RESEND_TEST_RECIPIENT', 'must be a valid email address');
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

export interface AppConfig {
  readonly adminAuth: AdminAuthConfiguration;
  readonly databaseUrl: string;
  readonly host: string | undefined;
  readonly ipPrefixPepper: string;
  readonly ipVelocity: IpVelocityConfiguration;
  readonly referralSigningSecret: string;
  readonly nodeEnvironment: NodeEnvironment;
  readonly port: number | undefined;
  readonly resendApiKey: string;
  readonly resendTestRecipient: string;
  readonly turnstileSecretKey: string;
  readonly turnstileSiteKey: string;
  readonly verificationRate: VerificationRateConfiguration;
  readonly waitlistLiveAt: Date | null;
}
