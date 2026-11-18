import { posix } from 'node:path';

// The price-index isolation scan (E11.6-02, ADR-033). The price-index tool is
// a separate offline process: the site may import only its read-only
// `src/publish` and `src/schema` entry points, the package imports nothing
// from the site, and nothing that builds, starts or deploys the site
// references or copies the tool.

const packageRoot = 'packages/price-index';
const siteImportable = [
  `${packageRoot}/src/publish`,
  `${packageRoot}/src/schema`,
];
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
// The npm scripts that develop, build, start or preview the site, and the
// lifecycle hooks npm runs around each.
const siteScripts = ['dev', 'start', 'build', 'preview'].flatMap((name) => [
  `pre${name}`,
  name,
  `post${name}`,
]);

const importPatterns = [
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  /\bimport\.meta\.glob\s*\(\s*['"`]([^'"`]+)['"`]/g,
];

function extension(path) {
  const basename = path.split('/').at(-1);
  const lastDot = basename.lastIndexOf('.');
  return lastDot <= 0 ? '' : basename.slice(lastDot);
}

function issue(path, message) {
  return { message, path, scan: 'price-index-isolation' };
}

function importSpecifiers(content) {
  const specifiers = new Set();
  for (const pattern of importPatterns) {
    for (const match of content.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

/**
 * The repository-relative path an import names, or undefined for a package
 * import. Relative specifiers resolve against the importing file.
 */
function resolveSpecifier(importer, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return posix.normalize(posix.join(posix.dirname(importer), specifier));
  }
  if (specifier.startsWith('/')) {
    return posix.normalize(specifier.slice(1));
  }
  return undefined;
}

function isWithin(path, directory) {
  return path === directory || path.startsWith(`${directory}/`);
}

function isSiteImportable(path) {
  return siteImportable.some(
    (allowed) =>
      isWithin(path, allowed) ||
      path === `${allowed}.ts` ||
      path === `${allowed}.js`,
  );
}

/** Every mention of the tool in a text, other than its two site-importable parts. */
function toolReferences(content) {
  const references = [];
  for (const match of content.matchAll(
    /packages\/price-index(?:\/[\w./-]*)?/g,
  )) {
    if (!isSiteImportable(match[0].replace(/\/$/, ''))) {
      references.push(match[0]);
    }
  }
  for (const match of content.matchAll(/\brun(?:-script)?\s+price-index\b/g)) {
    references.push(match[0]);
  }
  return references;
}

function scanSiteImports(files) {
  const issues = [];
  for (const file of files) {
    if (
      !isWithin(file.path, 'src') ||
      !codeExtensions.has(extension(file.path))
    ) {
      continue;
    }
    for (const specifier of importSpecifiers(file.content)) {
      const resolved = resolveSpecifier(file.path, specifier);
      const target =
        resolved ??
        (specifier.includes(`${packageRoot}/`) || specifier === packageRoot
          ? specifier.slice(specifier.indexOf(packageRoot))
          : undefined);
      if (target !== undefined && isWithin(target, packageRoot)) {
        if (!isSiteImportable(target)) {
          issues.push(
            issue(
              file.path,
              `imports ${specifier}; the site may import only ${siteImportable.join(' and ')}`,
            ),
          );
        }
      } else if (resolved === undefined && /price-index/.test(specifier)) {
        issues.push(
          issue(
            file.path,
            `imports ${specifier}, which is not a path the scan can check`,
          ),
        );
      }
    }
  }
  return issues;
}

function scanPackageImports(files) {
  const issues = [];
  for (const file of files) {
    if (
      !isWithin(file.path, packageRoot) ||
      isWithin(file.path, `${packageRoot}/test/fixtures`) ||
      !codeExtensions.has(extension(file.path))
    ) {
      continue;
    }
    for (const specifier of importSpecifiers(file.content)) {
      const resolved = resolveSpecifier(file.path, specifier);
      if (resolved !== undefined && isWithin(resolved, 'src')) {
        issues.push(
          issue(
            file.path,
            `imports ${specifier} from the site; the price-index package imports nothing from src/`,
          ),
        );
      }
    }
  }
  return issues;
}

function isDockerfile(path) {
  const basename = path.split('/').at(-1);
  return basename === 'Dockerfile' || basename.endsWith('.Dockerfile');
}

function isComposeFile(path) {
  return /^(?:docker-)?compose(?:\.[\w-]+)*\.ya?ml$/.test(
    path.split('/').at(-1),
  );
}

function isWorkflow(path) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

function isCrontab(path) {
  return /cron/i.test(path.split('/').at(-1));
}

/** COPY or ADD sources that would bring the tool into an image. */
function dockerCopySources(content) {
  const sources = [];
  const lines = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (!match) {
      continue;
    }
    const words = match[1].trim().split(/\s+/);
    if (words.some((word) => /^--from=/i.test(word))) {
      continue;
    }
    const paths = words.filter((word) => !word.startsWith('--'));
    for (const source of paths.slice(0, -1)) {
      const normalised = posix.normalize(source).replace(/\/$/, '');
      if (
        normalised === '.' ||
        normalised === 'packages' ||
        (isWithin(normalised, packageRoot) && !isSiteImportable(normalised))
      ) {
        sources.push(source);
      }
    }
  }
  return sources;
}

function scanDeploymentFiles(files) {
  const issues = [];
  for (const file of files) {
    const dockerfile = isDockerfile(file.path);
    if (
      !dockerfile &&
      !isComposeFile(file.path) &&
      !isWorkflow(file.path) &&
      !isCrontab(file.path)
    ) {
      continue;
    }
    for (const reference of toolReferences(file.content)) {
      issues.push(
        issue(file.path, `references the price-index tool (${reference})`),
      );
    }
    if (dockerfile) {
      for (const source of dockerCopySources(file.content)) {
        issues.push(
          issue(
            file.path,
            `copies ${source}, which would include the price-index tool`,
          ),
        );
      }
    }
  }
  return issues;
}

function scanSiteScripts(packageJson) {
  const scripts = packageJson?.scripts ?? {};
  const issues = [];
  const visited = new Set();
  const queue = siteScripts.filter((name) => name in scripts);

  while (queue.length > 0) {
    const name = queue.shift();
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    const command = scripts[name];
    for (const reference of toolReferences(command)) {
      issues.push(
        issue(
          'package.json',
          `script "${name}" references the price-index tool (${reference})`,
        ),
      );
    }
    for (const match of command.matchAll(
      /\bnpm\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g,
    )) {
      const target = match[1];
      if (target in scripts) {
        queue.push(
          ...[`pre${target}`, target, `post${target}`].filter(
            (key) => key in scripts,
          ),
        );
      }
    }
  }
  return issues;
}

/**
 * @param {{ path: string, content: string }[]} files tracked text files
 * @param {{ scripts?: Record<string, string> }} packageJson the root manifest
 */
export function scanPriceIndexIsolation(files, packageJson) {
  return [
    ...scanSiteImports(files),
    ...scanPackageImports(files),
    ...scanDeploymentFiles(files),
    ...scanSiteScripts(packageJson),
  ];
}
