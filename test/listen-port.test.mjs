import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';

import {
  ephemeralPortStart,
  reserveListenPort,
  startAppServer,
} from './helpers/listen-port.mjs';

// Under scripts/fixtures, like the other spawned server fixtures: `node --test`
// runs every .mjs file under test/ as a test file.
const fixtureEntry = 'scripts/fixtures/listen-port-server.mjs';

// Holds a port the way a foreign process would. It accepts connections and
// counts them, so a test can prove nothing probed it.
async function holdPort(port) {
  const sockets = new Set();
  const holder = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let accepted = 0;
  holder.on('connection', () => {
    accepted += 1;
  });
  holder.listen(port, '0.0.0.0');
  await once(holder, 'listening');
  return {
    accepted: () => accepted,
    async release() {
      for (const socket of sockets) socket.destroy();
      holder.close();
      await once(holder, 'close');
    },
  };
}

test('a reserved listen port lies below the ephemeral range and is bindable', async () => {
  const ceiling = await ephemeralPortStart();
  for (let sample = 0; sample < 20; sample += 1) {
    const port = await reserveListenPort();
    assert.ok(Number.isInteger(port));
    assert.ok(port >= 10_000 && port < ceiling, `${port} < ${ceiling}`);
    const holder = await holdPort(port);
    await holder.release();
  }
});

test('the ephemeral range start is read from the kernel where available', async () => {
  const start = await ephemeralPortStart();
  assert.ok(Number.isInteger(start) && start > 10_000 && start < 65_536);
});

test('the app server starts on a reserved port and receives that port in its environment', async () => {
  let seenPort;
  const app = await startAppServer({
    label: 'Fixture',
    entry: fixtureEntry,
    env: (port) => {
      seenPort = port;
      return { HOST: '127.0.0.1' };
    },
  });
  try {
    assert.equal(app.port, seenPort);
    assert.ok(app.port < (await ephemeralPortStart()));
    const response = await globalThis.fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(await response.text(), 'ready');
  } finally {
    await app.stop();
  }
  assert.notEqual(app.server.exitCode ?? app.server.signalCode, null);
});

test('a lost bind race is retried on a fresh port', async () => {
  const taken = await reserveListenPort();
  const holder = await holdPort(taken);
  const free = await reserveListenPort();
  const handedOut = [];
  try {
    const app = await startAppServer({
      label: 'Fixture',
      entry: fixtureEntry,
      env: () => ({ HOST: '0.0.0.0' }),
      reservePort: async () => {
        const port = handedOut.length === 0 ? taken : free;
        handedOut.push(port);
        return port;
      },
    });
    try {
      assert.deepEqual(handedOut, [taken, free]);
      assert.equal(app.port, free);
      // Readiness came from the child, never from probing the held port.
      assert.equal(holder.accepted(), 0);
    } finally {
      await app.stop();
    }
  } finally {
    await holder.release();
  }
});

test('a server that never reports listening is not taken for ready, even if its port answers', async () => {
  // A foreign HTTP server already answers 200 on the port, and the child never
  // logs that it bound it: probing the port alone would wrongly pass.
  const port = await reserveListenPort();
  const foreign = (await import('node:http')).createServer(
    (_request, response) => response.end('foreign'),
  );
  foreign.listen(port, '127.0.0.1');
  await once(foreign, 'listening');
  try {
    await assert.rejects(
      startAppServer({
        label: 'Fixture',
        entry: fixtureEntry,
        env: () => ({ LISTEN_PORT_FIXTURE_SILENT: '1', HOST: '0.0.0.0' }),
        reservePort: async () => port,
        startupTimeoutMilliseconds: 1_000,
      }),
      /Fixture server (?:did not start|exited before startup|could not bind)/u,
    );
  } finally {
    foreign.close();
    foreign.closeAllConnections();
    await once(foreign, 'close');
  }
});

test('a startup failure other than a bind race is not retried', async () => {
  let reservations = 0;
  await assert.rejects(
    startAppServer({
      label: 'Fixture',
      entry: fixtureEntry,
      env: () => ({ LISTEN_PORT_FIXTURE_CRASH: '1' }),
      reservePort: async () => {
        reservations += 1;
        return reserveListenPort();
      },
    }),
    /Fixture server exited before startup\.\nfixture configuration error/u,
  );
  assert.equal(reservations, 1);
});

test('repeated bind failures give up after three attempts with the server output', async () => {
  const taken = await reserveListenPort();
  const holder = await holdPort(taken);
  let reservations = 0;
  try {
    await assert.rejects(
      startAppServer({
        label: 'Fixture',
        entry: fixtureEntry,
        env: () => ({ HOST: '0.0.0.0' }),
        reservePort: async () => {
          reservations += 1;
          return taken;
        },
      }),
      /EADDRINUSE/u,
    );
    assert.equal(reservations, 3);
  } finally {
    await holder.release();
  }
});
