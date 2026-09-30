#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

import { waitFor } from './wait-for.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const composeFile = fileURLToPath(
  new URL('./docker-compose.production.yml', import.meta.url),
);
const project = `valstara-e1-06-${process.pid}`;
const cloudflareNetwork = `${project}-cloudflare`;
const release = '0123456789012345678901234567890123456789';
const image = `ghcr.io/local/valstara-prelaunch:${release}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'valstara-e1-06-'));
const certificate = join(temporaryDirectory, 'origin-cert.pem');
const privateKey = join(temporaryDirectory, 'origin-key.pem');

const environment = {
  ...process.env,
  ADMIN_CREDENTIAL: 'production-stack-admin-credential-32-chars',
  ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  CADDY_BIND_ADDRESS: '127.0.0.1',
  CADDY_HTTP_PORT: '18080',
  CADDY_HTTPS_PORT: '18443',
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

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: projectRoot,
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

async function compose(args) {
  return run('docker', ['compose', '-p', project, '-f', composeFile, ...args]);
}

async function inspect(service) {
  const id = await compose(['ps', '--all', '--quiet', service]);
  assert.notEqual(id, '', `${service} has no container`);
  return JSON.parse(await run('docker', ['inspect', id])).at(0);
}

async function requestStatus(network, hostname, sourceIp) {
  const script = `
    const https = require('node:https');
    const request = https.request({
      headers: { host: 'valstara.com' },
      hostname: process.argv[1],
      method: 'GET',
      path: '/',
      rejectUnauthorized: false,
      servername: 'valstara.com',
    }, (response) => {
      response.resume();
      response.on('end', () => process.stdout.write(String(response.statusCode)));
    });
    request.on('error', (error) => {
      process.stderr.write(error.message);
      process.exitCode = 1;
    });
    request.end();
  `;
  const args = ['run', '--rm', '--network', network];
  if (sourceIp) {
    args.push('--ip', sourceIp);
  }
  args.push('node:22.22.3-bookworm-slim', 'node', '-e', script, hostname);
  return Number(await run('docker', args));
}

async function assertMemoryLimits() {
  for (const service of [
    'app',
    'caddy',
    'maintenance',
    'migrate',
    'postgres',
    'umami',
  ]) {
    const inspection = await inspect(service);
    const memory = inspection.HostConfig.Memory;
    assert.ok(memory > 0, `${service} has no hard memory limit`);
    assert.equal(
      inspection.HostConfig.MemorySwap,
      memory,
      `${service} does not disable swap`,
    );
  }
}

try {
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    privateKey,
    '-out',
    certificate,
    '-days',
    '1',
    '-subj',
    '/CN=valstara.com',
    '-addext',
    'subjectAltName=DNS:valstara.com',
  ]);
  await run('docker', ['build', '--tag', image, '.']);
  await compose(['up', '-d', '--wait']);

  await assertMemoryLimits();
  const appInspection = await inspect('app');
  const caddyInspection = await inspect('caddy');
  assert.equal(appInspection.Config.Image, image);
  assert.equal(appInspection.State.Health?.Status, 'healthy');
  assert.equal(caddyInspection.State.Health?.Status, 'healthy');

  await run('docker', [
    'network',
    'create',
    '--subnet',
    '173.245.48.0/24',
    cloudflareNetwork,
  ]);
  await run('docker', [
    'network',
    'connect',
    '--ip',
    '173.245.48.2',
    cloudflareNetwork,
    caddyInspection.Id,
  ]);

  assert.equal(
    await requestStatus(`${project}_backend`, 'caddy'),
    403,
    'a non-Cloudflare peer reached the origin',
  );
  assert.equal(
    await requestStatus(cloudflareNetwork, '173.245.48.2', '173.245.48.3'),
    200,
    'a Cloudflare-range peer did not reach the healthy app',
  );

  await compose(['stop', 'app']);
  await waitFor(
    'Caddy did not remove the unhealthy app',
    () => requestStatus(cloudflareNetwork, '173.245.48.2', '173.245.48.3'),
    503,
  );

  await compose(['start', 'app']);
  await waitFor(
    'the app container did not recover',
    async () => (await inspect('app')).State.Health?.Status,
    'healthy',
  );
  await waitFor(
    'Caddy did not return the recovered app to service',
    () => requestStatus(cloudflareNetwork, '173.245.48.2', '173.245.48.3'),
    200,
  );

  process.stdout.write(
    'Production image, Compose health gating, and Cloudflare-only origin assertions passed.\n',
  );
} finally {
  await compose(['down', '--volumes', '--remove-orphans']).catch(() => {});
  await run('docker', ['network', 'rm', cloudflareNetwork]).catch(() => {});
  await rm(temporaryDirectory, { force: true, recursive: true });
}
