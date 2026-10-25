import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

export default defineConfig({
  adapter: node({ mode: 'standalone' }),
  outDir: '../../../.astro/provider-showcase-fixture',
  publicDir: '../../../public',
  output: 'server',
});
