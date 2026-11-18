// The price-index evasion scan (E11.6-04). The fetcher presents as an
// ordinary browser (founder decision 2 of 2026-11-17), and two lines stay
// uncrossed: it never solves a CAPTCHA and it never rotates proxies or IP
// addresses. So the tool's own code (every code file under
// packages/price-index/) may not name a CAPTCHA at all, may not configure or
// load a proxy, and may not spoof or rotate the client address, and no
// dependency in package.json may be a CAPTCHA, proxy or SOCKS package.
// The verbatim source captures under test/fixtures/ are third-party pages,
// not code, and are not code files, so they are not read.

const scannedRoot = 'packages/price-index/';
const codeExtensions = /\.(?:[cm]?[jt]sx?)$/;
const forbidden = [
  { pattern: /captcha/gi, name: 'CAPTCHA' },
  { pattern: /prox(?:y|ies)/gi, name: 'proxy' },
  { pattern: /socks[45]?h?:\/\//gi, name: 'SOCKS address' },
  {
    pattern: /x-(?:forwarded-for|real-ip)|true-client-ip/gi,
    name: 'client-address header',
  },
  {
    // Pointing a host at a chosen address is how an egress is pinned or
    // rotated; mapping every other host to ~NOTFOUND is not.
    pattern: /\bMAP\s+\S+\s+(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])/gi,
    name: 'host mapped to an address',
  },
  {
    pattern: /\brotat\w*[^\n]{0,40}\b(?:ip|ips|address|addresses)\b/gi,
    name: 'IP rotation',
  },
];
const forbiddenDependency = /captcha|prox(?:y|ies)|socks|tor-request|rotat/i;

/** Issues for CAPTCHA solving, proxies or IP rotation in the price-index tool. */
export function scanPriceIndexEvasion(files, packageJson = {}) {
  const issues = [];
  for (const file of files) {
    if (!file.path.startsWith(scannedRoot) || !codeExtensions.test(file.path)) {
      continue;
    }
    for (const { pattern, name } of forbidden) {
      for (const match of file.content.matchAll(pattern)) {
        const line = file.content.slice(0, match.index).split('\n').length;
        issues.push({
          message: `line ${line}: ${name} (${match[0]}); the tool solves no CAPTCHA and never rotates proxies or IP addresses`,
          path: file.path,
          scan: 'price-index-evasion',
        });
      }
    }
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    for (const name of Object.keys(packageJson[field] ?? {})) {
      if (forbiddenDependency.test(name)) {
        issues.push({
          message: `${field} ${name}: the tool solves no CAPTCHA and never rotates proxies or IP addresses`,
          path: 'package.json',
          scan: 'price-index-evasion',
        });
      }
    }
  }
  return issues;
}
