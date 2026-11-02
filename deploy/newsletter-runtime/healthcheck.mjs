/* Readiness probe, no credentials or body logging. AGPL-3.0. */
import {readFile} from 'node:fs/promises';
const {port} = JSON.parse(await readFile('/run/newsletter/config.json', 'utf8'));
try {
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {signal: AbortSignal.timeout(6000)});
  const body = await response.json();
  if (!response.ok || body.ready !== true || body.sending !== false || body.staffAccess !== false) process.exitCode = 1;
} catch { process.exitCode = 1; }
