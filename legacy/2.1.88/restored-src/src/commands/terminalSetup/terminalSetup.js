import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const markerPath = join(
  process.env.AGENT_CIL_STATE_DIR ||
    process.env.XDG_STATE_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : join(homedir(), '.local', 'state')),
  'agent-cil',
  'terminal-usage.jsonl',
);

export function markBackslashReturnUsed() {
  void mkdir(dirname(markerPath), { recursive: true })
    .then(() => appendFile(markerPath, JSON.stringify({
      event: 'backslash-return-used',
      timestamp: new Date().toISOString(),
    }) + '\n', { encoding: 'utf8', mode: 0o600 }))
    .catch(() => {});
}
