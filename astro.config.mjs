import { defineConfig } from 'astro/config';
import process from 'node:process';
import node from '@astrojs/node';

const coverageSourceMaps = process.env.COVERAGE_SOURCE_MAPS === '1';

const leaderboardIslandScript =
  /(?:^|\/)Leaderboard\.astro_astro_type_script_index_\d+_lang\.[\w-]+\.js$/u;

// The leaderboard island always ships inline on /leaderboard, so the rendered
// route itself shows the three islands and no fourth (ADR-001, E6-02). Left to
// Vite's 4 KB default, the choice would follow the script's size, and a
// source-mapped coverage build would emit it as a separate file. Returning
// undefined keeps Vite's default for every other asset, script and stylesheet.
export function assetsInlineLimit(filePath) {
  return leaderboardIslandScript.test(filePath) ? true : undefined;
}

export default defineConfig({
  adapter: node({ mode: 'standalone' }),
  output: 'server',
  // RFC 8058 mail clients do not send a browser Origin header. The equivalent
  // guard for every other write route lives in src/middleware.ts.
  security: {
    checkOrigin: false,
    // The Node adapter accepts X-Forwarded-For only for an allowed Host. Caddy
    // is the sole production path to this backend and forwards this Host.
    allowedDomains: [{ hostname: 'valstara.com' }],
  },
  vite: {
    build: {
      sourcemap: coverageSourceMaps,
      assetsInlineLimit,
    },
  },
});
