// E11.7-11: the asset kit's files and videos as markup. The kit ships empty,
// so the dashboard and flyer suites only ever see the empty list; here the
// component is rendered through Vite's SSR loader and Astro's container with
// a planted kit too: a listed file is a same-origin download, a video a
// plain link, and an empty kit renders nothing at all.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';
import { experimental_AstroContainer } from 'astro/container';
import { createServer } from 'vite';

const componentPath = fileURLToPath(
  new URL('../src/components/partner-kit-downloads.astro', import.meta.url),
);
const presentationPath = fileURLToPath(
  new URL('../src/server/partner/kit-presentation.ts', import.meta.url),
);
const kitPath = fileURLToPath(
  new URL('../src/server/partner/kit.ts', import.meta.url),
);

let server;
let container;
let Downloads;
let presentKitDownloads;
let parsePartnerKit;

before(async () => {
  const config = await getViteConfig(
    { server: { middlewareMode: true }, logLevel: 'silent' },
    { logLevel: 'silent' },
  )({ mode: 'test', command: 'serve' });
  server = await createServer(config);
  Downloads = (await server.ssrLoadModule(componentPath)).default;
  ({ presentKitDownloads } = await server.ssrLoadModule(presentationPath));
  ({ parsePartnerKit } = await server.ssrLoadModule(kitPath));
  container = await experimental_AstroContainer.create();
});

after(async () => {
  await server?.close();
});

test('an empty kit renders nothing: no heading, no empty state', async () => {
  const html = await container.renderToString(Downloads, {
    props: { downloads: presentKitDownloads() },
  });
  assert.equal(html.replace(/<style[\s\S]*?<\/style>/gu, '').trim(), '');
});

test('a planted listed file renders as a same-origin download, and a video as a plain link', async () => {
  const kit = parsePartnerKit({
    _comment: 'planted',
    files: [
      {
        path: 'partners/kit/flyer.pdf',
        title: 'Printable flyer',
        sharingRight: 'Made by Valstara; partners may share it unchanged.',
      },
    ],
    videos: [{ title: 'How to share', url: 'https://videos.example/share' }],
  });
  const html = await container.renderToString(Downloads, {
    props: { downloads: presentKitDownloads(kit) },
  });
  assert.match(html, /data-kit-downloads/u);
  const anchors = [...html.matchAll(/<a\b([^>]*)>/gu)].map((match) => match[1]);
  assert.equal(anchors.length, 2);
  const file = anchors.find((attributes) =>
    attributes.includes('href="/partners/kit/flyer.pdf"'),
  );
  assert.ok(file, 'the file links to its same-origin path');
  assert.match(file, /\bdownload\b/u);
  const video = anchors.find((attributes) =>
    attributes.includes('href="https://videos.example/share"'),
  );
  assert.ok(video, 'the video is a plain link');
  assert.match(video, /rel="noopener noreferrer"/u);
  assert.doesNotMatch(video, /\bdownload\b/u);
  // Nothing in it loads anything on the page.
  assert.doesNotMatch(
    html,
    /<(?:iframe|img|video|audio|object|embed|script|link|source)\b/u,
  );
  assert.match(html, /Printable flyer/u);
  assert.match(html, /How to share/u);
});
