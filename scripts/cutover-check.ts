import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { currentRulesFromFiles } from '../src/server/giveaway/current-rules-file.ts';

export interface CutoverCheckResult {
  readonly checked: readonly string[];
}

export interface CutoverDestinations {
  readonly accountPath: string;
  readonly privacyRightsPath: string;
  readonly emailPreferencesPath: string;
}

export interface CutoverRules {
  readonly currentVersion: string;
  readonly revisions: readonly {
    readonly version: string;
    readonly sha256: string;
  }[];
}

function sameOriginLocation(base: URL, response: Response): URL {
  const location = response.headers.get('location');
  if (!location) throw new Error('A cutover redirect has no Location.');
  const target = new URL(location, base);
  if (target.origin !== base.origin)
    throw new Error('A cutover redirect leaves the storefront origin.');
  return target;
}

export async function checkCutover(
  baseUrl: string,
  unsubscribeToken: string,
  expiredUnsubscribeToken: string,
  destinations: CutoverDestinations,
  request: typeof fetch = fetch,
  rules?: CutoverRules,
): Promise<CutoverCheckResult> {
  if (
    !unsubscribeToken ||
    !expiredUnsubscribeToken ||
    unsubscribeToken === expiredUnsubscribeToken
  )
    throw new Error(
      'Distinct live and expired test unsubscribe tokens are required.',
    );
  for (const [name, path] of Object.entries(destinations)) {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error(`The storefront ${name} must be an absolute path.`);
  }
  const base = new URL(baseUrl);
  const versions = (
    await readdir(new URL('../src/content/giveaway-rules/', import.meta.url))
  )
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3))
    .sort();
  const sourceRevisions = await Promise.all(
    versions.map(async (version) => {
      const source = await readFile(
        new URL(`../src/content/giveaway-rules/${version}.md`, import.meta.url),
        'utf8',
      );
      const sha256 = /^sha256: ['"]?([a-f0-9]{64})['"]?$/mu.exec(source)?.[1];
      if (!sha256) throw new Error(`${version} has no recorded SHA-256.`);
      return { version, sha256 };
    }),
  );
  const selected = await currentRulesFromFiles();
  const sourceCurrent = sourceRevisions.find(
    (entry) => entry.version === selected.rulesVersion,
  );
  if (!sourceCurrent || sourceCurrent.sha256 !== selected.sha256)
    throw new Error('The current rules revision disagrees with its source.');
  const revisions = rules?.revisions ?? sourceRevisions;
  const current = revisions.find(
    (entry) =>
      entry.version === (rules?.currentVersion ?? selected.rulesVersion),
  );
  if (!current) throw new Error('The current rules revision is missing.');
  const checked: string[] = [];
  async function expect(path: string, status: number) {
    const response = await request(new URL(path, base), { redirect: 'manual' });
    if (response.status !== status)
      throw new Error(
        `${path} returned ${response.status}, expected ${status}.`,
      );
    checked.push(path);
    return response;
  }

  for (const path of [
    '/',
    '/legit',
    '/guarantee',
    '/about',
    '/terms',
    '/privacy',
    '/privacy/storage',
  ])
    await expect(path, 200);

  for (const [path, revision, archived] of [
    ['/giveaway/rules', current, false] as const,
    ...revisions.map(
      (revision) =>
        [
          `/giveaway/rules/${revision.version}`,
          revision,
          revision.version !== current.version,
        ] as const,
    ),
  ]) {
    const response = await expect(path, 200);
    const html = await response.text();
    if (
      !html.includes(`data-rules-version="${revision.version}"`) ||
      !html.includes(`data-rules-sha256="${revision.sha256}"`)
    )
      throw new Error(`${path} lost its recorded rules revision or SHA-256.`);
    const article =
      /<article\b[^>]*data-rules-version="([^"]+)"[^>]*data-rules-sha256="([a-f0-9]{64})"[^>]*>([\s\S]*?)<\/article>/u.exec(
        html,
      );
    if (
      !article ||
      article[1] !== revision.version ||
      article[2] !== revision.sha256 ||
      createHash('sha256').update(article[3], 'utf8').digest('hex') !==
        revision.sha256
    )
      throw new Error(`${path} article content has a SHA-256 mismatch.`);
    if (
      archived &&
      (!/<meta[^>]+name="robots"[^>]+content="noindex"/u.test(html) ||
        !html.includes('data-archived-rules-notice'))
    )
      throw new Error(`${path} lacks the archived notice or noindex.`);
  }
  const sitemap = await expect('/sitemap.xml', 200);
  const sitemapXml = await sitemap.text();
  if (!sitemapXml.includes(`/giveaway/rules/${current.version}</loc>`))
    throw new Error('The current rules revision is missing from the sitemap.');
  for (const revision of revisions.filter(
    (entry) => entry.version !== current.version,
  )) {
    if (sitemapXml.includes(`/giveaway/rules/${revision.version}</loc>`))
      throw new Error(`${revision.version} must be excluded from the sitemap.`);
  }

  for (const [path, expectedTarget] of [
    ['/waitlist', '/'],
    ['/leaderboard', '/'],
    ['/me', destinations.accountPath],
    ['/dsr', destinations.privacyRightsPath],
  ] as const) {
    const response = await expect(path, 301);
    const target = sameOriginLocation(base, response);
    if (target.pathname !== expectedTarget)
      throw new Error(
        `${path} redirects to ${target.pathname}, expected ${expectedTarget}.`,
      );
    const destination = await request(target, { redirect: 'manual' });
    if (destination.status !== 200)
      throw new Error(
        `${path} redirect target returned ${destination.status}.`,
      );
  }
  for (const path of [
    '/giveaway/award',
    '/verify',
    '/api/signup',
    '/api/resend-verification',
    '/api/survey',
    '/api/leaderboard',
    '/api/me/leave',
    '/api/me/marketing',
    '/api/dsr/export',
    '/api/dsr/delete',
    '/api/webhooks/resend',
    '/api/webhooks/brevo',
    '/api/admin/draw',
    '/api/admin/export.csv',
    '/api/admin/fraud',
    '/api/admin/fraud/example',
    '/api/admin/health',
  ])
    await expect(path, 410);

  const unsubscribePage = new URL('/unsubscribe', base);
  unsubscribePage.searchParams.set('t', unsubscribeToken);
  const page = await request(unsubscribePage, { redirect: 'manual' });
  if (page.status !== 200)
    throw new Error(
      'A live unsubscribe token does not open its storefront page.',
    );
  checked.push('/unsubscribe');

  const oneClick = new URL('/api/unsubscribe', base);
  oneClick.searchParams.set('token', unsubscribeToken);
  const body = new URLSearchParams({ 'List-Unsubscribe': 'One-Click' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request(oneClick, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    if (response.status !== 200)
      throw new Error(
        `One-click unsubscribe attempt ${attempt + 1} returned ${response.status}.`,
      );
    const result: unknown = await response.json();
    if (
      typeof result !== 'object' ||
      result === null ||
      !('status' in result) ||
      result.status !== 'accepted'
    )
      throw new Error('One-click unsubscribe was not accepted.');
  }
  checked.push('POST /api/unsubscribe (first use and replay)');

  for (const [path, parameter, method] of [
    ['/unsubscribe', 't', 'GET'],
    ['/api/unsubscribe', 'token', 'POST'],
  ] as const) {
    const expired = new URL(path, base);
    expired.searchParams.set(parameter, expiredUnsubscribeToken);
    const response = await request(expired, {
      method,
      ...(method === 'POST'
        ? {
            body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          }
        : {}),
      redirect: 'manual',
    });
    if (response.status !== 301)
      throw new Error(
        `${path} expired-token request returned ${response.status}, expected 301.`,
      );
    const target = sameOriginLocation(base, response);
    if (target.pathname !== destinations.emailPreferencesPath)
      throw new Error(
        `${path} expired-token redirect misses ${destinations.emailPreferencesPath}.`,
      );
    const destination = await request(target, {
      redirect: 'manual',
    });
    if (destination.status !== 200)
      throw new Error(
        `${path} expired-token redirect target returned ${destination.status}.`,
      );
    checked.push(`${method} ${path} (expired token)`);
  }
  return { checked };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const argument = (name: string) =>
    process.argv
      .find((part) => part.startsWith(`--${name}=`))
      ?.slice(name.length + 3);
  const baseUrl = argument('base-url');
  const token = argument('unsubscribe-token');
  const expiredToken = argument('expired-unsubscribe-token');
  const accountPath = argument('account-path');
  const privacyRightsPath = argument('privacy-rights-path');
  const emailPreferencesPath = argument('email-preferences-path');
  if (
    !baseUrl ||
    !token ||
    !expiredToken ||
    !accountPath ||
    !privacyRightsPath ||
    !emailPreferencesPath
  )
    throw new Error(
      'Use --base-url=<storefront> --unsubscribe-token=<live-test-token> --expired-unsubscribe-token=<expired-test-token> --account-path=<path> --privacy-rights-path=<path> --email-preferences-path=<path>.',
    );
  const result = await checkCutover(baseUrl, token, expiredToken, {
    accountPath,
    privacyRightsPath,
    emailPreferencesPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
