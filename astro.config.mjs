import { defineConfig } from 'astro/config';
import process from 'node:process';
import node from '@astrojs/node';

const coverageSourceMaps = process.env.COVERAGE_SOURCE_MAPS === '1';

export default defineConfig({
  adapter: node({ mode: 'standalone' }),
  output: 'server',
  // RFC 8058 mail clients do not send a browser Origin header. The equivalent
  // guard for every other write route lives in src/middleware.ts.
  security: { checkOrigin: false },
  vite: {
    build: {
      sourcemap: coverageSourceMaps,
    },
  },
});
