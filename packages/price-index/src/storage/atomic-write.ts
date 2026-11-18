import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Atomic file writes (E11.6-03). The data goes to a temporary file in the
// same directory, is flushed to disk, and only then takes the target's name,
// so a crash at any point leaves either the old file or the new one, never a
// half-written one.

/** The file-system calls a write makes, injectable so a test can fail one. */
export interface AtomicWriteFs {
  open: typeof nodeFs.open;
  rename: typeof nodeFs.rename;
  link: typeof nodeFs.link;
  unlink: typeof nodeFs.unlink;
}

export interface AtomicWriteOptions {
  /**
   * `replace` renames over an existing target. `create` links the new file
   * into place, which fails with `EEXIST` if the target exists, so an
   * existing file is never replaced, even by a writer racing this one.
   */
  mode: 'replace' | 'create';
  fs?: AtomicWriteFs;
}

let temporaryCounter = 0;

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** Writes `content` to a fresh temporary file beside `target`, flushed. */
async function writeTemporary(
  target: string,
  content: string,
  fs: AtomicWriteFs,
): Promise<string> {
  // A process id and a counter, never randomness: the name only has to be
  // unused, and `wx` refuses one that is not.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    temporaryCounter += 1;
    const temporary = join(
      dirname(target),
      `.${basename(target)}.${process.pid}-${temporaryCounter}.tmp`,
    );
    let handle: nodeFs.FileHandle;
    try {
      handle = await fs.open(temporary, 'wx');
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        continue;
      }
      throw error;
    }
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return temporary;
  }
  throw new Error(`no free temporary name beside ${target}`);
}

/**
 * Writes `content` to `target` atomically. In `create` mode it fails with an
 * `EEXIST` error, leaving the existing file untouched, if `target` exists.
 */
export async function writeFileAtomic(
  target: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const temporary = await writeTemporary(target, content, fs);
  try {
    if (options.mode === 'replace') {
      await fs.rename(temporary, target);
    } else {
      await fs.link(temporary, target);
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  if (options.mode === 'create') {
    // The target is in place; the temporary name is only a second link to it.
    await fs.unlink(temporary);
  }
}
