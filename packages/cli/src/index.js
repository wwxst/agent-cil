#!/usr/bin/env node
import { stat, readdir, mkdir, realpath, lstat, open } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { applyPermissionUpdates } from '../../runtime/src/legacy-permissions/permission-update.js';

const VERSION = '0.1.0';
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_WALK_FILES = 5000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.cache']);
const BACKSLASH = String.fromCharCode(92);
const REGEX_META = new Set(['.', '+', '^', '$', '(', ')', '|', '[', ']', '{', '}', BACKSLASH]);

export const HELP = [
  'agent-cil ' + VERSION,
  '',
  'Usage:',
  '  agent-cil [options] [prompt]',
  '  agent-cil --print [options] [prompt]',
  '  agent-cil --version',
  '',
  'Options:',
  '  -h, --help              Show help',
  '  -v, -V, --version       Show version',
  '  -p, --print             Run one prompt and print only the assistant response',
  '      --model <name>      Anthropic model (default: ANTHROPIC_MODEL or claude-sonnet-4-5)',
  '      --base-url <url>    Messages API base URL (default: ANTHROPIC_BASE_URL or https://api.anthropic.com)',
  '      --max-tokens <n>    Maximum output tokens (default: 4096)',
  '      --max-turns <n>     Maximum model rounds per prompt (default: 8)',
  '      --max-retries <n>   HTTP retries before streaming (default: 2, max: 5)',
  '      --allow-edits       Explicitly allow workspace Write/Edit without prompts (Bash still asks)',
  '      --system <text>     System prompt',
  '      --cwd <path>        Workspace directory (default: current directory)',
  '',
  'Environment:',
  '  ANTHROPIC_API_KEY       Required for model requests',
  '  ANTHROPIC_MODEL         Default model name',
  '  ANTHROPIC_BASE_URL      Optional API-compatible endpoint',
  '',
  'Built-in tools:',
  '  Read, Glob, Grep       Read-only workspace tools',
  '  Write, Edit, Bash      Require interactive approval before execution',
  '',
  'This first CLI slice uses the repository AgentLoop and Messages API adapter.',
  'It does not yet implement the full official CLI configuration, OAuth, MCP, or resume contract.',
].join('\n') + '\n';

export class CliArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('argv must be an array of strings.');
  }
  if (argv.length === 1 && ['--version', '-v', '-V'].includes(argv[0])) {
    return { mode: 'version' };
  }
  if (argv.includes('--help') || argv.includes('-h')) return { mode: 'help' };

  const options = {
    mode: 'run',
    print: false,
    model: undefined,
    baseUrl: undefined,
    maxTokens: 4096,
    maxTurns: 8,
    maxRetries: 2,
    allowEdits: false,
    system: undefined,
    cwd: process.cwd(),
    positional: [],
  };

  const takeValue = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliArgumentError(name + ' requires a value.');
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--print' || arg === '-p') {
      options.print = true;
    } else if (arg === '--allow-edits') {
      options.allowEdits = true;
    } else if (arg === '--model') {
      options.model = takeValue(arg, i++);
    } else if (arg.startsWith('--model=')) {
      options.model = arg.slice('--model='.length);
    } else if (arg === '--base-url') {
      options.baseUrl = takeValue(arg, i++);
    } else if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--max-tokens') {
      options.maxTokens = Number(takeValue(arg, i++));
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 200000) {
        throw new CliArgumentError('--max-tokens must be an integer between 1 and 200000.');
      }
    } else if (arg.startsWith('--max-tokens=')) {
      options.maxTokens = Number(arg.slice('--max-tokens='.length));
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 200000) {
        throw new CliArgumentError('--max-tokens must be an integer between 1 and 200000.');
      }
    } else if (arg === '--max-turns' || arg.startsWith('--max-turns=')) {
      const raw = arg === '--max-turns' ? takeValue(arg, i++) : arg.slice('--max-turns='.length);
      options.maxTurns = Number(raw);
      if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 100) {
        throw new CliArgumentError('--max-turns must be an integer between 1 and 100.');
      }
    } else if (arg === '--max-retries' || arg.startsWith('--max-retries=')) {
      const raw = arg === '--max-retries' ? takeValue(arg, i++) : arg.slice('--max-retries='.length);
      options.maxRetries = Number(raw);
      if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 5) {
        throw new CliArgumentError('--max-retries must be an integer between 0 and 5.');
      }
    } else if (arg === '--system') {
      options.system = takeValue(arg, i++);
    } else if (arg.startsWith('--system=')) {
      options.system = arg.slice('--system='.length);
    } else if (arg === '--cwd') {
      options.cwd = takeValue(arg, i++);
    } else if (arg.startsWith('--cwd=')) {
      options.cwd = arg.slice('--cwd='.length);
    } else if (arg.startsWith('-')) {
      throw new CliArgumentError('Unknown option: ' + arg);
    } else {
      options.positional.push(arg);
    }
  }

  options.cwd = resolve(options.cwd);
  options.prompt = options.positional.join(' ').trim();
  return options;
}

export function resolveWorkspacePath(workspace, candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new TypeError('file_path must be a non-empty string.');
  }
  const root = resolve(workspace);
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('Path escapes the workspace: ' + candidate);
  }
  return target;
}

async function assertPathWithinWorkspace(workspace, target) {
  try {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink()) throw new Error('Symbolic links are not allowed for file tools: ' + target);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
  }
  const rootReal = await realpath(workspace);
  let probe = target;
  while (true) {
    try {
      const resolvedProbe = await realpath(probe);
      const rel = relative(rootReal, resolvedProbe);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
        throw new Error('Path resolves outside the workspace: ' + target);
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        const parent = dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      } else {
        throw error;
      }
    }
  }
}


/**
 * Build the CLI's permission policy. File writes and edits are checked against
 * the workspace before prompting; the Runtime repeats this check if a policy
 * or approval handler changes the effective input.
 */
/**
 * The legacy 2.1.88 permission update operation is now the source of the
 * opt-in acceptEdits mode; no special-case bypass in the approval handler.
 * Additional rule persistence stays disabled until the original dependency
 * closure is runnable and independently verified.
 */
export function createCliPermissionContext({ allowEdits = false } = {}) {
  return applyPermissionUpdates({
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  }, allowEdits ? [{ type: 'setMode', destination: 'cliArg', mode: 'acceptEdits' }] : []);
}

export function createCliPermissionPolicy({
  workspace = process.cwd(),
  permissionContext = createCliPermissionContext(),
} = {}) {
  const root = resolve(workspace);
  return async ({ name, input } = {}) => {
    if (name === 'Glob') {
      const pattern = typeof input?.pattern === 'string' ? input.pattern.replaceAll(BACKSLASH, '/') : '';
      if (!pattern || pattern.startsWith('/') || pattern.split('/').includes('..')) {
        return { behavior: 'deny', reason: 'Glob pattern must stay within the workspace.' };
      }
      return { behavior: 'allow', reason: 'Read-only workspace search.' };
    }

    if (['Read', 'Write', 'Edit', 'Grep'].includes(name)) {
      const candidate = name === 'Grep' ? (input?.path ?? '.') : input?.file_path;
      try {
        const target = resolveWorkspacePath(root, candidate);
        await assertPathWithinWorkspace(root, target);
      } catch (error) {
        return {
          behavior: 'deny',
          reason: 'File target is not authorized: ' + (error instanceof Error ? error.message : String(error)),
        };
      }

      if (name === 'Read' || name === 'Grep') {
        return { behavior: 'allow', reason: 'Read-only workspace operation.' };
      }
      return permissionContext.mode === 'acceptEdits'
        ? { behavior: 'allow', reason: 'Edits authorized by acceptEdits mode.' }
        : { behavior: 'ask', reason: 'This tool modifies workspace files.' };
    }

    if (name === 'Bash') {
      return { behavior: 'ask', reason: 'This command executes a shell process.' };
    }

    return { behavior: 'deny', reason: 'No CLI permission rule exists for tool ' + String(name) + '.' };
  };
}

async function walkFiles(start, state = { files: [], truncated: false }) {
  if (state.files.length >= MAX_WALK_FILES) {
    state.truncated = true;
    return state;
  }
  const entries = await readdir(start, { withFileTypes: true });
  for (const entry of entries) {
    if (state.files.length >= MAX_WALK_FILES) {
      state.truncated = true;
      break;
    }
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(start, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walkFiles(fullPath, state);
    } else if (entry.isFile()) {
      state.files.push(fullPath);
    }
  }
  // Conservatively report truncation at the cap: callers must not mistake a
  // bounded walk for an exhaustive search when the exact total is unknown.
  if (state.files.length >= MAX_WALK_FILES) state.truncated = true;
  return state;
}

function globToRegExp(pattern) {
  const normalized = pattern.replaceAll(BACKSLASH, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (REGEX_META.has(char)) {
      source += BACKSLASH + char;
    } else {
      source += char;
    }
  }
  const prefix = normalized.includes('/') ? '^' : '^(?:.*/)?';
  return new RegExp(prefix + source + '$');
}

async function assertOpenedFileWithinWorkspace(workspace, target, handle) {
  const rootReal = await realpath(workspace);
  const targetInfo = await lstat(target);
  if (targetInfo.isSymbolicLink()) {
    throw new Error('Symbolic links are not allowed for file tools: ' + target);
  }

  const resolvedTarget = await realpath(target);
  const rel = relative(rootReal, resolvedTarget);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('Path resolves outside the workspace: ' + target);
  }

  const [openedInfo, pathInfo] = await Promise.all([handle.stat(), stat(resolvedTarget)]);
  if (!openedInfo.isFile() || !pathInfo.isFile()) throw new Error('Not a regular file: ' + target);
  if (openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
    throw new Error('File path changed while opening; refusing the operation: ' + target);
  }
}

async function openWithNoFollow(target, flags, mode) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try {
    return await open(target, flags | noFollow, mode);
  } catch (error) {
    // Some platforms expose O_NOFOLLOW in constants but do not implement it for open().
    // O_EXCL still protects create-if-absent operations when this fallback is needed.
    if (!noFollow || !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    return open(target, flags, mode);
  }
}

async function openWorkspaceFile(workspace, target, flags, mode) {
  await assertPathWithinWorkspace(workspace, target);
  let openFlags = flags;
  if ((flags & constants.O_CREAT) !== 0) {
    try {
      await lstat(target);
      // Existing files must already exist at open time; don't silently recreate a
      // target that disappears after the check.
      openFlags &= ~constants.O_CREAT;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Atomic O_EXCL prevents a final-component symlink appearing after lstat()
      // from being followed to a target outside the workspace.
      openFlags |= constants.O_EXCL;
    }
  }

  const handle = await openWithNoFollow(target, openFlags, mode);
  try {
    await assertOpenedFileWithinWorkspace(workspace, target, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readTextHandle(handle, filePath) {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error('Not a regular file: ' + filePath);
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new Error('File exceeds the 1 MiB read limit: ' + filePath);
  }

  // Do not rely only on stat(): a concurrently growing file must not bypass the
  // text-read memory limit between the size check and the actual read.
  const chunks = [];
  let total = 0;
  while (total <= MAX_TEXT_FILE_BYTES) {
    const length = Math.min(64 * 1024, MAX_TEXT_FILE_BYTES + 1 - total);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_TEXT_FILE_BYTES) {
      throw new Error('File exceeds the 1 MiB read limit: ' + filePath);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }

  const content = Buffer.concat(chunks, total).toString('utf8');
  if (content.includes(String.fromCharCode(0))) throw new Error('Refusing to read a binary file as text: ' + filePath);
  return content;
}

/**
 * Read a bounded range of 0-based lines through the already-verified file
 * descriptor. Unlike the default whole-file read, this also permits selecting
 * a small section of a source file larger than the 1 MiB output cap.
 *
 * The Read offset/limit schema follows the released CLI 2.1.304 shape.
 * Bytes are scanned incrementally and never buffered beyond the output cap.
 */
async function readTextLinesHandle(handle, filePath, { offset = 0, limit = Infinity } = {}) {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error('Not a regular file: ' + filePath);
  const pieces = [];
  let outputBytes = 0;
  let byteOffset = 0;
  let lineIndex = 0;

  while (true) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteOffset);
    if (bytesRead === 0) break;
    byteOffset += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 || newline >= bytesRead ? bytesRead : newline + 1;
      if (lineIndex >= offset && lineIndex - offset < limit) {
        const part = buffer.subarray(start, end);
        if (part.includes(0)) {
          throw new Error('Refusing to read a binary file as text: ' + filePath);
        }
        outputBytes += part.length;
        if (outputBytes > MAX_TEXT_FILE_BYTES) {
          throw new Error('Selected lines exceed the 1 MiB read limit: ' + filePath);
        }
        pieces.push(part);
      }
      if (end <= start) throw new Error('Could not advance line reader.');
      start = end;
      if (newline >= 0 && newline < bytesRead) {
        lineIndex += 1;
        if (lineIndex >= offset + limit) {
          return Buffer.concat(pieces, outputBytes).toString('utf8');
        }
      }
    }
  }
  return Buffer.concat(pieces, outputBytes).toString('utf8');
}

async function readTextFile(workspace, filePath, options) {
  const handle = await openWorkspaceFile(workspace, filePath, constants.O_RDONLY);
  try {
    // Await the selected read before the finally block closes its file handle.
    return options === undefined
      ? await readTextHandle(handle, filePath)
      : await readTextLinesHandle(handle, filePath, options);
  } finally {
    await handle.close();
  }
}

async function writeTextHandle(handle, content) {
  const buffer = Buffer.from(content, 'utf8');
  await handle.truncate(0);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (bytesWritten === 0) throw new Error('Could not complete file write.');
    offset += bytesWritten;
  }
  await handle.truncate(buffer.length);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Shell command was aborted.');
  error.name = 'AbortError';
  return error;
}

function signalProcessTree(child, signalName) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      // detached=true gives the shell and its descendants a private process group.
      process.kill(-child.pid, signalName);
      return;
    } catch {
      // Fall back to signaling the direct child if the process group is unavailable.
    }
  }
  try {
    child.kill(signalName);
  } catch {
    // The process may have exited between the state check and signal delivery.
  }
}

function runShellCommand(command, { cwd, signal, timeoutMs, maxOutputBytes }) {
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitHit = false;
    let spawnError;
    let forceKillTimer;

    const terminate = () => {
      signalProcessTree(child, 'SIGTERM');
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          try {
            signalProcessTree(child, 'SIGKILL');
          } catch {
            // Best-effort escalation; close/error handling reports the command outcome.
          }
        }, 250);
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (target, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes && !outputLimitHit) {
        outputLimitHit = true;
        terminate();
      }
    };

    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.once('error', error => {
      spawnError = error;
    });
    child.once('close', code => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);

      if (signal?.aborted) {
        rejectPromise(abortError(signal));
        return;
      }

      const result = {
        exit_code: Number.isInteger(code) && code >= 0 ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (timedOut) result.error = 'Command was killed or timed out.';
      else if (outputLimitHit) result.error = 'Command output exceeded the 1 MiB limit.';
      else if (spawnError) result.error = spawnError.message;
      else if (code !== 0) result.error = 'Command exited with status ' + String(code) + '.';
      resolvePromise(result);
    });
  });
}

export async function createBuiltinTools({ workspace = process.cwd() } = {}) {
  const { ToolRegistry } = await import('../../runtime/src/tool-registry.js');
  const root = resolve(workspace);
  const tools = new ToolRegistry();

  tools.register({
    name: 'Read',
    isConcurrencySafe: () => true,
    description: 'Read a UTF-8 text file within the workspace. Use zero-based offset and limit to read sections of large files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    execute: async ({ file_path, offset, limit }) => {
      const target = resolveWorkspacePath(root, file_path);
      await assertPathWithinWorkspace(root, target);
      return readTextFile(root, target,
        offset === undefined && limit === undefined ? undefined : { offset, limit });
    },
  });

  tools.register({
    name: 'Write',
    description: 'Create or replace a UTF-8 text file within the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    execute: async ({ file_path, content }) => {
      const target = resolveWorkspacePath(root, file_path);
      await assertPathWithinWorkspace(root, target);
      await mkdir(dirname(target), { recursive: true });
      const handle = await openWorkspaceFile(root, target, constants.O_WRONLY | constants.O_CREAT, 0o666);
      try {
        // Verify the opened inode immediately before modifying it. The descriptor pins
        // the final file even if the pathname is subsequently replaced.
        await assertOpenedFileWithinWorkspace(root, target, handle);
        await writeTextHandle(handle, content);
      } finally {
        await handle.close();
      }
      return { path: relative(root, target).split(sep).join('/'), bytes: Buffer.byteLength(content), written: true };
    },
  });

  tools.register({
    name: 'Edit',
    description: 'Replace one unique text occurrence in a workspace file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        old_string: { type: 'string', minLength: 1 },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    execute: async ({ file_path, old_string, new_string }) => {
      const target = resolveWorkspacePath(root, file_path);
      const handle = await openWorkspaceFile(root, target, constants.O_RDWR);
      try {
        const original = await readTextHandle(handle, target);
        const first = original.indexOf(old_string);
        if (first < 0) throw new Error('old_string was not found in ' + file_path);
        if (original.indexOf(old_string, first + old_string.length) >= 0) {
          throw new Error('old_string occurs more than once; provide a unique match.');
        }
        const updated = original.slice(0, first) + new_string + original.slice(first + old_string.length);
        await assertOpenedFileWithinWorkspace(root, target, handle);
        await writeTextHandle(handle, updated);
        return { path: relative(root, target).split(sep).join('/'), edited: true };
      } finally {
        await handle.close();
      }
    },
  });

  tools.register({
    name: 'Glob',
    isConcurrencySafe: () => true,
    description: 'Find workspace files matching a glob pattern such as src/**/*.js or *.json.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', minLength: 1 } },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async ({ pattern }) => {
      if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
        throw new Error('Glob pattern must stay within the workspace.');
      }
      const matcher = globToRegExp(pattern);
      const walked = await walkFiles(root);
      const matches = walked.files
        .map((file) => relative(root, file).split(sep).join('/'))
        .filter((file) => matcher.test(file))
        .slice(0, 500);
      return { matches, truncated: walked.truncated || matches.length >= 500 };
    },
  });

  tools.register({
    name: 'Grep',
    isConcurrencySafe: () => true,
    description: 'Search text files in the workspace using a regular expression.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async ({ pattern, path = '.', ignore_case = false }) => {
      const start = resolveWorkspacePath(root, path);
      await assertPathWithinWorkspace(root, start);
      const info = await stat(start);
      const walked = info.isFile() ? { files: [start], truncated: false } : await walkFiles(start);
      const files = walked.files;
      const matcher = new RegExp(pattern, ignore_case ? 'i' : '');
      const matches = [];
      let truncated = walked.truncated;
      for (const file of files) {
        if (matches.length >= 200) { truncated = true; break; }
        let content;
        try {
          content = await readTextFile(root, file);
        } catch (error) {
          if (error instanceof Error && (error.message.includes('1 MiB') || error.message.includes('binary file'))) continue;
          throw error;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (matcher.test(lines[i])) {
            matches.push({
              path: relative(root, file).split(sep).join('/'),
              line: i + 1,
              text: lines[i].slice(0, 500),
            });
            if (matches.length >= 200) { truncated = true; break; }
          }
          matcher.lastIndex = 0;
        }
      }
      return { matches, truncated };
    },
  });

  tools.register({
    name: 'Bash',
    description: 'Run a shell command in the workspace. Each command requires explicit interactive approval.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    execute: async ({ command, timeout_ms = 30000 }, { signal } = {}) => runShellCommand(command, {
      cwd: root,
      signal,
      timeoutMs: timeout_ms,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    }),
  });

  return tools;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) throw new Error('Prompt from stdin exceeds the 1 MiB limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function printError(message) {
  process.stderr.write('agent-cil: ' + message + '\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (options.mode === 'version') {
    process.stdout.write('agent-cil ' + VERSION + '\n');
    return 0;
  }
  if (options.mode === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    printError('ANTHROPIC_API_KEY is required. Set it in the environment; credentials are not saved to disk.');
    return 2;
  }

  let prompt = options.prompt;
  // A positional first prompt should start the interactive session on a TTY,
  // not silently force one-shot mode. --print remains explicitly one-shot.
  const interactiveInput = process.stdin.isTTY && process.stdout.isTTY && !options.print;
  if (options.print && prompt.length === 0 && process.stdin.isTTY) {
    printError('No prompt provided. Pass a prompt or pipe stdin.');
    return 2;
  }
  if (!interactiveInput && prompt.length === 0) {
    try {
      prompt = await readStdin();
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (!interactiveInput && prompt.length === 0) {
    printError('No prompt provided. Pass a prompt, pipe stdin, or start an interactive session.');
    return 2;
  }

  const workspace = resolve(options.cwd);
  try {
    const workspaceInfo = await stat(workspace);
    if (!workspaceInfo.isDirectory()) {
      throw new Error('Path is not a directory.');
    }
  } catch (error) {
    printError('Workspace directory is unavailable: ' + workspace + ' (' +
      (error instanceof Error ? error.message : String(error)) + ')');
    return 2;
  }

  // Do not attach a readline listener until configuration and runtime setup succeed.
  // Otherwise a constructor/import error can leave a TTY handle open before the cleanup finally block.
  let rl;

  const { AgentLoop } = await import('../../runtime/src/agent-loop.js');
  const { AnthropicMessagesAdapter } = await import('../../runtime/src/anthropic-messages-adapter.js');
  const model = new AnthropicMessagesAdapter({
    apiKey,
    model: options.model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    baseUrl: options.baseUrl || env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    maxTokens: options.maxTokens,
    maxRetries: options.maxRetries,
    system: options.system,
  });
  const tools = await createBuiltinTools({ workspace });
  const loop = new AgentLoop({
    model,
    tools,
    permissionPolicy: createCliPermissionPolicy({
      workspace,
      permissionContext: createCliPermissionContext({ allowEdits: options.allowEdits }),
    }),
    maxTurns: options.maxTurns,
    approvalHandler: async ({ name, input, reason, signal }) => {
      if (!rl || options.print || !process.stdin.isTTY) {
        process.stderr.write('[permission] denied ' + name + ': interactive approval is unavailable.\n');
        return { approved: false, reason: 'Interactive approval is unavailable.' };
      }
      process.stderr.write('\n[permission] ' + name + ': ' + reason + '\n');
      process.stderr.write(JSON.stringify(input, null, 2) + '\n');
      const answer = await rl.question('Approve this tool call? [y/N] ', { signal });
      return { approved: /^(y|yes)$/i.test(answer.trim()), reason: 'User did not approve the tool call.' };
    },
  });

  if (process.stdin.isTTY && process.stdout.isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  let history = [];
  let activeController;
  const onSigint = () => {
    if (activeController && !activeController.signal.aborted) {
      const error = new Error('Interrupted by user.');
      error.name = 'AbortError';
      activeController.abort(error);
    } else {
      rl?.close();
      process.exitCode = 130;
    }
  };
  process.on('SIGINT', onSigint);
  loop.on('toolCallStarted', ({ toolName }) => {
    if (options.allowEdits && (toolName === 'Write' || toolName === 'Edit')) {
      process.stderr.write('[permission] auto-approved ' + toolName + ' (--allow-edits)\n');
    }
    process.stderr.write('\n[tool] ' + toolName + '\n');
  });
  loop.on('toolCallFinished', ({ toolName, isError, denied }) => {
    if (isError) process.stderr.write('[tool] ' + toolName + (denied ? ' denied' : ' failed') + '\n');
  });

  const runPrompt = async (text, { plain = false } = {}) => {
    activeController = new AbortController();
    if (!plain) process.stdout.write('assistant> ');
    const onTextDelta = ({ text: delta }) => process.stdout.write(delta);
    loop.on('textDelta', onTextDelta);
    try {
      const result = await loop.run({ messages: history, input: text, signal: activeController.signal });
      history = result.messages;
      process.stdout.write('\n');
      if (result.stopReason === 'max_tokens') {
        printError('Model output reached --max-tokens before finishing. Increase --max-tokens or continue the conversation.');
        return 1;
      }
      if (result.stopReason === 'max_turns') {
        printError('Agent reached --max-turns (' + options.maxTurns + ') without a final response. Increase --max-turns or continue the conversation.');
        return 1;
      }
      return 0;
    } catch (error) {
      process.stdout.write('\n');
      printError(error instanceof Error ? error.message : String(error));
      return activeController.signal.aborted ? 130 : 1;
    } finally {
      loop.off('textDelta', onTextDelta);
      activeController = undefined;
    }
  };

  try {
    if (!interactiveInput) {
      return await runPrompt(prompt, { plain: options.print });
    }
    process.stderr.write('agent-cil interactive mode. Type /exit to quit.\n');
    if (prompt) {
      const status = await runPrompt(prompt);
      if (status === 130) process.stderr.write('Interrupted.\n');
      // A failed model call leaves history unchanged. Keep the interactive shell
      // open so a user can retry without restarting the process.
    }
    while (rl && !rl.closed) {
      let text;
      try {
        text = await rl.question('you> ');
      } catch {
        break;
      }
      const trimmed = text.trim();
      if (trimmed === '/exit' || trimmed === '/quit') break;
      if (!trimmed) continue;
      const status = await runPrompt(trimmed);
      if (status === 130) process.stderr.write('Interrupted.\n');
    }
    return 0;
  } finally {
    process.off('SIGINT', onSigint);
    rl?.close();
  }
}

// npm installs the bin as a symlink. Node resolves import.meta.url to its
// real path while process.argv[1] may retain the symlink path.
const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().then((code) => {
    if (Number.isInteger(code) && code !== 0) process.exitCode = code;
  }).catch((error) => {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
