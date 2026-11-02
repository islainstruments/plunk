/* Dedicated staging entry point; never starts upstream app or worker. AGPL-3.0. */
import {fileURLToPath} from 'node:url';

import {startRuntime} from './NewsletterRuntime.js';

async function main() {
  if (process.argv.length !== 3) throw new Error('One private config path required');
  const running = await startRuntime(process.argv[2]!, fileURLToPath(new URL('./release.json', import.meta.url)));
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    void running.close().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log('Newsletter locked staging listening; sending=false');
}
void main().catch(() => {
  // Deliberately omit errors/config/connection strings from operational logs.
  console.error('Newsletter staging startup failed; check private configuration');
  process.exitCode = 1;
});
