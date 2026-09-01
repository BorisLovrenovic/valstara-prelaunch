import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  readThemePreference,
  resolveTheme,
  themePreferenceKey,
  writeThemePreference,
} from '../src/islands/theme-toggle.ts';

function withLocalStorage<Result>(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  operation: () => Result,
): Result {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });

  try {
    return operation();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, 'localStorage');
    } else {
      Object.defineProperty(globalThis, 'localStorage', original);
    }
  }
}

test('the three stored-preference states resolve against the system theme', () => {
  assert.equal(resolveTheme(null, false), 'light');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('unsupported', true), 'dark');
});

test('the theme preference reads only supported values and fails safely', () => {
  for (const [stored, expected] of [
    ['dark', 'dark'],
    ['light', 'light'],
    ['unsupported', null],
    [null, null],
  ] as const) {
    assert.equal(
      withLocalStorage(
        {
          getItem(key) {
            assert.equal(key, themePreferenceKey);
            return stored;
          },
          setItem() {},
        },
        readThemePreference,
      ),
      expected,
    );
  }

  assert.equal(
    withLocalStorage(
      {
        getItem() {
          throw new Error('Storage unavailable.');
        },
        setItem() {},
      },
      readThemePreference,
    ),
    null,
  );
});

test('the theme preference writes only the allowlisted key', () => {
  const writes: [string, string][] = [];
  withLocalStorage(
    {
      getItem() {
        return null;
      },
      setItem(key, value) {
        writes.push([key, value]);
      },
    },
    () => writeThemePreference('dark'),
  );
  assert.deepEqual(writes, [[themePreferenceKey, 'dark']]);

  assert.doesNotThrow(() =>
    withLocalStorage(
      {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error('Storage unavailable.');
        },
      },
      () => writeThemePreference('light'),
    ),
  );
});

test('the storage allowlist contains exactly the theme preference entry', async () => {
  const policy: unknown = JSON.parse(
    await readFile(
      new URL('../scripts/ci/privacy-allowlist.json', import.meta.url),
      'utf8',
    ),
  );

  assert.ok(typeof policy === 'object' && policy !== null);
  assert.ok('themePreference' in policy);
  const themePreference = policy.themePreference;
  assert.ok(typeof themePreference === 'object' && themePreference !== null);
  assert.deepEqual(Object.keys(themePreference).sort(), [
    'pathPattern',
    'storageKey',
  ]);
  assert.equal(
    'storageKey' in themePreference ? themePreference.storageKey : undefined,
    themePreferenceKey,
  );
  assert.equal(
    'pathPattern' in themePreference ? themePreference.pathPattern : undefined,
    '^src/islands/theme-toggle\\.(?:ts|tsx|js|jsx)$',
  );
  assert.equal(
    Object.keys(policy).filter((key) => /storage|themePreference/iu.test(key))
      .length,
    1,
  );
});
