import { defineConfig } from 'astro/config';
import process from 'node:process';
import node from '@astrojs/node';

const coverageSourceMaps = process.env.COVERAGE_SOURCE_MAPS === '1';

export default defineConfig({
  adapter: node({ mode: 'standalone' }),
  output: 'server',
  vite: {
    build: {
      sourcemap: coverageSourceMaps,
    },
  },
});
