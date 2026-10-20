import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Linux's default when the range cannot be read. macOS's range starts higher
// (49152), so anything below this bound is outside it too.
const fallbackEphemeralStart = 32_768;
const lowestCandidate = 10_000;
const maximumProbes = 64;
const appServerStartAttempts = 3;
const appServerOutputLimit = 16_384;
// The Astro Node entry logs this once its own listen() succeeds, followed by
// the bound address (`http://127.0.0.1:<port>`, or `local: http://localhost:
// <port>` for a wildcard host).
const listeningMarker = 'Server listening on';

function listeningOn(output, port) {
  const index = output.lastIndexOf(listeningMarker);
  return index !== -1 && output.slice(index).includes(`:${port}`);
}

// The first port the kernel hands to outgoing connections. Any socket a test
// process opens (a database pool, a fetch, a WebSocket) takes its local port
// from this range, so a fixed listen port inside it can be taken at any moment.
export async function ephemeralPortStart() {
  try {
    const range = await readFile(
      '/proc/sys/net/ipv4/ip_local_port_range',
      'utf8',
    );
    const start = Number.parseInt(range.trim().split(/\s+/u)[0], 10);
    if (Number.isInteger(start) && start > lowestCandidate) return start;
  } catch {
    // Not Linux, or /proc is unavailable.
  }
  return fallbackEphemeralStart;
}

async function bindable(port) {
  const probe = createServer();
  probe.listen(port, '0.0.0.0');
  try {
    await Promise.race([
      once(probe, 'listening'),
      once(probe, 'error').then(([error]) => {
        throw error;
      }),
    ]);
  } catch (error) {
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') return false;
    throw error;
  }
  probe.close();
  await once(probe, 'close');
  return true;
}

// A port for a child server that must be given an explicit PORT (the app's
// validated configuration rejects 0). It lies below the ephemeral range, so no
// outgoing connection can occupy it, and it is confirmed free by binding it.
// A caller still retries on EADDRINUSE, because another explicit listener could
// bind it between this probe and the child's own bind.
export async function reserveListenPort() {
  const ceiling = await ephemeralPortStart();
  for (let probe = 0; probe < maximumProbes; probe += 1) {
    const port =
      lowestCandidate + Math.floor(Math.random() * (ceiling - lowestCandidate));
    if (await bindable(port)) return port;
  }
  throw new Error(
    `No free listen port below the ephemeral range after ${maximumProbes} probes.`,
  );
}

async function stop(child, exited) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  await exited;
}

// Starts the built app server (or another entry script) on a reserved port and
// resolves once the child has logged that it is listening on that port and
// `readyPath` answers 2xx. Readiness is never inferred from the port alone:
// after a lost bind race another process holds it, and probing it would reach
// that process instead. `env` is a function of the port, for
// values that embed the server's own origin. `ipc` opens a message channel for
// a child that reports back with process.send. Only a lost bind race (the child
// reports EADDRINUSE) is retried, on a fresh port; any other startup failure
// throws with the child's output, because it is a real defect.
export async function startAppServer({
  label,
  env,
  readyPath = '/',
  nodeArguments = [],
  entry = 'dist/server/entry.mjs',
  startupTimeoutMilliseconds = 30_000,
  ipc = false,
  cwd,
  reservePort = reserveListenPort,
}) {
  for (let attempt = 1; attempt <= appServerStartAttempts; attempt += 1) {
    const port = await reservePort();
    let output = '';
    let spawnError;
    const child = spawn(process.execPath, [...nodeArguments, entry], {
      cwd,
      env: { ...process.env, ...env(port), PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
    });
    const exited = once(child, 'exit');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const capture = (chunk) => {
      output = `${output}${chunk}`.slice(-appServerOutputLimit);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (error) => {
      spawnError = error;
    });

    const deadline = globalThis.performance.now() + startupTimeoutMilliseconds;
    let failure;
    while (failure === undefined) {
      if (spawnError !== undefined) {
        failure = new Error(
          `${label} server could not start: ${spawnError.message}`,
          { cause: spawnError },
        );
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        failure = new Error(
          `${label} server exited before startup.\n${output || '(no server output)'}`,
        );
        break;
      }
      // A bind failure can be logged without the process exiting.
      if (output.includes('EADDRINUSE')) {
        failure = new Error(
          `${label} server could not bind port ${port}.\n${output}`,
        );
        break;
      }
      if (listeningOn(output, port)) {
        try {
          const response = await globalThis.fetch(
            `http://127.0.0.1:${port}${readyPath}`,
            { signal: globalThis.AbortSignal.timeout(1_000) },
          );
          if (response.ok) {
            return {
              port,
              server: child,
              exited,
              output: () => output,
              stop: () => stop(child, exited),
            };
          }
        } catch {
          // The server may still be finishing startup.
        }
      }
      if (globalThis.performance.now() > deadline) {
        failure = new Error(
          `${label} server did not start within ${startupTimeoutMilliseconds / 1_000} seconds.\n${output || '(no server output)'}`,
        );
        break;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    }

    await stop(child, exited);
    if (!output.includes('EADDRINUSE') || attempt === appServerStartAttempts) {
      throw failure;
    }
  }
  throw new Error(`${label} server did not start.`);
}

// The host port Docker assigned to a container published with
// `--publish 127.0.0.1::<containerPort>`. Docker binds it atomically, so no
// fixed host port can collide with another socket.
export async function publishedPort(container, containerPort) {
  const { stdout } = await execFileAsync('docker', [
    'port',
    container,
    `${containerPort}/tcp`,
  ]);
  const port = /^127\.0\.0\.1:(\d+)\s*$/mu.exec(stdout)?.[1];
  if (port === undefined) {
    throw new Error(
      `Docker did not publish ${container}:${containerPort}: ${stdout}`,
    );
  }
  return Number(port);
}
