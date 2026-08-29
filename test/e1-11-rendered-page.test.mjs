import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';

const executeFile = promisify(execFile);

function startServer() {
  const port = 43_220;
  const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });

  return { port, server };
}

async function waitForPage(port, pathname) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}${pathname}`,
      );
      if (response.ok) {
        return response;
      }
    } catch {
      // The standalone server has not started yet.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }

  throw new Error('Rendered-page test server did not start.');
}

test('the rendered E1-11 signup and verification pages set no cookie', async () => {
  await executeFile('npm', ['run', 'build']);
  const { port, server } = startServer();

  try {
    const signup = await waitForPage(port, '/');
    const verification = await waitForPage(port, '/verify?token=missing');
    assert.equal(signup.headers.get('set-cookie'), null);
    assert.equal(verification.headers.get('set-cookie'), null);
    assert.match(
      await signup.text(),
      /<form action="\/api\/signup" method="post">/u,
    );
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
});
