import { resolve } from 'node:path';

import { generatedPages, hubPaths } from '../publish/pages.ts';
import {
  isHubPath,
  isRetirement,
  publishedUrlsFile,
  servicePagePathPattern,
  type PublishedUrlsFile,
  type RetiredUrl,
} from '../schema/published-urls.ts';
import { createJsonFileStore } from '../storage/json-file-store.ts';
import { PriceStoreError } from '../storage/price-store.ts';
import {
  appendRetirement,
  readPublishedUrls,
} from '../storage/published-urls-file.ts';
import {
  formatIssues,
  loadConfig,
  priceIndexDataDirectory,
  validateDataFiles,
} from './validate.ts';

// `price-index retire-url <url> --to <hub> --actor <name>` (E11.6-12, D2 and
// D-032 Q2). A published URL whose service or market has left the
// configuration stays "temporarily unavailable" until the founder retires
// it. Retiring appends one entry, `{ kind: "retired", path, to, actor,
// retired_on }`, to data/price-index/published-urls.json, after the URL's
// publication entry; nothing is edited (epic rule 7). While its pair
// generates no page, the site then answers the URL with a 301 to `to` in
// place of the unavailable state, and lists it in no sitemap; if the data
// generates the page again, the page is served (D-037 Q2).
//
// It refuses, with nothing written: a missing or empty --actor (checked
// before anything is read), a URL that is not a service × market page, a
// URL the ledger never published or has already retired, a URL that still
// publishes a page, since a retirement never takes down a live page (D-037
// Q1), and a `to` that is not a hub the current data makes, so a retired
// URL never redirects to a page that is not there.

export const retireUrlExitCodes = {
  done: 0,
  /** A refused request: bad flags, no actor, an unknown URL or hub. */
  refused: 1,
  /** A configuration or data file fails its schema. */
  validationFailure: 3,
} as const;

/** The command's flags, exactly; each is required and given once. */
export const retireUrlFlags = ['--to', '--actor'];

export const retireUrlUsage = `Usage: npm run price-index -- retire-url <url> --to <hub> --actor <name>
`;

export interface RetireUrlIo {
  root: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  clock: { now(): Date };
}

interface RetireUrlRequest {
  path: string;
  to: string;
  actor: string;
}

// The site's own origin: a URL may be given in full or as its path.
const siteOrigin = 'https://valstara.com';

/** A path on the site, from a path or a full URL on the site's origin. */
function sitePath(value: string): string {
  return value.startsWith(`${siteOrigin}/`)
    ? value.slice(siteOrigin.length)
    : value;
}

/** The request, or the reason it is refused. Reads and writes nothing. */
export function parseRetireUrlArguments(
  args: readonly string[],
): RetireUrlRequest | { refusal: string } {
  const [url, ...rest] = args;
  if (url === undefined || url.startsWith('--')) {
    return { refusal: 'the first word must be the URL to retire.' };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!retireUrlFlags.includes(flag)) {
      return { refusal: `${flag} is not a flag of retire-url.` };
    }
    if (values.has(flag)) {
      return { refusal: `${flag} is given twice.` };
    }
    if (value === undefined || value.startsWith('--')) {
      return { refusal: `${flag} needs a value.` };
    }
    values.set(flag, value);
  }
  const actor = values.get('--actor')?.trim() ?? '';
  if (actor.length === 0) {
    return {
      refusal:
        'every retirement needs --actor, the person who retires the URL. Nothing was written.',
    };
  }
  const to = values.get('--to');
  if (to === undefined) {
    return { refusal: '--to is required.' };
  }
  const path = sitePath(url);
  if (!servicePagePathPattern.test(path)) {
    return {
      refusal: `${url} is not a price page URL: it must be /prices/{service}/{country}.`,
    };
  }
  const hub = sitePath(to);
  if (!isHubPath(hub)) {
    return {
      refusal: `${to} is not a hub: it must be /prices/{service} or /prices/countries/{country}.`,
    };
  }
  return { path, to: hub, actor };
}

/** `YYYY-MM-DD` of the injected clock, in UTC. */
function dayOf(clock: { now(): Date }): string {
  return clock.now().toISOString().slice(0, 10);
}

export async function runRetireUrl(
  args: readonly string[],
  io: RetireUrlIo,
): Promise<number> {
  const refuse = (message: string) => {
    io.stderr(
      `price-index retire-url: refused: ${message}\nNothing was written.\n`,
    );
    return retireUrlExitCodes.refused;
  };
  const invalid = (message: string) => {
    io.stderr(`price-index retire-url: ${message}\nNothing was written.\n`);
    return retireUrlExitCodes.validationFailure;
  };

  const request = parseRetireUrlArguments(args);
  if ('refusal' in request) {
    io.stderr(
      `price-index retire-url: refused: ${request.refusal}\n${retireUrlUsage}`,
    );
    return retireUrlExitCodes.refused;
  }

  const { config, issues } = await loadConfig(io.root);
  if (config === undefined || issues.length > 0) {
    return invalid(`the configuration is invalid\n${formatIssues(issues)}`);
  }
  const dataIssues = await validateDataFiles(io.root, config);
  if (dataIssues.length > 0) {
    return invalid(`a data file is invalid\n${formatIssues(dataIssues)}`);
  }

  const ledgerPath = resolve(io.root, publishedUrlsFile);
  let ledger: PublishedUrlsFile | null;
  let latest;
  try {
    ledger = await readPublishedUrls(ledgerPath);
    latest = await createJsonFileStore({
      directory: resolve(io.root, priceIndexDataDirectory),
    }).readLatest();
  } catch (error) {
    if (error instanceof PriceStoreError) {
      return invalid(error.message);
    }
    throw error;
  }
  if (ledger === null) {
    return invalid(`${publishedUrlsFile} does not exist`);
  }
  if (
    !ledger.urls.some(
      (entry) => !isRetirement(entry) && entry.path === request.path,
    )
  ) {
    return refuse(
      `${request.path} was never published, so it is not in ${publishedUrlsFile}.`,
    );
  }
  if (
    ledger.urls.some(
      (entry) => isRetirement(entry) && entry.path === request.path,
    )
  ) {
    return refuse(`${request.path} is already retired.`);
  }

  // A retirement ends a URL's unavailable state; it never takes down a
  // live page (D-037 Q1).
  const pages = generatedPages(latest, config.catalogue, config.markets);
  if (pages.some((page) => page.path === request.path)) {
    return refuse(
      `${request.path} still publishes a page, so it cannot be retired. A URL is retired only once its data no longer makes a page.`,
    );
  }
  // The URL being retired is never a generated page, so the hubs the
  // current data makes are the hubs the site serves: the target must be one
  // of them, or the redirect would lead nowhere.
  const hubs = hubPaths(pages);
  if (!hubs.includes(request.to)) {
    return refuse(
      `${request.to} is not a hub the published data makes, so it cannot receive the redirect. Hubs now: ${hubs.length === 0 ? 'none' : hubs.join(', ')}.`,
    );
  }

  const entry: RetiredUrl = {
    kind: 'retired',
    path: request.path,
    to: request.to,
    actor: request.actor,
    retired_on: dayOf(io.clock),
  };
  try {
    await appendRetirement(ledgerPath, entry);
  } catch (error) {
    if (error instanceof PriceStoreError) {
      return invalid(error.message);
    }
    throw error;
  }
  io.stdout(
    `price-index retire-url: ${request.path} now answers 301 to ${request.to} (retired by ${request.actor} on ${entry.retired_on}). Wrote ${publishedUrlsFile}.\n`,
  );
  return retireUrlExitCodes.done;
}
