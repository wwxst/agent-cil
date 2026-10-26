/**
 * Node process adapter of CLI 2.1.304 killProcessTree() / getDescendantPids().
 *
 * Source: cli-2.1.304/modules/chunk-pp4ckfw0.js (bS, N, K1o, T).
 * On POSIX the original captures descendants via ps -A pid/ppid before
 * signaling the detached process group. Group-only SIGKILL cannot reach
 * a child that called setsid() / spawned detached:true.
 *
 * Keep PID enumeration bounded (the original uses 500 ms) and never trust
 * a process-name lookup, shell command, or an unverified user-supplied PID.
 * Windows keeps the original System32 taskkill /T path in the CLI adapter.
 */
import { spawn } from 'node:child_process';

const ENUMERATION_TIMEOUT_MS = 500;
const MAX_PS_OUTPUT_BYTES = 2 * 1024 * 1024;

async function descendantPids(rootPid) {
  let output = '';
  let snapshot;
  try {
    snapshot = spawn('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], {
      cwd: '/',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
  } catch {
    return new Set();
  }
  const done = await new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = valid => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!valid) {
        try { snapshot.kill('SIGKILL'); } catch {}
      }
      resolve(valid);
    };
    timer = setTimeout(() => finish(false), ENUMERATION_TIMEOUT_MS);
    snapshot.stdout?.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > MAX_PS_OUTPUT_BYTES) finish(false);
    });
    snapshot.once('error', () => finish(false));
    snapshot.once('close', code => finish(code === 0));
  });
  if (!done) return new Set();
  const childrenByParent = new Map();
  for (const line of output.split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!fields) continue;
    const pid = Number(fields[1]);
    const parent = Number(fields[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(pid);
    childrenByParent.set(parent, siblings);
  }
  const descendants = new Set();
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const pid of childrenByParent.get(parent) ?? []) {
      if (pid <= 1 || pid === rootPid || pid === process.pid || descendants.has(pid)) continue;
      descendants.add(pid);
      queue.push(pid);
    }
  }
  return descendants;
}

/** Capture actual live descendants BEFORE killing the process group. */
export async function killPosixProcessTree(pid, signalName = 'SIGKILL', { captureDescendants = true } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return new Set();
  const descendants = captureDescendants ? await descendantPids(pid) : new Set();
  try {
    process.kill(-pid, signalName);
  } catch {
    try { process.kill(pid, signalName); } catch {}
  }
  for (const descendant of descendants) {
    try { process.kill(descendant, signalName); } catch {}
  }
  return descendants;
}
