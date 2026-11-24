// E11.7-11: run before every build. The partner kit's content file must be
// well formed, every file it lists must exist under public/partners/kit/ as
// the image or PDF its name says, and the folder may hold nothing unlisted
// (founder decision 2, 2026-11-24). Any problem fails the build.
import { open, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import {
  parsePartnerKit,
  parsePartnerMessageTemplates,
  partnerKitFolder,
  validatePartnerKitFolder,
} from '../../src/server/partner/kit.ts';

const root = process.cwd();
const publicRoot = join(root, 'public');

async function listFiles(): Promise<readonly string[]> {
  const folder = join(publicRoot, partnerKitFolder);
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      relative(publicRoot, join(entry.parentPath, entry.name))
        .split(sep)
        .join('/'),
    );
}

async function readHead(path: string): Promise<Buffer | null> {
  const handle = await open(join(publicRoot, path)).catch(() => null);
  if (handle === null) return null;
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

parsePartnerMessageTemplates(
  JSON.parse(
    await readFile(
      join(root, 'src/content/partner-message-templates.json'),
      'utf8',
    ),
  ),
);
const kit = parsePartnerKit(
  JSON.parse(
    await readFile(join(root, 'src/content/partner-kit.json'), 'utf8'),
  ),
);
const problems = await validatePartnerKitFolder(kit, { listFiles, readHead });
if (problems.length > 0) {
  process.stderr.write(
    `The partner asset kit failed its checks:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`,
  );
  process.exit(1);
}
