// E11.7-11: the asset kit's server side. Every QR code (PNG, SVG and the
// dashboard's download targets) decodes to exactly the partner's /r/{CODE}
// URL, through an independent decoder; the message templates are filled with
// the partner's own code and link and pass the partner copy rules; and the
// kit's content and folder validation refuses each listed failure.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import jsQR from 'jsqr';
import sharp from 'sharp';

import { partnerDashboardCopy } from '../src/copy/partner-dashboard.ts';
import {
  fillPartnerMessage,
  parsePartnerKit,
  parsePartnerMessageTemplates,
  partnerKit,
  partnerMessageTemplates,
  validatePartnerKitFolder,
  type PartnerKit,
} from '../src/server/partner/kit.ts';
import {
  presentKitDownloads,
  presentPartnerKit,
} from '../src/server/partner/kit-presentation.ts';
import {
  qrDownloads,
  qrMatrix,
  qrPng,
  qrSvg,
} from '../src/server/partner/qr.ts';

async function decode(image: Buffer): Promise<string | null> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (
    jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null
  );
}

function dataUri(uri: string, type: string): Buffer {
  const prefix = `data:${type};base64,`;
  assert.ok(uri.startsWith(prefix), `${uri.slice(0, 30)} is ${type}`);
  return Buffer.from(uri.slice(prefix.length), 'base64');
}

const activeRow = {
  status: 'active' as const,
  active_code: true,
  confirmed: 22,
  partner_type: 'creator',
};

test('every QR code decodes to exactly the partner /r/{CODE} URL', async () => {
  for (const code of ['ABCD', 'DASHBOARD2345', 'Z9Y8X7W6V5U4T3S2']) {
    const link = `https://valstara.com/r/${code}`;
    assert.equal(await decode(qrPng(link)), link, `PNG for ${code}`);
    assert.equal(await decode(Buffer.from(qrSvg(link))), link, `SVG ${code}`);
    const downloads = qrDownloads(link);
    assert.equal(await decode(dataUri(downloads.png, 'image/png')), link);
    assert.equal(await decode(dataUri(downloads.svg, 'image/svg+xml')), link);

    // The dashboard's kit carries the same codes for this partner only.
    const kit = presentPartnerKit({ ...activeRow, code }, 'bearer', true);
    assert.ok(kit);
    assert.equal(kit.link, link);
    assert.equal(await decode(dataUri(kit.qrPng, 'image/png')), link);
    assert.equal(await decode(dataUri(kit.qrSvg, 'image/svg+xml')), link);
    assert.equal(await decode(Buffer.from(kit.qr)), link, 'inline SVG');
  }
  // The decoder is not lenient: another partner's code reads as theirs.
  assert.notEqual(
    await decode(qrPng('https://valstara.com/r/OTHER1')),
    'https://valstara.com/r/ABCD',
  );
});

test('the QR images are well formed and self-contained', async () => {
  const link = 'https://valstara.com/r/ABCD1234';
  const png = qrPng(link);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, metadata.height);
  // Ten pixels a module, with the four-module quiet zone on each side.
  assert.equal(metadata.width, (qrMatrix(link).size + 8) * 10);
  const svg = qrSvg(link, 'QR code for "you" & <me>');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(
    svg,
    /aria-label="QR code for &quot;you&quot; &amp; &lt;me&gt;"/u,
  );
  // Nothing in it loads anything.
  assert.doesNotMatch(svg, /href|<image|<script|url\(/u);
  assert.throws(() => qrSvg('https://valstara.com/r/ä'), RangeError);
  assert.throws(() => qrSvg(''), RangeError);
});

test('templates are filled with the partner own code and link, exactly once each', () => {
  const partner = {
    code: 'DASHBOARD2345',
    link: 'https://valstara.com/r/DASHBOARD2345',
  };
  assert.ok(partnerMessageTemplates.length >= 1);
  for (const template of partnerMessageTemplates) {
    const filled = fillPartnerMessage(template, partner);
    assert.equal(filled.split(partner.link).length - 1, 1, template.id);
    // The code appears once on its own and once inside the link.
    assert.equal(filled.split(partner.code).length - 1, 2, template.id);
    assert.doesNotMatch(filled, /[{}]/u, `${template.id} is fully filled`);
  }
  const kit = presentPartnerKit(
    { ...activeRow, code: partner.code },
    'bearer',
    false,
  );
  assert.deepEqual(
    kit?.messages.map(({ body }) => body),
    partnerMessageTemplates.map((template) =>
      fillPartnerMessage(template, partner),
    ),
  );
  for (const broken of [
    'No placeholders here.',
    'Only {link} here.',
    '{link} {code} {code}',
    '{link} {code} {name}',
  ]) {
    assert.throws(
      () =>
        parsePartnerMessageTemplates({
          _comment: '',
          templates: [{ id: 'broken', title: 'Broken', body: broken }],
        }),
      /exactly once/u,
      broken,
    );
  }
});

test('the templates pass the copy rules: forbidden terms, banned partner words, no exclamation marks, sentence case, a commission disclosure and no reward figure', async () => {
  const forbidden = JSON.parse(
    await readFile('scripts/forbidden-copy.json', 'utf8'),
  ) as { entries: { term: string }[] };
  const terms = forbidden.entries.map(({ term }) => term);
  for (const banned of [
    'passive income',
    'unlimited',
    'financial freedom',
    'team',
    'downline',
  ]) {
    assert.ok(terms.includes(banned), `${banned} is scanned`);
  }
  for (const template of partnerMessageTemplates) {
    const text = `${template.title}\n${template.body}`;
    for (const term of terms) {
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${term}\\b`, 'iu'),
        `${template.id}: ${term}`,
      );
    }
    assert.doesNotMatch(text, /!/u, `${template.id}: no exclamation mark`);
    assert.match(template.title, /^[A-Z][^A-Z]*$/u, `${template.id} title`);
    // Figures and dates come from configuration, never from a template.
    assert.doesNotMatch(text, /\d|%/u, `${template.id}: no figure`);
    assert.match(template.body, /commission/u, `${template.id} discloses`);
  }
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = Buffer.from('%PDF-1.7\n');

function folder(files: Record<string, Buffer>) {
  return {
    async listFiles() {
      return Object.keys(files);
    },
    async readHead(path: string) {
      return files[path] ?? null;
    },
  };
}

function kitWith(files: unknown[], videos: unknown[] = []): PartnerKit {
  return parsePartnerKit({ _comment: '', files, videos });
}

const listed = {
  path: 'partners/kit/flyer.pdf',
  title: 'Printable flyer',
  sharingRight: 'Made by Valstara; partners may share it unchanged.',
};

test('the kit ships empty, and an empty kit renders no downloads', async () => {
  assert.deepEqual(partnerKit, { files: [], videos: [] });
  assert.equal(presentKitDownloads(), null);
  assert.equal(presentKitDownloads(kitWith([])), null);
  assert.equal(
    presentPartnerKit({ ...activeRow, code: 'ABCD' }, 'b', true)?.downloads,
    null,
  );
  assert.deepEqual(await validatePartnerKitFolder(partnerKit, folder({})), []);
});

test('a listed file that exists as its type passes and renders as a same-origin download', async () => {
  const kit = kitWith(
    [listed, { ...listed, path: 'partners/kit/banner.png', title: 'Banner' }],
    [{ title: 'How to share', url: 'https://www.youtube.com/watch?v=abc' }],
  );
  assert.deepEqual(
    await validatePartnerKitFolder(
      kit,
      folder({ 'partners/kit/flyer.pdf': pdf, 'partners/kit/banner.png': png }),
    ),
    [],
  );
  assert.deepEqual(presentKitDownloads(kit), {
    files: [
      {
        href: '/partners/kit/flyer.pdf',
        title: 'Printable flyer',
        kind: partnerDashboardCopy.kit.fileKind.pdf,
      },
      {
        href: '/partners/kit/banner.png',
        title: 'Banner',
        kind: partnerDashboardCopy.kit.fileKind.image,
      },
    ],
    videos: [
      { href: 'https://www.youtube.com/watch?v=abc', title: 'How to share' },
    ],
  });
});

test('a listed file that is missing, of another type or without a sharing right, and an unlisted file, each fail', async () => {
  const kit = kitWith([listed]);
  assert.deepEqual(await validatePartnerKitFolder(kit, folder({})), [
    'partners/kit/flyer.pdf is listed but missing.',
  ]);
  assert.deepEqual(
    await validatePartnerKitFolder(
      kit,
      folder({ 'partners/kit/flyer.pdf': png }),
    ),
    ['partners/kit/flyer.pdf is not a pdf file.'],
  );
  assert.deepEqual(
    await validatePartnerKitFolder(
      kitWith([]),
      folder({ 'partners/kit/stray.pdf': pdf, 'partners/kit/sub/x.png': png }),
    ),
    [
      'partners/kit/stray.pdf is in the kit folder but not listed.',
      'partners/kit/sub/x.png is in the kit folder but not listed.',
    ],
  );
  for (const sharingRight of [undefined, '', '   ', 7]) {
    const entry =
      sharingRight === undefined
        ? { path: listed.path, title: listed.title }
        : { ...listed, sharingRight };
    assert.throws(() => kitWith([entry]), /exactly|sharing right/u);
  }
  for (const path of [
    'partners/kit/page.html',
    'partners/kit/logo.svg',
    'partners/kit/movie.mp4',
    'partners/kit/../secret.pdf',
    'partners/other/flyer.pdf',
    'partners/kit/sub/flyer.pdf',
    '/partners/kit/flyer.pdf',
  ]) {
    assert.throws(() => kitWith([{ ...listed, path }]), /image or PDF/u, path);
  }
  assert.throws(() => kitWith([listed, listed]), /listed twice/u);
});

test('a video is a plain https link with nothing to embed', () => {
  for (const url of [
    'http://videos.example/a',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://user:pass@videos.example/a',
    'https://videos.example/a b',
    'videos.example/a',
  ]) {
    assert.throws(
      () => kitWith([], [{ title: 'Video', url }]),
      /video link/u,
      url,
    );
  }
  assert.throws(
    () =>
      kitWith([], [{ title: 'Video', url: 'https://v.example/', embed: true }]),
    /exactly/u,
  );
});

test('only a partner whose link credits signups gets a kit; the perk follows the flag', () => {
  for (const row of [
    { ...activeRow, status: 'paused' as const },
    { ...activeRow, active_code: false },
  ]) {
    assert.equal(presentPartnerKit({ ...row, code: 'ABCD' }, 'b', true), null);
  }
  const kit = presentPartnerKit(
    { ...activeRow, code: 'ABCD' },
    'bearer value',
    true,
  );
  assert.equal(kit?.flyerHref, '/partners/dashboard/flyer?t=bearer+value');
  // 22 confirmed referrals unlock 15% for friends signing up now, but the
  // flyer prints the creator's floor, 10% (D-069).
  assert.equal(
    kit?.perk,
    partnerDashboardCopy.flyer.perk('September 2027', 10),
  );
  assert.equal(
    presentPartnerKit(
      { ...activeRow, code: 'ABCD', partner_type: 'student_ambassador' },
      'b',
      true,
    )?.perk,
    partnerDashboardCopy.flyer.perk('September 2027', 15),
  );
  assert.equal(
    presentPartnerKit({ ...activeRow, code: 'ABCD' }, 'b', false)?.perk,
    null,
  );
});

test('the build-time check runs before every build and fails the build on a bad kit folder', async () => {
  const run = promisify(execFile);
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    packageJson.scripts.prebuild ?? '',
    /tsx scripts\/ci\/partner-kit-check\.ts/u,
  );

  const script = resolve('scripts/ci/partner-kit-check.ts');
  const tsx = resolve('node_modules/.bin/tsx');
  const root = await mkdtemp(join(tmpdir(), 'valstara-kit-'));
  try {
    await mkdir(join(root, 'src/content'), { recursive: true });
    await copyFile(
      'src/content/partner-message-templates.json',
      join(root, 'src/content/partner-message-templates.json'),
    );
    const content = (files: unknown[]) =>
      writeFile(
        join(root, 'src/content/partner-kit.json'),
        JSON.stringify({ _comment: '', files, videos: [] }),
      );
    await content([]);
    // No folder at all is an empty kit.
    await run(tsx, [script], { cwd: root });

    await mkdir(join(root, 'public/partners/kit'), { recursive: true });
    await writeFile(join(root, 'public/partners/kit/flyer.pdf'), pdf);
    await assert.rejects(run(tsx, [script], { cwd: root }), (error: Error) => {
      assert.match(
        String((error as Error & { stderr?: string }).stderr),
        /partners\/kit\/flyer\.pdf is in the kit folder but not listed/u,
      );
      return true;
    });
    await content([listed]);
    await run(tsx, [script], { cwd: root });
    await content([{ ...listed, sharingRight: '' }]);
    await assert.rejects(run(tsx, [script], { cwd: root }), /sharing right/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
