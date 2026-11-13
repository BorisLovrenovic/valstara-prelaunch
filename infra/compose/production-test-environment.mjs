// Placeholder values that let `infra/compose/docker-compose.production.yml`
// interpolate and boot outside production: the E1-06 production-stack drill,
// the maintenance start smoke and the Compose environment test. None is a real
// credential; each only has the shape the configuration schema validates.

export const productionTestRelease = '0123456789012345678901234567890123456789';

export function productionTestEnvironment({
  image = `ghcr.io/local/valstara-prelaunch:${productionTestRelease}`,
  release = productionTestRelease,
  certificate = '/run/valstara-test-origin-cert.pem',
  privateKey = '/run/valstara-test-origin-key.pem',
  seedSecretsDirectory,
} = {}) {
  const environment = {
    ADMIN_CREDENTIAL: 'production-stack-admin-credential-32-chars',
    ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    CADDY_ORIGIN_CERT_PATH: certificate,
    CADDY_ORIGIN_KEY_PATH: privateKey,
    IP_PREFIX_PEPPER: 'production-stack-test-prefix-pepper',
    P1_ALERT_WEBHOOK_TOKEN: 'production-stack-test-alert-token',
    P1_ALERT_WEBHOOK_URL: 'https://alerts.example.test/valstara',
    REFERRAL_SIGNING_SECRET: 'production-stack-test-referral-secret',
    EMAIL_BASE_URL: 'https://valstara.com',
    EMAIL_TOKEN_SECRET: 'production-stack-email-token-secret-32-chars',
    RESEND_API_KEY: 'production-stack-test-resend-key',
    RESEND_WEBHOOK_SECRET: 'whsec_cHJvZHVjdGlvbi1zdGFjay13ZWJob29rLXRlc3Q=',
    BREVO_WEBHOOK_TOKEN: 'production-stack-test-brevo-webhook-token',
    RESEND_DKIM_EXPECTED_VALUE: 'p=production-stack-test-public-key',
    RESEND_KEY_MODE: 'live',
    RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
    RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
    RESEND_SENDING_DOMAIN: 'send.valstara.com',
    SITE_HOST: 'valstara.com',
    TURNSTILE_SECRET_KEY: 'production-stack-test-turnstile-secret',
    UMAMI_APP_SECRET: 'production-stack-test-umami-secret',
    UMAMI_DB_PASSWORD: 'production-stack-test-umami-password',
    UMAMI_DB_USER: 'umami',
    VALSTARA_APP_DB_PASSWORD: 'production-stack-test-app-password',
    VALSTARA_DB_PASSWORD: 'production-stack-test-owner-password',
    VALSTARA_DB_USER: 'valstara',
    VALSTARA_IMAGE: image,
    VALSTARA_RELEASE: release,
    WEEKLY_SEND_UTC: '2@09:00',
  };
  if (seedSecretsDirectory !== undefined)
    environment.SEED_TEST_SECRETS_HOST_DIR = seedSecretsDirectory;
  return environment;
}
