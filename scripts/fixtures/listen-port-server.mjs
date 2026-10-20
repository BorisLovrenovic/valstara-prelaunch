// A stand-in for the built app server: binds PORT on HOST, logs that it is
// listening, answers 200, and on a bind failure logs the error and exits, as
// the Astro Node entry does. LISTEN_PORT_FIXTURE_SILENT suppresses the listening line.
import { createServer } from 'node:http';

if (process.env.LISTEN_PORT_FIXTURE_CRASH === '1') {
  console.error('fixture configuration error');
  process.exit(1);
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('ready');
});
server.on('error', (error) => {
  console.error(`Error: listen ${error.code}: ${error.message}`);
  process.exit(1);
});
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT);
server.listen(port, host, () => {
  if (process.env.LISTEN_PORT_FIXTURE_SILENT !== '1') {
    console.log(`Server listening on http://${host}:${port}`);
  }
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
