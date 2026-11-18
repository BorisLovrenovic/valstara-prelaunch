import { chromium } from 'playwright';

import { runCli } from '../../packages/price-index/src/cli/main.ts';
import { createPlaywrightDriver } from '../../packages/price-index/src/http/playwright-driver.ts';

// The price-index CLI as a child process, pointed at a fake source
// (E11.6-07, test/price-index/cli-exit.test.ts). It is main.ts's own entry
// with two things swapped, both only for this test: pages load from the
// fake server's origin instead of the source's, and the browser is the test
// container's Chromium, reached over a connection, instead of one launched
// here. The clock, the random source, the SIGINT and SIGTERM handling and
// the way the process ends (process.exitCode, never process.exit) are
// main.ts's own. The tool itself reads neither variable.
//
// node --test discovers every file under test/, so run bare (without both
// variables) it does nothing.

const origin = process.env.PRICE_INDEX_CHILD_ORIGIN;
const endpoint = process.env.PRICE_INDEX_CHILD_BROWSER;

if (origin !== undefined && endpoint !== undefined) {
  process.exitCode = await runCli(process.argv.slice(2), {
    root: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    scrape: {
      origin,
      openBrowser: async (settings, pageOrigin) => {
        const browser = await chromium.connect(endpoint);
        const driver = await createPlaywrightDriver({
          browser,
          origin: pageOrigin,
          pageTimeoutMilliseconds: settings.page_timeout_seconds * 1000,
          checkpointWaitMilliseconds: settings.checkpoint_wait_seconds * 1000,
        });
        return {
          driver,
          async close() {
            try {
              await driver.close();
            } finally {
              await browser.close();
            }
          },
        };
      },
    },
  });
}
