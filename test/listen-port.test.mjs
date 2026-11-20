import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';

import {
  ephemeralPortStart,
  isWsl,
  parseExcludedPortRanges,
  parseListeningPorts,
  reserveListenPort,
  startAppServer,
  waitForConnections,
  windowsPortView,
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

test('a published port is ready only once it accepts connections', async () => {
  const port = await reserveListenPort();
  const server = createServer((socket) => socket.end());
  // The forward comes up a few checks after the wait starts.
  const listening = new Promise((resolve) =>
    globalThis.setTimeout(() => {
      server.listen(port, '127.0.0.1', resolve);
    }, 350),
  );
  try {
    await waitForConnections(port, { attempts: 50, label: 'late forward' });
    await listening;
    assert.equal(server.listening, true);
  } finally {
    await listening;
    server.close();
    await once(server, 'close');
  }
});

test('a published port that never accepts connections fails after its attempts', async () => {
  const port = await reserveListenPort();
  await assert.rejects(
    waitForConnections(port, { attempts: 3, label: 'dead forward' }),
    /dead forward refused 3 connection attempts\./u,
  );
});

// E11.6-11a, flake (c). On a WSL host the browser container reaches a test
// server through Windows, so a port Windows has reserved or already listens
// on is unusable even though it is free in WSL: the container is refused, or
// reaches the Windows process instead. Reservation must skip such ports.

test('a port Windows reserves or listens on is never reserved for a server the browser reaches', async () => {
  const ceiling = await ephemeralPortStart();
  const span = ceiling - 10_000;
  // Three ports free in WSL, drawn in this order by the injected random
  // source. Windows has reserved the first (an excluded range) and listens on
  // the second; before E11.6-11a either would have been handed out.
  const candidates = [];
  while (candidates.length < 3) {
    const port = await reserveListenPort({ windowsPorts: async () => null });
    if (!candidates.includes(port)) candidates.push(port);
  }
  const [reserved, listened, free] = candidates;
  const draws = candidates.map((port) => (port - 10_000 + 0.5) / span);
  const ranges = parseExcludedPortRanges(
    `     ${reserved}       ${reserved}      `,
  );
  const listeners = parseListeningPorts(
    `  TCP    127.0.0.1:${listened}        0.0.0.0:0              LISTENING       5708`,
  );
  let consulted = 0;
  const port = await reserveListenPort({
    random: () => draws.shift(),
    windowsPorts: async () => {
      consulted += 1;
      return (candidate) =>
        listeners.has(candidate) ||
        ranges.some(([start, end]) => candidate >= start && candidate <= end);
    },
  });
  assert.equal(port, free);
  // Windows is read once per reservation, not once per probe.
  assert.equal(consulted, 1);
});

test('with no Windows view, as off WSL, reservation is unchanged', async () => {
  const ceiling = await ephemeralPortStart();
  const port = await reserveListenPort({ windowsPorts: async () => null });
  const again = await reserveListenPort({
    random: () => (port - 10_000 + 0.5) / (ceiling - 10_000),
    windowsPorts: async () => null,
  });
  assert.equal(again, port);
});

test('Windows excluded port ranges are read from netsh output', () => {
  // As `netsh interface ipv4 show excludedportrange protocol=tcp` prints it
  // on this host on 2026-11-20, with CRLF line ends and the marker for an
  // administered exclusion.
  const output = [
    '',
    'Protocol tcp Port Exclusion Ranges',
    '',
    'Start Port    End Port      ',
    '----------    --------      ',
    '     48791       48890      ',
    '     50000       50059     *',
    '     60491       60590      ',
    '',
    '* - Administered port exclusions.',
    '',
  ].join('\r\n');
  assert.deepEqual(parseExcludedPortRanges(output), [
    [48791, 48890],
    [50000, 50059],
    [60491, 60590],
  ]);
});

test('Windows listening ports are read from netstat output in any language', () => {
  const output = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2244',
    '  TCP    127.0.0.1:15292        0.0.0.0:0              ABHÖREN         5708',
    '  TCP    127.0.0.1:20241        127.0.0.1:52011        ESTABLISHED     33432',
    '  TCP    [::]:3306              [::]:0                 LISTENING       8408',
    '  TCP    [::1]:30989            [::]:0                 LISTENING       36552',
    '  UDP    0.0.0.0:5353           *:*                                    1980',
    '',
  ].join('\r\n');
  assert.deepEqual(
    [...parseListeningPorts(output)].sort((a, b) => a - b),
    [135, 3306, 15292, 30989],
  );
});

test('on WSL the Windows view reads Windows itself; elsewhere there is none', async () => {
  const view = await windowsPortView();
  if (!isWsl()) {
    assert.equal(view, null);
    return;
  }
  assert.equal(typeof view, 'function');
  // Windows' RPC endpoint mapper always listens on 135.
  assert.equal(view(135), true);
});
