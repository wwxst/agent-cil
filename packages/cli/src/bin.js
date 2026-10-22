#!/usr/bin/env node
import { runCli } from './main.js';

const controller = new AbortController();
const abortForSignal = name => {
  if (controller.signal.aborted) return;
  const error = new Error(name === 'SIGINT' ? 'Interrupted by SIGINT.' : 'Interrupted by SIGTERM.');
  error.name = 'AbortError';
  error.code = name;
  controller.abort(error);
};
const onSigint = () => abortForSignal('SIGINT');
const onSigterm = () => abortForSignal('SIGTERM');

process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-cil: ${message}\n`);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}
