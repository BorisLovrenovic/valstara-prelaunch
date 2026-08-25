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
