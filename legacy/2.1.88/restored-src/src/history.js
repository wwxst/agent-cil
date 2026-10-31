import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const stateHome = process.env.AGENT_CIL_STATE_DIR ||
  process.env.XDG_STATE_HOME ||
  (process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : join(homedir(), '.local', 'state'));
const historyPath = process.env.AGENT_CIL_HISTORY_FILE ||
  join(stateHome, 'agent-cil', 'prompt-history.jsonl');

let writeQueue = Promise.resolve();

export function addToHistory(entry) {
  const command = typeof entry === 'string'
    ? entry
    : String(entry?.command ?? entry?.text ?? entry?.input ?? '');
  if (!command.trim()) return;
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(historyPath), { recursive: true });
    await appendFile(historyPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      command,
    }) + '\n', { encoding: 'utf8', mode: 0o600 });
  }).catch(() => {});
}

export async function loadPromptHistory({ limit = 100 } = {}) {
  await writeQueue;
  try {
    const content = await readFile(historyPath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try {
        const item = JSON.parse(line);
        return typeof item.command === 'string' && item.command.trim()
          ? [item.command]
          : [];
      } catch {
        return [];
      }
    }).slice(-Math.max(0, limit));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function flushPromptHistory() {
  await writeQueue;
}
