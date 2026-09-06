import { parse, teardown } from '@astrojs/compiler';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(new URL('../..', import.meta.url).pathname);
const codeExtensions = new Set([
  '.astro',
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
function parseArguments(argumentsList) {
  const options = { audit: true, base: process.env.SECURITY_BASE_SHA };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];

    if (argument === '--base') {
      options.base = argumentsList[index + 1];
      index += 1;
    }

    if (argument === '--skip-audit') {
      options.audit = false;
    }
  }

  return options;
}

function extension(filename) {
  const lastDot = filename.lastIndexOf('.');
  return lastDot === -1 ? '' : filename.slice(lastDot);
}

async function sourceFiles() {
  const paths = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const files = await Promise.all(
    paths.map(async (path) => {
      const fullPath = resolve(projectRoot, path);
      const fileStatus = await lstat(fullPath).catch((error) => {
        if (error.code === 'ENOENT') {
          return undefined;
        }
        throw error;
      });
      if (!fileStatus?.isFile()) {
        return undefined;
      }
      return { content: await readFile(fullPath), path };
    }),
  );
  return files
    .filter((file) => file && !file.content.includes(0))
    .map((file) => ({ ...file, content: file.content.toString('utf8') }));
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(projectRoot, path), 'utf8'));
}

function issue(scan, path, message) {
  return { message, path, scan };
}

function formatIssues(issues) {
  return issues
    .map(({ message, path, scan }) => `[${scan}] ${path}: ${message}`)
    .join('\n');
}

function isDotEnv(path) {
  const basename = path.split('/').at(-1);
  return basename.startsWith('.env') && basename !== '.env.example';
}

function addedPaths(base) {
  if (!base) {
    return [];
  }

  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  return output.split('\n').filter(Boolean);
}

async function scanSecrets(files, base) {
  const issues = [];
  const secretPatterns = [
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
    /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/,
  ];

  for (const file of files) {
    for (const pattern of secretPatterns) {
      if (pattern.test(file.content)) {
        issues.push(issue('secret', file.path, 'possible credential detected'));
        break;
      }
    }
  }

  let paths = [];
  try {
    paths = base ? addedPaths(base) : files.map((file) => file.path);
  } catch (error) {
    issues.push(
      issue('secret', '.', `could not inspect the PR range: ${String(error)}`),
    );
  }

  for (const path of paths) {
    if (isDotEnv(path)) {
      issues.push(issue('secret', path, '.env paths cannot be committed'));
    }
  }

  return issues;
}

function validateAllowlistEntry(entry, index, now) {
  const path = `scripts/ci/dependency-allowlist.json#allowlist[${index}]`;
  const issues = [];

  if (typeof entry !== 'object' || entry === null) {
    return [issue('dependency', path, 'entry must be an object')];
  }

  if (typeof entry.package !== 'string' || entry.package.length === 0) {
    issues.push(issue('dependency', path, 'entry requires a package name'));
  }
  if (
    (typeof entry.advisory !== 'string' &&
      typeof entry.advisory !== 'number') ||
    String(entry.advisory).trim().length === 0
  ) {
    issues.push(
      issue('dependency', path, 'entry requires an advisory identifier'),
    );
  }
  if (
    typeof entry.justification !== 'string' ||
    entry.justification.trim().length === 0
  ) {
    issues.push(
      issue('dependency', path, 'entry requires a written justification'),
    );
  }

  const expiresAt =
    typeof entry.expiresAt === 'string' ? new Date(entry.expiresAt) : undefined;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    issues.push(
      issue('dependency', path, 'entry requires a valid expiry date'),
    );
  } else if (expiresAt <= now) {
    issues.push(
      issue('dependency', path, 'entry expiry must be in the future'),
    );
  }

  return issues;
}

function auditDependencies(allowlist) {
  const result = spawnSync('npm', ['audit', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  let audit;

  try {
    audit = JSON.parse(result.stdout);
  } catch {
    return [
      issue('dependency', '.', 'npm audit did not return a valid JSON report'),
    ];
  }
  if (audit.error || (result.status !== 0 && !audit.vulnerabilities)) {
    return [
      issue(
        'dependency',
        '.',
        'npm audit could not complete a dependency report',
      ),
    ];
  }

  const allowedAdvisories = new Set(
    allowlist.map((entry) => `${entry.package}:${entry.advisory}`),
  );
  const issues = [];

  for (const [packageName, vulnerability] of Object.entries(
    audit.vulnerabilities ?? {},
  )) {
    for (const cause of vulnerability.via ?? []) {
      if (
        typeof cause !== 'string' &&
        !allowedAdvisories.has(`${packageName}:${cause.source}`)
      ) {
        issues.push(
          issue(
            'dependency',
            'package-lock.json',
            `unallowlisted advisory ${cause.source} for ${packageName}`,
          ),
        );
      }
    }
  }

  return issues;
}

async function scanDependencies(skipAudit) {
  const policy = await readJson('scripts/ci/dependency-allowlist.json');
  const allowlist = policy.allowlist;
  const issues = [];

  if (!Array.isArray(allowlist)) {
    return [
      issue(
        'dependency',
        'scripts/ci/dependency-allowlist.json',
        'allowlist must be an array',
      ),
    ];
  }

  for (const [index, entry] of allowlist.entries()) {
    issues.push(...validateAllowlistEntry(entry, index, new Date()));
  }

  if (issues.length === 0 && !skipAudit) {
    issues.push(...auditDependencies(allowlist));
  }

  return issues;
}

function browserFiles(files) {
  return files.filter(
    (file) =>
      (file.path.startsWith('src/pages/') &&
        !file.path.startsWith('src/pages/api/')) ||
      file.path.startsWith('src/components/') ||
      file.path.startsWith('src/islands/') ||
      file.path.startsWith('src/layouts/'),
  );
}

function themeStorageUse(file, policy, match) {
  const pathMatches = new RegExp(policy.themePreference.pathPattern).test(
    file.path,
  );
  const storageKey = escapeRegex(policy.themePreference.storageKey);
  const keyPattern = new RegExp(
    `^localStorage\\.(?:getItem|setItem)\\(\\s*['"]${storageKey}['"]`,
  );
  const call = file.content.slice(match.index, match.index + 128);
  return pathMatches && keyPattern.test(call);
}

async function scanCookieAndStorage(files) {
  const policy = await readJson('scripts/ci/privacy-allowlist.json');
  const issues = [];
  const pattern = /document\.cookie|Set-Cookie|localStorage|sessionStorage/g;

  for (const file of files.filter((candidate) =>
    candidate.path.startsWith('src/'),
  )) {
    for (const match of file.content.matchAll(pattern)) {
      if (!themeStorageUse(file, policy, match)) {
        issues.push(
          issue(
            'cookie-storage',
            file.path,
            `forbidden browser storage API: ${match[0]}`,
          ),
        );
      }
    }
  }

  return issues;
}

function scanFingerprinting(files) {
  const patterns = [
    new RegExp(
      '<can' +
        'vas\\b|createElement\\(\\s*[\'"]canvas[\'"]\\s*\\)|\\bOffscreenCanvas\\b|\\bHTMLCanvasElement\\b|\\bCanvasRenderingContext2D\\b|\\.getContext\\(\\s*[\'"](?:2d|webgl2?|experimental-webgl)[\'"]\\s*\\)',
    ),
    /(?:document|navigator)\.fonts|\bFontFace\b|\.measureText\(/,
    /\bWebGL(?:2)?RenderingContext\b|\bWEBGL_[A-Z_]+\b/,
    /performance\.(?:now|timeOrigin|getEntries(?:ByType|ByName)?)/,
  ];
  const issues = [];

  for (const file of files) {
    for (const pattern of patterns) {
      if (pattern.test(file.content)) {
        issues.push(
          issue('fingerprinting', file.path, 'fingerprinting API detected'),
        );
        break;
      }
    }
  }

  return issues;
}

function hostFromUrl(value) {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function isAllowedThirdParty(host, file, policy) {
  return policy.thirdPartyRequests.some(
    (entry) =>
      entry.host === host &&
      new RegExp(entry.pathPattern).test(file.path) &&
      file.content.includes(entry.requiredFlag),
  );
}

function scanThirdPartyRequests(files) {
  const issues = [];
  const urlPattern =
    /(?:fetch|import|navigator\.sendBeacon|new\s+(?:WebSocket|EventSource)|\.open)\(\s*(?:['"`][^'"`]+['"`]\s*,\s*)?(['"`])(https?:\/\/[^'"`]+)\1|<(?:script|iframe|img|link)\b[^>]*\b(?:src|href)=["'](https?:\/\/[^"']+)|(?:@import\s+(?:url\()?|url\()\s*['"]?(https?:\/\/[^'"\s)]+)/g;

  return readJson('scripts/ci/privacy-allowlist.json').then((policy) => {
    for (const file of browserFiles(files)) {
      for (const match of file.content.matchAll(urlPattern)) {
        const requestUrl = match[2] ?? match[3] ?? match[4];
        const host = hostFromUrl(requestUrl);
        if (host && !isAllowedThirdParty(host, file, policy)) {
          issues.push(
            issue(
              'third-party',
              file.path,
              `off-origin rendered request to ${host}`,
            ),
          );
        }
      }
    }
    return issues;
  });
}

function scanVendorBoundary(files) {
  const issues = [];
  const vendorPackages = new Map([
    ['resend', /^src\/server\/email\/providers\/resend\.ts$/],
    ['@getbrevo/brevo', /^src\/server\/email\/providers\/brevo\.ts$/],
    ['sib-api-v3-sdk', /^src\/server\/email\/providers\/brevo\.ts$/],
  ]);
  const staticImport =
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const runtimeImport = /\bimport\(([^)]+)\)/g;

  for (const file of files.filter((candidate) =>
    codeExtensions.has(extension(candidate.path)),
  )) {
    for (const match of file.content.matchAll(staticImport)) {
      const allowedPath = vendorPackages.get(match[1]);
      if (allowedPath && !allowedPath.test(file.path)) {
        issues.push(
          issue(
            'vendor-boundary',
            file.path,
            `email SDK ${match[1]} is outside its provider module`,
          ),
        );
      }
    }

    for (const match of file.content.matchAll(runtimeImport)) {
      const target = match[1].trim();
      const staticTarget = /^(['"])([^'"]+)\1$/.exec(target);
      if (!staticTarget) {
        issues.push(
          issue(
            'vendor-boundary',
            file.path,
            'runtime import target is not static',
          ),
        );
        continue;
      }

      const packageName = staticTarget[2];
      const allowedPath = vendorPackages.get(packageName);
      if (allowedPath && !allowedPath.test(file.path)) {
        issues.push(
          issue(
            'vendor-boundary',
            file.path,
            `email SDK ${packageName} is outside its provider module`,
          ),
        );
      }
    }
  }

  return issues;
}

async function scanForbiddenCopy(files) {
  const policy = await readJson('scripts/forbidden-copy.json');
  const issues = [];

  if (!Array.isArray(policy.entries) || policy.entries.length === 0) {
    return [
      issue(
        'forbidden-copy',
        'scripts/forbidden-copy.json',
        'entries must be non-empty',
      ),
    ];
  }

  for (const [index, entry] of policy.entries.entries()) {
    if (
      typeof entry.term !== 'string' ||
      entry.term.length === 0 ||
      typeof entry.replacement !== 'string' ||
      entry.replacement.length === 0
    ) {
      issues.push(
        issue(
          'forbidden-copy',
          `scripts/forbidden-copy.json#entries[${index}]`,
          'each term requires a replacement',
        ),
      );
    }
  }

  if (issues.length > 0) {
    return issues;
  }

  const targets = files.filter(
    (file) =>
      file.path.startsWith('src/copy/') ||
      file.path.startsWith('src/content/') ||
      file.path.endsWith('.astro'),
  );
  for (const file of targets) {
    for (const entry of policy.entries) {
      if (
        new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'i').test(file.content)
      ) {
        issues.push(
          issue(
            'forbidden-copy',
            file.path,
            `forbidden copy "${entry.term}"; use "${entry.replacement}"`,
          ),
        );
      }
    }
  }

  return issues;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A run of two or more letters is prose; punctuation, whitespace and single
// glyphs (numerals, separators, entities) are not. Unicode-aware so accented
// copy is caught too.
const prosePattern = /\p{L}{2,}/u;

function proseSnippet(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 60);
}

// Attributes whose value is customer-visible prose (rendered to the eye or read
// out by assistive technology). A literal string in one of these is prose inline
// in markup exactly as a text node is (standing rule 16), so it belongs in the
// copy layer too. Attributes that carry ids, tokens, URLs or enumerated states
// (`class`, `href`, `role`, `aria-pressed`, `content`, …) are not copy and are
// deliberately absent.
const proseAttributes = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'placeholder',
  'title',
]);

// Walk the Astro template AST collecting literal inline prose as { text, line }.
// Prose belongs in the copy layer only when it is markup — not JavaScript inside
// an `{expression}`, and not the body of a <script> or <style>. This covers two
// shapes: text nodes, and literal values of the customer-visible attributes
// above. A value routed through an `{expression}` is the sanctioned copy-layer
// path and is left alone (attribute kind 'expression', not 'quoted'). Elements
// nested inside an expression (`{items.map((i) => <li>text</li>)}`) re-enter
// markup mode, so their own text and attributes are still flagged.
function collectProseNodes(node, parentType, insideScriptOrStyle, found) {
  if (node.type === 'text') {
    if (
      parentType !== 'expression' &&
      !insideScriptOrStyle &&
      prosePattern.test(node.value)
    ) {
      found.push({
        line: node.position?.start?.line,
        text: proseSnippet(node.value),
      });
    }
    return;
  }

  for (const attribute of node.attributes ?? []) {
    if (
      attribute.kind === 'quoted' &&
      proseAttributes.has(attribute.name) &&
      prosePattern.test(attribute.value)
    ) {
      found.push({
        line: attribute.position?.start?.line,
        text: `${attribute.name}="${proseSnippet(attribute.value)}"`,
      });
    }
  }

  const nextInsideScriptOrStyle =
    insideScriptOrStyle || node.name === 'script' || node.name === 'style';
  for (const child of node.children ?? []) {
    collectProseNodes(child, node.type, nextInsideScriptOrStyle, found);
  }
}

// Exported for unit tests: given Astro source, return each inline-prose hit as
// { text, line }. Does not tear the compiler down, so it is safe to call
// repeatedly in-process.
export async function findInlineProse(source) {
  const { ast } = await parse(source, { position: true });
  const found = [];
  for (const child of ast.children ?? []) {
    collectProseNodes(child, 'root', false, found);
  }
  return found;
}

async function scanInlineProse(files) {
  const targets = files.filter(
    (file) => file.path.startsWith('src/') && file.path.endsWith('.astro'),
  );
  const issues = [];

  for (const file of targets) {
    let hits;
    try {
      hits = await findInlineProse(file.content);
    } catch (error) {
      issues.push(
        issue(
          'inline-prose',
          file.path,
          `could not parse the component: ${String(error)}`,
        ),
      );
      continue;
    }

    for (const hit of hits) {
      const where = hit.line === undefined ? '' : ` (line ${hit.line})`;
      issues.push(
        issue(
          'inline-prose',
          file.path,
          `inline prose "${hit.text}"${where}; move this string into src/copy/ and render it from an {expression}`,
        ),
      );
    }
  }

  return issues;
}

export async function runSecurityGates(
  options = parseArguments(process.argv.slice(2)),
) {
  const files = await sourceFiles();
  const scans = await Promise.all([
    scanSecrets(files, options.base),
    scanDependencies(!options.audit),
    scanCookieAndStorage(files),
    scanFingerprinting(files),
    scanThirdPartyRequests(files),
    scanVendorBoundary(files),
    scanForbiddenCopy(files),
    scanInlineProse(files),
  ]);
  return scans.flat();
}

async function main() {
  const issues = await runSecurityGates();
  teardown();
  if (issues.length > 0) {
    process.stderr.write(`${formatIssues(issues)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Security and privacy gates passed.\n');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
