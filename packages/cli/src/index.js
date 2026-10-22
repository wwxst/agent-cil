#!/usr/bin/env node
import { stat, readdir, mkdir, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

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
export function createCliPermissionPolicy({ workspace = process.cwd() } = {}) {
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
      return { behavior: 'ask', reason: 'This tool modifies workspace files.' };
    }

    if (name === 'Bash') {
      return { behavior: 'ask', reason: 'This command executes a shell process.' };
    }

    return { behavior: 'deny', reason: 'No CLI permission rule exists for tool ' + String(name) + '.' };
  };
}

async function walkFiles(start, output = []) {
  if (output.length >= MAX_WALK_FILES) return output;
  const entries = await readdir(start, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= MAX_WALK_FILES) break;
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(start, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walkFiles(fullPath, output);
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }
  return output;
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

async function openWorkspaceFile(workspace, target, flags, mode) {
  await assertPathWithinWorkspace(workspace, target);
  // O_NOFOLLOW closes the final-component symlink race on platforms that support it.
  // Post-open identity and realpath checks also run on platforms without that flag.
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(target, flags | noFollow, mode);
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
  const content = await handle.readFile({ encoding: 'utf8' });
  if (content.includes(String.fromCharCode(0))) throw new Error('Refusing to read a binary file as text: ' + filePath);
  return content;
}

async function readTextFile(workspace, filePath) {
  const handle = await openWorkspaceFile(workspace, filePath, constants.O_RDONLY);
  try {
    return await readTextHandle(handle, filePath);
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
        forceKillTimer.unref?.();
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
      if (forceKillTimer) clearTimeout(forceKillTimer);
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
    description: 'Read a UTF-8 text file within the workspace.',
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string', minLength: 1 } },
      required: ['file_path'],
      additionalProperties: false,
    },
    execute: async ({ file_path }) => {
      const target = resolveWorkspacePath(root, file_path);
      await assertPathWithinWorkspace(root, target);
      return readTextFile(root, target);
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
      const files = await walkFiles(root);
      const matches = files
        .map((file) => relative(root, file).split(sep).join('/'))
        .filter((file) => matcher.test(file))
        .slice(0, 500);
      return { matches, truncated: files.length >= MAX_WALK_FILES || matches.length >= 500 };
    },
  });

  tools.register({
    name: 'Grep',
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
      const files = info.isFile() ? [start] : await walkFiles(start);
      const matcher = new RegExp(pattern, ignore_case ? 'i' : '');
      const matches = [];
      let truncated = false;
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
  const interactiveInput = process.stdin.isTTY && process.stdout.isTTY && !options.print && prompt.length === 0;
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
    system: options.system,
  });
  const tools = await createBuiltinTools({ workspace });
  const loop = new AgentLoop({
    model,
    tools,
    permissionPolicy: createCliPermissionPolicy({ workspace }),
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => {
    if (Number.isInteger(code) && code !== 0) process.exitCode = code;
  }).catch((error) => {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
