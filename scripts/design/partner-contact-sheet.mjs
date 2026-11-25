// E11.7-15: the partner programme's contact sheet, for the founder's
// sign-off. Every state the audit reads (test/helpers/partner-audit.mjs):
// each new route and each changed surface, over the programme the local
// seed writes (scripts/seed-partner-programme.ts), at every design width in
// both themes, at rest, captured through E11.5-01's `captureContactSheet`,
// which also runs the layout checks on every capture. Then every new and
// changed email, rendered from the same seeded database through the dispatch
// path (test/helpers/partner-emails.ts):
//
//   node --import tsx scripts/design/partner-contact-sheet.mjs
//
// A form POST's state is the page the app answers that POST with, served at
// its URL, as the full contact sheet does. Self-contained: it builds what it
// serves, migrates and seeds its own database, starts the pinned Playwright
// container, and removes all of them again. The output is git-ignored and is
// never committed.
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPool } from '../../src/server/db/pool.ts';
import { referralLadderCopy } from '../../src/copy/referral-ladder.ts';
import { reserveListenPort } from '../../test/helpers/listen-port.mjs';
import {
  flagPhases,
  partnerAuditStates,
  partnerAuditTokenSecret,
  startPartnerAuditServer,
} from '../../test/helpers/partner-audit.mjs';
import { renderAuditedEmails } from '../../test/helpers/partner-emails.ts';
import { captureContactSheet } from './contact-sheet.mjs';
import {
  startBrowserServer,
  waitForBrowserReach,
} from './full-contact-sheet.mjs';
import { designThemes, designWidths } from './layout-checks.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const outputDirectory = '.design-contact-sheets/e11-7-15';

// The local-only values `npm test` gives every suite (package.json).
const localEnvironment = Object.freeze({
  RESEND_WEBHOOK_SECRET: 'whsec_bG9jYWwtb25seS1yZXNlbmQtd2ViaG9vay1rZXk=',
  BREVO_WEBHOOK_TOKEN: 'local-only-brevo-webhook-token-32-chars',
  EMAIL_TOKEN_SECRET: 'local-only-email-token-secret-32-chars',
  EMAIL_BASE_URL: 'http://localhost:4321',
});

const clockStart = () => process.hrtime.bigint();
const secondsSince = (start) =>
  Number(process.hrtime.bigint() - start) / 1_000_000_000;

// Turnstile's loader is answered with an empty script: at rest no form has
// asked for a check, and the widget is Cloudflare's to draw.
const quietTurnstile = (context) =>
  context.route('https://challenges.cloudflare.com/**', (route) =>
    route
      .fulfill({ contentType: 'text/javascript', body: '' })
      .catch(() => undefined),
  );

/** A sheet entry for one audit state, its POST page served at its URL. */
function sheetEntry(state, document, origin) {
  const target = new URL(state.path, origin).href;
  return {
    kind: state.covers,
    route: state.path,
    state: state.state,
    ...(document === null
      ? state.status === undefined
        ? {}
        : { status: state.status }
      : { status: document.status }),
    async setup(context) {
      await quietTurnstile(context);
      // Every request to the app is fetched and fulfilled, so Chromium's
      // Private Network Access check lets the served page's stylesheet load.
      if (document !== null)
        await context.route(`${origin}/**`, async (route) => {
          try {
            if (
              route.request().isNavigationRequest() &&
              route.request().url() === target
            )
              return await route.fulfill({
                status: document.status,
                contentType: 'text/html; charset=utf-8',
                body: document.html,
              });
            return await route.fulfill({ response: await route.fetch() });
          } catch {
            // The context closed while this request was in flight.
            return undefined;
          }
        });
    },
  };
}

/**
 * One rendered email per audited template, and for the welcome both the
 * partner-referred friend's (with the perk line) and a member-referred one.
 */
function chooseEmails(rendered) {
  const chosen = new Map();
  for (const { row, message } of rendered) {
    let label = row.template;
    if (row.template === 'welcome')
      label = message.text.includes(referralLadderCopy.partnerWelcome.named)
        ? 'welcome-partner-referred'
        : 'welcome-member';
    if (!chosen.has(label)) chosen.set(label, message);
  }
  return chosen;
}

async function captureEmails(endpoint, directory, emails) {
  const htmlDirectory = join(directory, 'html');
  await mkdir(htmlDirectory, { recursive: true });
  for (const [label, message] of emails) {
    if (message.html === undefined)
      throw new Error(`${label} has no HTML part.`);
    await writeFile(join(htmlDirectory, `${label}.html`), message.html);
    await writeFile(join(htmlDirectory, `${label}.txt`), message.text);
  }
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://host').pathname.slice(1);
    if (!/^[a-z0-9_-]+\.html$/u.test(name))
      return response.writeHead(404).end();
    try {
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(await readFile(join(htmlDirectory, name)));
    } catch {
      response.writeHead(404).end();
    }
  });
  // A reserved port the browser container reaches through
  // host.docker.internal (docs/testing/strategy.md#c-the-browser-container-cannot-reach-the-app).
  server.listen(await reserveListenPort(), '0.0.0.0');
  await once(server, 'listening');
  const origin = `http://host.docker.internal:${server.address().port}`;
  try {
    const entries = [...emails.keys()].map((label) => ({
      kind: 'email',
      route: `/${label}.html`,
      state: `email-${label}`,
    }));
    await waitForBrowserReach(endpoint, `${origin}${entries[0].route}`);
    return await captureContactSheet({
      origin,
      output: directory,
      browserEndpoint: endpoint,
      entries,
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function main() {
  for (const [key, value] of Object.entries(localEnvironment))
    process.env[key] ??= value;
  const started = clockStart();
  const cleanups = [];
  const cleanUp = async () => {
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()();
      } catch (error) {
        process.stderr.write(`cleanup: ${error?.message ?? error}\n`);
      }
    }
  };
  process.once('SIGINT', () => void cleanUp().finally(() => process.exit(130)));
  process.once(
    'SIGTERM',
    () => void cleanUp().finally(() => process.exit(143)),
  );
  let failed = true;
  try {
    process.stdout.write('Building, migrating and seeding…\n');
    const server = await startPartnerAuditServer({
      label: 'Partner contact sheet',
      host: '0.0.0.0',
    });
    cleanups.push(() => server.dispose());
    const states = partnerAuditStates(server.manifest);
    const browserServer = await startBrowserServer(
      `valstara-e11-7-15-contact-sheet-${process.pid}`,
    );
    cleanups.push(() => browserServer.stop());
    const origin = `http://host.docker.internal:${server.port}`;
    await waitForBrowserReach(browserServer.endpoint, `${origin}/partners`);

    const directory = resolve(root, outputDirectory);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const pages = [];
    for (const [index, phase] of flagPhases(states).entries()) {
      await server.setFlags({ 'partners.enabled': true, ...phase.flags });
      const entries = [];
      for (const state of phase.states)
        entries.push(
          sheetEntry(
            state,
            state.post ? await server.document(state) : null,
            origin,
          ),
        );
      pages.push(
        ...(await captureContactSheet({
          origin,
          browserEndpoint: browserServer.endpoint,
          output: join(directory, index === 0 ? 'pages' : 'programme-paused'),
          entries,
        })),
      );
    }
    await server.setFlags({ 'partners.enabled': true });

    // The emails, from the same seeded database, through the dispatch path.
    const database = createPool(server.databaseUrl);
    cleanups.push(() => database.close());
    const emails = chooseEmails(
      await renderAuditedEmails(database, {
        baseUrl: server.local,
        tokenSecret: partnerAuditTokenSecret,
        actor: 'founder:e11-7-15-contact-sheet',
      }),
    );
    const emailCaptures = await captureEmails(
      browserServer.endpoint,
      join(directory, 'emails'),
      emails,
    );

    const all = [
      ...pages.map((capture) => ({ ...capture, kind: 'page' })),
      ...emailCaptures.map((capture) => ({ ...capture, kind: 'email' })),
    ];
    // An email is not a site page: it has no site container grid, so that
    // one rule does not apply to it (as on the full contact sheet).
    const layoutIssues = all
      .map((item) => ({
        ...item,
        layoutIssues:
          item.kind === 'email'
            ? item.layoutIssues.filter(
                (issue) => !issue.includes('missing design container'),
              )
            : item.layoutIssues,
      }))
      .filter((item) => item.layoutIssues.length > 0);
    const summary = {
      ticket: 'E11.7-15',
      wallTimeSeconds: Math.round(secondsSince(started)),
      widths: designWidths,
      themes: designThemes,
      states: states.map(({ state, covers, path, flags, post }) => ({
        state,
        covers,
        route: path.replace(/([?&](?:t|token)=)[^&]+/u, '$1…'),
        ...(flags ? { flags } : {}),
        ...(post ? { post: true } : {}),
      })),
      emails: [...emails.keys()],
      pageCaptures: pages.length,
      emailCaptures: emailCaptures.length,
      totalCaptures: all.length,
      layoutIssues: layoutIssues.map(
        ({ state, width, theme, layoutIssues: found }) => ({
          state,
          width,
          theme,
          issues: found,
        }),
      ),
    };
    await writeFile(
      join(directory, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    process.stdout.write(
      `${summary.totalCaptures} captures (${summary.pageCaptures} pages, ${summary.emailCaptures} emails), ${summary.layoutIssues.length} with layout issues: ${outputDirectory}/summary.json\n`,
    );
    failed = layoutIssues.length > 0;
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
  } finally {
    await cleanUp();
  }
  process.exitCode = failed ? 1 : 0;
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  import.meta.url === pathToFileURL(resolve(invoked)).href
)
  await main();
