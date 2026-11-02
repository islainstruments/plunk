/* Fixed-destination TCP passthrough only; TLS stays end-to-end. AGPL-3.0. */
import {isIPv4, createConnection, createServer} from 'node:net';

// Operator-owned private IP configuration, never browser input or credentials.
const [clientIP, targetIP] = process.argv.slice(2);
if (process.argv.length !== 4 || !isIPv4(clientIP) || !isIPv4(targetIP)) {
  console.error('Two explicit IPv4 bindings required');
  process.exit(1);
}
const sockets = new Set();
const server = createServer({allowHalfOpen: false}, client => {
  if (client.remoteAddress !== clientIP || sockets.size >= 8) { client.destroy(); return; }
  const upstream = createConnection({host: targetIP, port: 5432});
  sockets.add(client); sockets.add(upstream);
  const deadline = setTimeout(() => { client.destroy(); upstream.destroy(); }, 3000);
  upstream.once('connect', () => { clearTimeout(deadline); client.pipe(upstream); upstream.pipe(client); });
  for (const socket of [client, upstream]) {
    socket.setTimeout(30000, () => { client.destroy(); upstream.destroy(); });
    socket.on('error', () => { client.destroy(); upstream.destroy(); });
    socket.on('close', () => { clearTimeout(deadline); sockets.delete(socket); client.destroy(); upstream.destroy(); });
  }
});
server.maxConnections = 4;
server.on('error', () => { console.error('Staff DB passthrough unavailable'); process.exitCode = 1; });
server.listen(4196, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => { process.exitCode = 0; });
});
