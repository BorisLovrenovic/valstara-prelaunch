import node from '@astrojs/node';
import { defineConfig } from 'astro/config';
import process from 'node:process';

const coverageSourceMaps = process.env.COVERAGE_SOURCE_MAPS === '1';

export default defineConfig({
  adapter: node({ mode: 'standalone' }),
  outDir: '../../../.astro/provider-showcase-fixture',
  publicDir: '../../../public',
  output: 'server',
  vite: {
    build: {
      sourcemap: coverageSourceMaps,
    },
  },
});
