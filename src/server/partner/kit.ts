import kitDocument from '../../content/partner-kit.json' with { type: 'json' };
import templateDocument from '../../content/partner-message-templates.json' with { type: 'json' };

// E11.7-11: the partner asset kit's content. The message templates and the
// downloadable files and video links (P10) each live in one content file.
// The kit files ship empty (founder decision 2, 2026-11-24): the founder adds
// files and links later as a content change, and an empty list renders
// nothing. This module validates the content's shape wherever it loads;
// `validatePartnerKitFolder` adds the checks that need the file system and
// runs before every build (`scripts/ci/partner-kit-check.ts`).

export const partnerKitFolder = 'partners/kit';

/** The only file types the kit serves: images and PDFs, never markup. */
const kitTypes = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  pdf: 'pdf',
} as const;
type KitExtension = keyof typeof kitTypes;

const kitPath = new RegExp(
  `^${partnerKitFolder}/[a-z0-9][a-z0-9._-]*[.](${Object.keys(kitTypes).join('|')})$`,
  'u',
);
const titleMaxLength = 120;
const sharingRightMaxLength = 500;

export interface PartnerKitFile {
  readonly path: string;
  readonly title: string;
  readonly sharingRight: string;
  readonly kind: 'image' | 'pdf';
}

export interface PartnerKitVideo {
  readonly title: string;
  readonly url: string;
}

export interface PartnerKit {
  readonly files: readonly PartnerKitFile[];
  readonly videos: readonly PartnerKitVideo[];
}

export interface PartnerMessageTemplate {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export class PartnerKitContentError extends Error {}

function text(
  value: unknown,
  label: string,
  maxLength: number,
  lines = false,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value.length > maxLength ||
    (lines ? /(?!\n)\p{Cc}/u : /\p{Cc}/u).test(value)
  ) {
    throw new PartnerKitContentError(`The partner kit needs ${label}.`);
  }
  return value;
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PartnerKitContentError(`The partner kit needs a ${label} list.`);
  }
  return value;
}

function exactKeys(entry: unknown, keys: readonly string[], label: string) {
  if (
    typeof entry !== 'object' ||
    entry === null ||
    Array.isArray(entry) ||
    Object.keys(entry).sort().join() !== [...keys].sort().join()
  ) {
    throw new PartnerKitContentError(
      `Each partner kit ${label} has exactly ${keys.join(', ')}.`,
    );
  }
  return entry as Record<string, unknown>;
}

/** A video is a plain `https://` link: no credentials, nothing embedded. */
function videoUrl(value: unknown): string {
  const raw = text(value, 'a video link', 2_000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PartnerKitContentError('A partner kit video link is not a URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === '' ||
    url.href !== raw
  ) {
    throw new PartnerKitContentError(
      'A partner kit video link must be a plain https:// URL.',
    );
  }
  return raw;
}

/** Validates the shape of `src/content/partner-kit.json`. */
export function parsePartnerKit(value: unknown): PartnerKit {
  const document = exactKeys(
    value,
    ['_comment', 'files', 'videos'],
    'content file',
  );
  const paths = new Set<string>();
  const files = list(document.files, 'files').map((entry) => {
    const file = exactKeys(entry, ['path', 'title', 'sharingRight'], 'file');
    const path = text(file.path, 'a file path', 200);
    const match = kitPath.exec(path);
    if (match === null) {
      throw new PartnerKitContentError(
        `${path} is not an image or PDF directly under public/${partnerKitFolder}/.`,
      );
    }
    if (paths.has(path)) {
      throw new PartnerKitContentError(`${path} is listed twice.`);
    }
    paths.add(path);
    return {
      path,
      title: text(file.title, `a title for ${path}`, titleMaxLength),
      sharingRight: text(
        file.sharingRight,
        `a recorded sharing right for ${path}`,
        sharingRightMaxLength,
      ),
      kind: kitTypes[match[1] as KitExtension],
    };
  });
  const videos = list(document.videos, 'videos').map((entry) => {
    const video = exactKeys(entry, ['title', 'url'], 'video');
    return {
      title: text(video.title, 'a video title', titleMaxLength),
      url: videoUrl(video.url),
    };
  });
  return { files, videos };
}

const placeholder = /\{[^{}]*\}/gu;

/** Validates `src/content/partner-message-templates.json`. */
export function parsePartnerMessageTemplates(
  value: unknown,
): readonly PartnerMessageTemplate[] {
  const document = exactKeys(value, ['_comment', 'templates'], 'template file');
  const ids = new Set<string>();
  const templates = list(document.templates, 'templates').map((entry) => {
    const template = exactKeys(entry, ['id', 'title', 'body'], 'template');
    const id = text(template.id, 'a template id', 40);
    if (!/^[a-z][a-z-]*$/u.test(id) || ids.has(id)) {
      throw new PartnerKitContentError(`Template id ${id} is not unique.`);
    }
    ids.add(id);
    const body = text(template.body, `a body for ${id}`, 1_000, true);
    const found = [...body.matchAll(placeholder)].map((match) => match[0]);
    if (found.toSorted().join() !== '{code},{link}') {
      throw new PartnerKitContentError(
        `Template ${id} needs {link} and {code} exactly once each, and no other placeholder.`,
      );
    }
    return {
      id,
      title: text(template.title, `a title for ${id}`, titleMaxLength),
      body,
    };
  });
  if (templates.length === 0) {
    throw new PartnerKitContentError('The partner kit needs a template.');
  }
  return templates;
}

/** One template, filled with the partner's own code and link. */
export function fillPartnerMessage(
  template: PartnerMessageTemplate,
  partner: { readonly code: string; readonly link: string },
): string {
  return template.body.replace(placeholder, (name) =>
    name === '{code}' ? partner.code : partner.link,
  );
}

export const partnerKit = parsePartnerKit(kitDocument);
export const partnerMessageTemplates =
  parsePartnerMessageTemplates(templateDocument);

/** Whether the kit lists any file or video, so its section shows at all. */
export function hasKitDownloads(kit: PartnerKit): boolean {
  return kit.files.length > 0 || kit.videos.length > 0;
}

const signatures: Readonly<Record<KitExtension, (head: Buffer) => boolean>> = {
  png: (head) =>
    head
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  jpeg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  webp: (head) =>
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP',
  pdf: (head) => head.subarray(0, 5).toString('latin1') === '%PDF-',
};

export interface KitFolderAccess {
  /** Every file under `public/partners/kit/`, as `partners/kit/…`; none if absent. */
  listFiles(): Promise<readonly string[]>;
  /** The first bytes of a listed file, or null if it does not exist. */
  readHead(path: string): Promise<Buffer | null>;
}

/**
 * The build-time checks: every listed file exists and its bytes are the type
 * its name says, and nothing sits in the folder unlisted. Returns every
 * problem, so one run reports them all.
 */
export async function validatePartnerKitFolder(
  kit: PartnerKit,
  folder: KitFolderAccess,
): Promise<readonly string[]> {
  const problems: string[] = [];
  const listed = new Set(kit.files.map((file) => file.path));
  for (const file of kit.files) {
    const head = await folder.readHead(file.path);
    const extension = file.path.slice(
      file.path.lastIndexOf('.') + 1,
    ) as KitExtension;
    if (head === null) problems.push(`${file.path} is listed but missing.`);
    else if (!signatures[extension](head)) {
      problems.push(`${file.path} is not a ${extension} file.`);
    }
  }
  for (const path of await folder.listFiles()) {
    if (!listed.has(path)) {
      problems.push(`${path} is in the kit folder but not listed.`);
    }
  }
  return problems;
}
