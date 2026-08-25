/**
 * Container liveness probe: is the database reachable and is the app serving?
 *
 * This deliberately does NOT prove authentication. The app image carries no
 * PostgreSQL client and the connection pool is E1-03's, so a socket open is the
 * honest limit of what can be checked here.
 *
 * Authentication with this container's real DATABASE_URL — plus the red-path
 * case proving wrong credentials are rejected — lives in ./assert-stack.mjs and
 * is what satisfies E1-02's first acceptance criterion. Do not read a healthy
 * container as evidence that its credentials work.
 */
import net from 'node:net';
import process from 'node:process';
import { URL } from 'node:url';

const databaseUrl = new URL(process.env.DATABASE_URL);

await new Promise((resolve, reject) => {
  const socket = net.createConnection({
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 5432),
  });

  socket.setTimeout(2_000);
  socket.once('connect', () => {
    socket.destroy();
    resolve();
  });
  socket.once('error', reject);
  socket.once('timeout', () => {
    socket.destroy();
    reject(new Error('database connection timed out'));
  });
});

const response = await globalThis.fetch('http://127.0.0.1:4321/');

if (!response.ok) {
  throw new Error(`application health endpoint returned ${response.status}`);
}
