#!/usr/bin/env node
import { stat, readdir, mkdir, realpath, lstat, open } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { killPosixProcessTree } from './kill-process-tree.js';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { applyPermissionUpdates } from '../../runtime/src/legacy-permissions/permission-update.js';
import { checkWholeToolPermissionRules } from '../../runtime/src/legacy-permissions/permission-rules.js';
import { permissionRuleValueFromString, permissionRuleValueToString } from '../../runtime/src/legacy-permissions/permission-rule-parser.js';
import { bashToolCheckExactMatchPermission } from '../../runtime/src/legacy-permissions/bash-exact-permission.js';

const VERSION = '0.1.0';
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_WALK_FILES = 5000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.agent-cil']);
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
  '      --model <name>      Model ID (default depends on provider)',
  '      --base-url <url>    API endpoint base URL (defaults to provider URL)',
  '      --provider <name>   anthropic (default), deepseek, or openai',
  '      --max-tokens <n>    Maximum output tokens (default: 4096)',
  '      --max-turns <n>     Maximum model rounds per prompt (default: 8)',
  '      --compact-threshold <n>  Auto-compact above approximate input tokens (0 disables)',
  '      --max-retries <n>   HTTP retries before streaming (default: 2, max: 5)',
  '      --allow-edits       Explicitly allow workspace Write/Edit without prompts (Bash still asks)',
  '      --allowedTools <name>    Allow tool or literal Bash(command), repeatable',
  '      --disallowedTools <name> Deny tool or Bash(command/prefix/wildcard), repeatable',
  '      --askTools <name>        Ask tool or Bash(command/prefix/wildcard), repeatable',
  '      --hooks-file <path> Explicitly trust a tool-hook settings JSON file (Pre/Post/Failure)',
  '      --session-id <uuid> Start a fresh, named persisted CLI session',
  '      --resume <uuid>     Resume a session; omit prompt to finish a committed tool round',
  '      --system <text>     System prompt',
  '      --cwd <path>        Workspace directory (default: current directory)',
  '',
  'Environment:',
  '  ANTHROPIC_API_KEY       Required for model requests',
  '  ANTHROPIC_MODEL         Default model name',
  '  ANTHROPIC_BASE_URL      Optional Anthropic-compatible endpoint',
  '  DEEPSEEK_API_KEY        DeepSeek key (fallback: ANTHROPIC_API_KEY)',
  '  OPENAI_API_KEY          OpenAI key for --provider openai',
  '  OPENAI_MODEL            Default OpenAI model ID',
  '  OPENAI_BASE_URL         Optional OpenAI Chat API base URL',
  '  AGENT_CIL_COMPACT_THRESHOLD  Override auto-compact trigger in tokens',
  '',
  'Built-in tools:',
  '  Read, Glob, Grep       Read-only workspace tools',
  '  Write, Edit, Bash      Require interactive approval before execution',
  '',
  'This first CLI slice uses the repository AgentLoop and Messages API adapter.',
  'Resume uses a versioned committed-checkpoint JSONL subset; full original sessionStorage is pending.',
  'The full official CLI configuration, OAuth and MCP contract is not implemented.',
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
    provider: 'anthropic',
    maxTokens: 4096,
    maxTurns: 8,
    compactThreshold: undefined,
    maxRetries: 2,
    allowEdits: false,
    permissionRules: { allow: [], deny: [], ask: [] },
    hooksFile: undefined,
    sessionId: undefined,
    resume: undefined,
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
    } else if (['--allowedTools', '--disallowedTools', '--askTools'].some(
      flag => arg === flag || arg.startsWith(flag + '=')
    )) {
      const [flag, ...inlineValue] = arg.split('=');
      const behavior = flag === '--allowedTools' ? 'allow'
        : flag === '--disallowedTools' ? 'deny' : 'ask';
      const raw = inlineValue.length ? inlineValue.join('=') : takeValue(flag, i++);
      const parsed = permissionRuleValueFromString(raw);
      const wholeTool = parsed.ruleContent === undefined && raw === parsed.toolName;
      // The original Bash exact-command checkPermissions method is now
      // connected. Wildcard/prefix/compound rule matching still needs the
      // original bashPermissions.ts AST dependency closure, so reject such
      // rules instead of approximating them with a dangerous regex.
      const bashContent = parsed.toolName === 'Bash' &&
        typeof parsed.ruleContent === 'string' &&
        parsed.ruleContent.length > 0 &&
        parsed.ruleContent.trim() === parsed.ruleContent &&
        raw === permissionRuleValueToString(parsed);
      // Literal exact Bash allow remains narrowly permitted. Original
      // prefix/wildcard shell matching is connected for restrictive deny/ask
      // rules only: an unrestricted allow would require original AST checks.
      const bashRule = bashContent && (behavior !== 'allow' ||
        !parsed.ruleContent.includes('*'));
      if (!['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'].includes(parsed.toolName) ||
          !(wholeTool || bashRule)) {
        throw new CliArgumentError(flag +
          ' accepts whole built-in names or Bash(command);' +
          ' wildcard/prefix Bash allow, other content-specific rules and MCP require original AST security checks.');
      }
      options.permissionRules[behavior].push(parsed);
    } else if (arg === '--hooks-file' || arg.startsWith('--hooks-file=')) {
      options.hooksFile = arg === '--hooks-file' ? takeValue(arg, i++) : arg.slice('--hooks-file='.length);
      if (!options.hooksFile) throw new CliArgumentError('--hooks-file requires a path.');
    } else if (arg === '--session-id' || arg.startsWith('--session-id=') ||
               arg === '--resume' || arg.startsWith('--resume=')) {
      const flag = arg.split('=')[0];
      const id = arg === flag ? takeValue(flag, i++) : arg.slice(flag.length+1);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new CliArgumentError(flag + ' requires a valid UUID.');
      }
      if (flag === '--session-id') options.sessionId = id;
      else options.resume = id;
    } else if (arg === '--provider' || arg.startsWith('--provider=')) {
      const provider = arg === '--provider' ? takeValue(arg, i++) : arg.slice('--provider='.length);
      if (!['anthropic', 'deepseek', 'openai'].includes(provider)) {
        throw new CliArgumentError('--provider must be anthropic, deepseek, or openai.');
      }
      options.provider = provider;
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
    } else if (arg === '--compact-threshold' || arg.startsWith('--compact-threshold=')) {
      const raw = arg === '--compact-threshold' ? takeValue(arg, i++) : arg.slice('--compact-threshold='.length);
      options.compactThreshold = Number(raw);
      if (!Number.isSafeInteger(options.compactThreshold) ||
        options.compactThreshold < 0 || options.compactThreshold > 2000000) {
        throw new CliArgumentError('--compact-threshold must be an integer from 0 to 2000000.');
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

  if (options.sessionId && options.resume) {
    throw new CliArgumentError('--session-id and --resume cannot be used together.');
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
export function createCliPermissionContext({ allowEdits = false, permissionRules = {} } = {}) {
  const updates = allowEdits ? [{ type: 'setMode', destination: 'cliArg', mode: 'acceptEdits' }] : [];
  for (const behavior of ['allow', 'deny', 'ask']) {
    const rules = permissionRules[behavior] || [];
    if (rules.length) updates.push({ type: 'addRules', destination: 'cliArg', behavior, rules });
  }
  return applyPermissionUpdates({
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  }, updates);
}

export function createCliPermissionPolicy({
  workspace = process.cwd(),
  permissionContext = createCliPermissionContext(),
} = {}) {
  const root = resolve(workspace);
  const policy = async ({ name, input } = {}) => {
    if (name === 'Glob') {
      const pattern = typeof input?.pattern === 'string' ? input.pattern.replaceAll(BACKSLASH, '/') : '';
      if (!pattern || pattern.startsWith('/') || pattern.split('/').includes('..')) {
        return { behavior: 'deny', reason: 'Glob pattern must stay within the workspace.' };
      }
      return checkWholeToolPermissionRules(permissionContext, { name }) ||
        { behavior: 'allow', reason: 'Read-only workspace search.' };
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

      // Run original 2.1.88 whole-tool rules only AFTER the mandatory
      // workspace/symlink checks. An allow rule must never permit escape.
      const explicitRule = checkWholeToolPermissionRules(permissionContext, { name });
      if (explicitRule) return explicitRule;

      if (name === 'Read' || name === 'Grep') {
        return { behavior: 'allow', reason: 'Read-only workspace operation.' };
      }
      return permissionContext.mode === 'acceptEdits'
        ? { behavior: 'allow', reason: 'Edits authorized by acceptEdits mode.' }
        : { behavior: 'ask', reason: 'This tool modifies workspace files.' };
    }

    if (name === 'Bash') {
      return checkWholeToolPermissionRules(permissionContext, { name }) ||
        { behavior: 'ask', reason: 'This command executes a shell process.',
          decisionReason: { type: 'mode', mode: 'default' } };
    }

    return { behavior: 'deny', reason: 'No CLI permission rule exists for tool ' + String(name) + '.' };
  };
  // This built-in policy makes its decision from tool identity, input and
  // the immutable workspace/rule context, never the evolving assistant text.
  // Custom policies do not receive this opt-in and are always deferred.
  Object.defineProperty(policy, 'supportsStreamingPreflight', { value: true });
  Object.defineProperty(policy, 'isBuiltinCliPolicy', { value: true });
  return policy;
}

async function walkFiles(start, state = { files: [], truncated: false }, signal) {
  if (signal?.aborted) throw abortError(signal);
  if (state.files.length >= MAX_WALK_FILES) {
    state.truncated = true;
    return state;
  }
  const entries = await readdir(start, { withFileTypes: true });
  if (signal?.aborted) throw abortError(signal);
  for (const entry of entries) {
    if (signal?.aborted) throw abortError(signal);
    if (state.files.length >= MAX_WALK_FILES) {
      state.truncated = true;
      break;
    }
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(start, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walkFiles(fullPath, state, signal);
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
async function readTextHandle(handle, filePath, signal) {
  if (signal?.aborted) throw abortError(signal);
  const info = await handle.stat();
  if (signal?.aborted) throw abortError(signal);
  if (!info.isFile()) throw new Error('Not a regular file: ' + filePath);
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new Error('File exceeds the 1 MiB read limit: ' + filePath);
  }

  // Do not rely only on stat(): a concurrently growing file must not bypass the
  // text-read memory limit between the size check and the actual read.
  const chunks = [];
  let total = 0;
  while (total <= MAX_TEXT_FILE_BYTES) {
    if (signal?.aborted) throw abortError(signal);
    const length = Math.min(64 * 1024, MAX_TEXT_FILE_BYTES + 1 - total);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, total);
    if (signal?.aborted) throw abortError(signal);
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
async function readTextLinesHandle(handle, filePath, { offset = 0, limit = Infinity } = {}, signal) {
  if (signal?.aborted) throw abortError(signal);
  const info = await handle.stat();
  if (signal?.aborted) throw abortError(signal);
  if (!info.isFile()) throw new Error('Not a regular file: ' + filePath);
  const pieces = [];
  let outputBytes = 0;
  let byteOffset = 0;
  let lineIndex = 0;

  while (true) {
    if (signal?.aborted) throw abortError(signal);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteOffset);
    if (signal?.aborted) throw abortError(signal);
    if (bytesRead === 0) break;
    byteOffset += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      if (signal?.aborted) throw abortError(signal);
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

async function readTextFile(workspace, filePath, options, signal) {
  if (signal?.aborted) throw abortError(signal);
  const handle = await openWorkspaceFile(workspace, filePath, constants.O_RDONLY);
  try {
    // Await the selected read before the finally block closes its file handle.
    if (signal?.aborted) throw abortError(signal);
    const value = options === undefined
      ? await readTextHandle(handle, filePath, signal)
      : await readTextLinesHandle(handle, filePath, options, signal);
    if (signal?.aborted) throw abortError(signal);
    return value;
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
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    // Node child.kill() terminates only cmd.exe, not the shell's children.
    // The original Bash lifecycle owns the whole launched process tree.
    // Windows has no POSIX process groups: use the OS tree terminator with
    // argv (never interpolate a tool command or PID into a shell command).
    return new Promise((resolveKill,rejectKill) => {
      let killer;
      let settled=false;
      let watchdog;
      const finish=(ok,reason)=>{
        if(settled)return;
        settled=true;
        clearTimeout(watchdog);
        if(ok){
          resolveKill();
          return;
        }
        // Original 2.1.304 killProcessTree logs taskkill failures and
        // falls back to the direct child. Node lacks Bun.ant.windowsProcessPin:
        // fallback is NOT proof the entire descendant tree was reaped.
        try{child.kill('SIGKILL');}catch{}
        // ChildProcess 'close' waits for descendants which inherited these
        // handles. After OS tree termination FAILED, never await those
        // unowned descendants indefinitely: close our own pipe handles
        // so the fatal uncertainty can reach Session/CLI cleanup.
        child.stdout?.destroy();
        child.stderr?.destroy();
        const error=new Error('Windows Bash process-tree cleanup could not be confirmed'+
          (reason?': '+reason:'')+'. Unowned descendants may remain.');
        error.name='ProcessTreeCleanupError';
        rejectKill(error);
      };
      try{
        // Never resolve taskkill.exe from the current project directory or
        // PATH: a repository-local executable could otherwise replace the
        // trusted Windows process-tree terminator.
        const systemRoot=process.env.SystemRoot || 'C:\\Windows';
        killer=spawn(join(systemRoot,'System32','taskkill.exe'),
          ['/PID',String(child.pid),'/T','/F'],
          {windowsHide:true,stdio:'ignore',shell:false});
        killer.once('error',error=>finish(false,error.code||error.message));
        killer.once('close',(code,signal)=>
          finish(code===0,signal?'taskkill signal '+signal:'taskkill exit '+String(code)));
        // The 2.1.304 source uses a bounded post-kill backstop; do not let
        // a stuck OS taskkill worker hold the CLI/session lock forever.
        watchdog=setTimeout(()=>{
          try{killer.kill('SIGKILL');}catch{}
          finish(false,'taskkill exceeded 5s');
        },5000);
      }catch(error){
        finish(false,error instanceof Error?error.message:String(error));
      }
    });
  }
  // 2.1.304 killProcessTree() enumerates the descendant PID tree before
  // signaling the POSIX group: a detached child can escape the shell PGID.
  // The shell's ChildProcess exit status is the only proof that root PID
  // still belongs to this invocation; after exit, only signal its PGID.
  return killPosixProcessTree(child.pid, signalName, {
    captureDescendants: child.exitCode === null && child.signalCode === null,
  }).then(() => {});
}

// Port of the 2.1.304 ShellCommand state shape (liveShellCommands and
// pendingKillBackstops), retained as a headless adapter. The mature 2.1.88
// LocalShellTask/killShellTasks.ts exits also kill outstanding owned tasks.
// This is NOT a Windows Job Object nor a native persistent task registry.
const shellLifecycle = {
  liveShellCommands: new Set(),
  pendingKillBackstops: new Set(),
};

export function getShellLifecycleStatus() {
  return {
    liveShellCommands: shellLifecycle.liveShellCommands.size,
    pendingKillBackstops: shellLifecycle.pendingKillBackstops.size,
  };
}

export async function cleanupLiveShellCommands() {
  // Like 2.1.304's live-shell shutdown + await of pendingKillBackstops:
  // release every currently owned Bash, not just the last active tool.
  const owned = [...shellLifecycle.liveShellCommands];
  const outcomes=await Promise.allSettled(owned.map(shell => shell.kill()));
  // A kill task may have already been started by a signal/timeout.
  // Await the snapshot repeatedly in case the tracked set changed while
  // shell 'close' callbacks were still completing.
  const failures=outcomes.filter(item=>item.status==='rejected').map(item=>item.reason);
  while (shellLifecycle.pendingKillBackstops.size) {
    const ended=await Promise.allSettled([...shellLifecycle.pendingKillBackstops]);
    failures.push(...ended.filter(item=>item.status==='rejected').map(item=>item.reason));
  }
  if(failures.length) {
    // Failed taskkill /T is not a successfully cleaned-up shell. Surface
    // uncertainty to CLI exit and preserve the prior session journal.
    throw new AggregateError(failures,
      'One or more Bash process trees could not be confirmed terminated.');
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
    let terminationTask;
    let exitDrainTimer;
    let unsupportedBackground = false;
    let shutdownRequested = false;

    const terminate = () => {
      if(terminationTask)return terminationTask;
      // Pinned 2.1.88 utils/ShellCommand.ts #doKill() uses
      // treeKill(pid,'SIGKILL') immediately on abort/timeout. The headless
      // shell owns an isolated POSIX process group; Windows uses taskkill /T
      // /F. Await the entire tree termination before settling Bash output.
      terminationTask=signalProcessTree(child,'SIGKILL');
      shellLifecycle.pendingKillBackstops.add(terminationTask);
      // Task completion must remove the same promise instance and may not
      // escape as an unhandled rejection during a normal tool shutdown.
      void terminationTask.finally(() => {
        shellLifecycle.pendingKillBackstops.delete(terminationTask);
      }).catch(() => {});
      return terminationTask;
    };
    const ownedShell = {
      kill() {
        shutdownRequested = true;
        return terminate();
      },
    };
    shellLifecycle.liveShellCommands.add(ownedShell);

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
    // The mature 2.1.88 ShellCommandImpl and 2.1.304 ShellCommand both
    // use 'exit' for the foreground result. 'close' can wait indefinitely
    // for grandchildren inheriting the shell's stdout/stderr pipes.
    // This headless CLI has no original LocalShellTask background registry
    // yet: give foreground pipe data a short drain window, then terminate
    // any unowned descendant tree instead of hanging the tool round or
    // silently leaving a background process with write access.
    child.once('exit', () => {
      if (terminationTask) return;
      if(process.platform !== 'win32' && child.pid) {
        // 2.1.304 ShellCommand reports leftRunningPgid if the foreground
        // shell exited but its process group still exists. This CLI has no
        // LocalShellTask background owner yet: fail closed and reap that
        // group, including descendants that discarded both stdio pipes.
        // A reaped shell with no descendants has no remaining process group.
        try {
          process.kill(-child.pid,0);
          unsupportedBackground = true;
        } catch(error) {
          // EPERM means the group exists but cannot be inspected. Treat it
          // as unsafe rather than reporting a successful command.
          if(error?.code !== 'ESRCH') unsupportedBackground = true;
        }
        if(unsupportedBackground) {
          exitDrainTimer = setTimeout(() => {
            if(!terminationTask)terminate();
            void terminationTask?.then(() => {
              child.stdout?.destroy();
              child.stderr?.destroy();
            });
          },100);
          exitDrainTimer.unref?.();
          return;
        }
      }
      exitDrainTimer = setTimeout(() => {
        if (terminationTask) return;
        unsupportedBackground = true;
        terminate();
        // Node 'close' waits for all inherited pipe handles. After the
        // process-group kill has been dispatched, release inherited fds
        // regardless of whether a descendant ignores the group signal.
        void terminationTask.then(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
      }, 250);
      exitDrainTimer.unref?.();
    });
    child.once('close', async code => {
      clearTimeout(timeout);
      clearTimeout(exitDrainTimer);
      // A POSIX group with ignored/closed stdout can emit 'close' before
      // the delayed cleanup timer. Reap its surviving descendants anyway.
      if(unsupportedBackground && !terminationTask)terminate();
      signal?.removeEventListener('abort', onAbort);
      // Do not report cancellation as cleaned up while Windows taskkill
      // is still terminating grandchildren of cmd.exe.
      try {
        if(terminationTask)await terminationTask;
      } catch(error) {
        spawnError ??= error;
      } finally {
        shellLifecycle.liveShellCommands.delete(ownedShell);
      }

      if (spawnError?.name==='ProcessTreeCleanupError') {
        // The process-tree owner could not confirm that side effects
        // stopped. Throw into AgentLoop's fatal checkpoint fence rather
        // than mapping an ordinary tool_error and continuing the model.
        rejectPromise(spawnError);
        return;
      }
      if (signal?.aborted) {
        rejectPromise(abortError(signal));
        return;
      }

      const result = {
        exit_code: Number.isInteger(code) && code >= 0 ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if(shutdownRequested) {
        result.exit_code = 1;
        result.error = 'Command terminated while releasing its owning CLI session.';
      }
      else if (timedOut) result.error = 'Command was killed or timed out.';
      else if (outputLimitHit) result.error = 'Command output exceeded the 1 MiB limit.';
      else if (spawnError) result.error = spawnError.message;
      else if (unsupportedBackground) {
        // Do not report a successful foreground tool round for a detached
        // descendant we cannot yet register/clean up as LocalShellTask.
        result.exit_code = 1;
        result.error = 'Command left inherited-pipe background processes after the shell exited; unsupported background task was terminated.';
      } else if (code !== 0) result.error = 'Command exited with status ' + String(code) + '.';
      resolvePromise(result);
    });
  });
}

export async function createBuiltinTools({ workspace = process.cwd(), permissionContext = createCliPermissionContext() } = {}) {
  const { ToolRegistry } = await import('../../runtime/src/tool-registry.js');
  const root = resolve(workspace);
  const tools = new ToolRegistry();

  // Preserve the original workspace-safe Read implementation and its direct
  // execute() API, but route actual AgentLoop execution through the 2.1.88
  // Tool.call + result mapper contract. No duplicate read implementation.
  const executeRead = async ({ file_path, offset, limit }, { signal } = {}) => {
    if (signal?.aborted) throw abortError(signal);
    const target = resolveWorkspacePath(root, file_path);
    await assertPathWithinWorkspace(root, target);
    if (signal?.aborted) throw abortError(signal);
    return readTextFile(root, target,
      offset === undefined && limit === undefined ? undefined : { offset, limit }, signal);
  };

  tools.register({
    name: 'Read',
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    // Built-in workspace-only read/search operations may start at tool_use
    // block_stop, before the model has finished streaming.
    canRunDuringStream: true,
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
    execute: executeRead,
    call: async (input, context) => ({ data: await executeRead(input, context) }),
    mapToolResultToToolResultBlockParam: (data, toolUseId) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: data,
    }),
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
    // Built-in workspace-only read/search operations may start at tool_use
    // block_stop, before the model has finished streaming.
    canRunDuringStream: true,
    description: 'Find workspace files matching a glob pattern such as src/**/*.js or *.json.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', minLength: 1 } },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async ({ pattern }, { signal } = {}) => {
      if (signal?.aborted) throw abortError(signal);
      if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
        throw new Error('Glob pattern must stay within the workspace.');
      }
      const matcher = globToRegExp(pattern);
      const walked = await walkFiles(root, undefined, signal);
      if (signal?.aborted) throw abortError(signal);
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
    // Built-in workspace-only read/search operations may start at tool_use
    // block_stop, before the model has finished streaming.
    canRunDuringStream: true,
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
    execute: async ({ pattern, path = '.', ignore_case = false }, { signal } = {}) => {
      if (signal?.aborted) throw abortError(signal);
      const start = resolveWorkspacePath(root, path);
      await assertPathWithinWorkspace(root, start);
      const info = await stat(start);
      const walked = info.isFile() ? { files: [start], truncated: false } :
        await walkFiles(start, undefined, signal);
      if (signal?.aborted) throw abortError(signal);
      const files = walked.files;
      const matcher = new RegExp(pattern, ignore_case ? 'i' : '');
      const matches = [];
      let truncated = walked.truncated;
      for (const file of files) {
        if (signal?.aborted) throw abortError(signal);
        if (matches.length >= 200) { truncated = true; break; }
        let content;
        try {
          content = await readTextFile(root, file, undefined, signal);
        } catch (error) {
          if (signal?.aborted) throw abortError(signal);
          if (error instanceof Error && (error.message.includes('1 MiB') || error.message.includes('binary file'))) continue;
          throw error;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (signal?.aborted) throw abortError(signal);
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
    description: 'Run a shell command in the workspace. Requires approval unless permitted by an exact command rule.',
    // Original BashTool.checkPermissions delegates to bashToolHasPermission.
    // Until AST, wrapper, wildcard and sandbox matching are transplanted, this
    // is restricted to exact command rule decisions only (fail closed).
    checkPermissions: async input => bashToolCheckExactMatchPermission(input, permissionContext),
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

  const provider = options.provider;
  const credentialEnvName = provider === 'openai' ? 'OPENAI_API_KEY'
    : provider === 'deepseek' ? 'DEEPSEEK_API_KEY or ANTHROPIC_API_KEY' : 'ANTHROPIC_API_KEY';
  const apiKey = provider === 'openai' ? env.OPENAI_API_KEY
    : provider === 'deepseek' ? (env.DEEPSEEK_API_KEY || env.ANTHROPIC_API_KEY)
      : env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    printError(credentialEnvName + ' is required. Supply it via the environment, not CLI arguments.');
    return 2;
  }

  let prompt = options.prompt;
  // A positional first prompt should start the interactive session on a TTY,
  // not silently force one-shot mode. --print remains explicitly one-shot.
  const interactiveInput = process.stdin.isTTY && process.stdout.isTTY && !options.print;
  if (options.print && prompt.length === 0 && process.stdin.isTTY && !options.resume) {
    printError('No prompt provided. Pass a prompt or pipe stdin.');
    return 2;
  }
  if (!interactiveInput && prompt.length === 0 &&
      (!options.resume || !process.stdin.isTTY)) {
    // An explicit --resume can continue a durable tool checkpoint without
    // another user message, but a piped prompt still takes precedence.
    // readStdin() reaches EOF for an empty pipe; it does not invent content.
    try {
      prompt = await readStdin();
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (!interactiveInput && prompt.length === 0 && !options.resume) {
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
  // Only the transport changes: both providers feed the same 2.1.88-derived
  // query loop and the same permission-checked Read/Edit/Bash tools.
  let model;
  if (provider === 'openai') {
    const { OpenAIChatAdapter } = await import('../../runtime/src/openai-chat-adapter.js');
    model = new OpenAIChatAdapter({
      apiKey,
      model: options.model || env.OPENAI_MODEL || 'gpt-5.1',
      baseUrl: options.baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      system: options.system,
    });
  } else {
    const { AnthropicMessagesAdapter } = await import('../../runtime/src/anthropic-messages-adapter.js');
    model = new AnthropicMessagesAdapter({
      apiKey,
      model: options.model || (provider === 'deepseek'
        ? (env.DEEPSEEK_MODEL || 'deepseek-flash')
        : (env.ANTHROPIC_MODEL || 'claude-sonnet-4-5')),
      baseUrl: options.baseUrl || (provider === 'deepseek'
        ? (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic')
        : (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')),
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      system: options.system,
    });
  }
  const permissionContext = createCliPermissionContext({
    allowEdits: options.allowEdits, permissionRules: options.permissionRules,
  });
  const tools = await createBuiltinTools({ workspace, permissionContext });
  let toolHooks = { PreToolUse: [], PostToolUse: [], PostToolUseFailure: [] };
  if (options.hooksFile) {
    try {
      const { loadToolHookSettings } = await import(
        '../../runtime/src/legacy-tools/pretooluse-node-compat.js'
      );
      // Explicit CLI flag is the trust boundary. Never auto-execute commands
      // from an untrusted repository's settings on startup.
      toolHooks = await loadToolHookSettings(options.hooksFile);
    } catch (error) {
      printError('Tool Hook configuration failed: ' +
        (error instanceof Error ? error.message : String(error)));
      return 2;
    }
  }
  // DeepSeek V4.1 Flash advertises a 1M-token context window; reserve ample
  // headroom for system/tools/output. Other providers remain opt-in until
  // their model-specific context windows can be determined accurately.
  let compactThreshold = options.compactThreshold;
  if (compactThreshold === undefined && env.AGENT_CIL_COMPACT_THRESHOLD !== undefined) {
    compactThreshold = Number(env.AGENT_CIL_COMPACT_THRESHOLD);
    if (!Number.isSafeInteger(compactThreshold) || compactThreshold < 0 ||
      compactThreshold > 2000000) {
      printError('AGENT_CIL_COMPACT_THRESHOLD must be an integer from 0 to 2000000.');
      return 2;
    }
  }
  compactThreshold ??= provider === 'deepseek' ? 850000 : 0;
  const { createAutoCompact } = await import('../../runtime/src/legacy-compact/auto-compact.js');
  const autoCompact = createAutoCompact({ thresholdTokens: compactThreshold });
  const { openSessionJournal } = await import('../../runtime/src/legacy-session/session-storage.js');
  let journal;
  try {
    journal = await openSessionJournal({
      workspace,
      ...(options.sessionId || options.resume
        ? { sessionId: options.sessionId || options.resume } : {}),
      resume: !!options.resume,
    });
  } catch(error) {
    printError('Session initialization failed: ' +
      (error instanceof Error ? error.message : String(error)));
    return 2;
  }
  process.stderr.write('[session] ' + journal.id + (options.resume ? ' resumed' : ' created') + '\n');
  if(journal.needsToolReconciliation) {
    if(journal.startedToolExecutions.length) {
      process.stderr.write('[session] ' + journal.startedToolExecutions.length +
        ' started tool call(s) recorded; verify side effects before resuming.\n');
    }
    if(journal.mappedToolResults.length) {
      process.stderr.write('[session] ' + journal.mappedToolResults.length +
        ' mapped tool result(s) saved before PostToolUse; Hook completion still requires reconciliation.\n');
    }
    // Original Session retains an assistant tool_use even when the process
    // dies before its matching tool_result. Never replay that assistant
    // request through the model: Write/Bash may already have taken effect.
    printError(journal.needsToolContextReview
      ? 'Session contains completed tool results but failed Hook/native context normalization. Inspect the preserved results and Hook side effects before continuing; automatic replay is unsafe.'
      : 'Session contains an unfinished tool batch. Inspect side effects and reconcile the session before continuing; automatic replay is unsafe.');
    await journal.close();
    return 2;
  }
  if (!interactiveInput && prompt.length === 0 && !journal.canContinueWithoutPrompt) {
    // Source insertMessageChain() saves initial user messages before the
    // provider responds. Resume either an unanswered prompt or a fully
    // committed tool batch, never a previously completed answer.
    printError('Session has no committed pending user prompt or tool result. Supply a new prompt to continue.');
    await journal.close();
    return 2;
  }
  const loop = new AgentLoop({
    model,
    tools,
    toolResultStorage: {
      workspace,
      directory: join(workspace, '.agent-cil', 'sessions', journal.id, 'tool-results'),
    },
    preToolUseHooks: toolHooks.PreToolUse,
    postToolUseHooks: toolHooks.PostToolUse,
    postToolUseFailureHooks: toolHooks.PostToolUseFailure,
    hookWorkspace: workspace,
    compactContext: context => autoCompact.compact(context),
    // The old sessionStorage.ts enqueues JSONL transcript commits. The
    // portable Node journal implements only completed checkpoint records.
    // Await it in Query before any subsequent provider request.
    onSessionCheckpoint: checkpoint => journal.append(checkpoint),
    // The source non-MCP mapped result exists before PostToolUse. Preserve
    // it in the same fsynced, locked journal while the command Hook runs.
    onMappedToolResult: result => journal.appendMappedToolResult(result),
    // Original StreamingToolExecutor executing transition, durably linked
    // only after final permission and before invoking a side-effecting tool.
    onToolExecutionStart: result => journal.appendToolExecutionStart(result),
    permissionPolicy: createCliPermissionPolicy({
      workspace,
      permissionContext,
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

  let history = journal.messages;
  let activeController;
  let sigtermRequested = false;
  const onSigterm = () => {
    // Pinned original ShellCommandImpl delegates cancellation to the active
    // abort signal, whose Bash process owner kills its entire process tree.
    // Do not let Node's default SIGTERM exit orphan a still-running Bash.
    sigtermRequested = true;
    process.exitCode = 143;
    if(activeController && !activeController.signal.aborted) {
      const error = new Error('Terminated by SIGTERM.');
      error.name = 'AbortError';
      activeController.abort(error);
    }
    // Closing readline also exits an idle interactive shell.
    rl?.close();
  };
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
  process.on('SIGTERM', onSigterm);
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
    if(sigtermRequested)return 143;
    if(journal.needsToolReconciliation) {
      printError(journal.needsToolContextReview
      ? 'Session contains completed tool results but failed Hook/native context normalization. Inspect the preserved results and Hook side effects before continuing; automatic replay is unsafe.'
      : 'Session contains an unfinished tool batch. Inspect side effects and reconcile the session before continuing; automatic replay is unsafe.');
      return 2;
    }
    activeController = new AbortController();
    if (!plain) process.stdout.write('assistant> ');
    const onTextDelta = ({ text: delta }) => process.stdout.write(delta);
    // Once a model-requested tool turn has finished, its effects may already
    // be on disk. If the NEXT model stream fails, retaining the completed
    // assistant/tool_result pair prevents a retry from redoing that work.
    let committedHistory;
    const onTurnFinished = ({ committedMessages }) => {
      if (committedMessages) committedHistory = committedMessages;
    };
    const onContextCompacted = ({ committedMessages, beforeCount, afterCount }) => {
      committedHistory = committedMessages;
      process.stderr.write('[context] compacted ' + beforeCount + ' → ' + afterCount +
        ' messages; recent tool turns preserved.\n');
    };
    loop.on('textDelta', onTextDelta);
    loop.on('turnFinished', onTurnFinished);
    loop.on('contextCompacted', onContextCompacted);
    try {
      if (text !== undefined) {
        // The old sessionStorage.ts insertMessageChain() persists a user
        // message before model streaming, even when the provider later
        // fails. Commit this exact model input first, without inventing
        // another message or altering AgentLoop's ToolUseContext handoff.
        await journal.append({
          messages: [...history, {role:'user',content:text}], kind:'input',
        });
      }
      const result = await loop.run({
        messages: history,
        ...(text === undefined ? {} : { input: text }),
        signal: activeController.signal,
      });
      history = result.messages;
      process.stdout.write('\n');
      if(sigtermRequested)return 143;
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
      if(journal.needsToolContextReview) {
        // Tool mapping completed, but Hook/native context normalization
        // failed. Preserve the confirmed final tool result without pretending
        // that the failed post-tool context can be safely replayed.
        history=journal.messages;
        if(interactiveInput) {
          process.stderr.write('[recovery] Completed tool results were saved, but post-tool context needs manual review. Automatic replay is blocked.\n');
        }
      } else if (committedHistory) {
        // The erroring model response is NOT committed. Only the preceding
        // completed tool rounds (including the original user request) survive.
        history = committedHistory;
        if (interactiveInput) {
          process.stderr.write('[recovery] Completed tool results were retained. ' +
            'Continue the conversation without re-running previous tools.\n');
        }
      } else if (journal.messages.length > history.length) {
        // A provider failure before its first complete response must not
        // strand a durable user prompt outside the interactive history.
        history = journal.messages;
        if (interactiveInput) {
          process.stderr.write('[recovery] The unanswered prompt was saved. ' +
            'It can be retried with --resume after restart.\n');
        }
      }
      printError(error instanceof Error ? error.message : String(error));
      return sigtermRequested ? 143 : activeController.signal.aborted ? 130 : 1;
    } finally {
      loop.off('textDelta', onTextDelta);
      loop.off('turnFinished', onTurnFinished);
      loop.off('contextCompacted', onContextCompacted);
      activeController = undefined;
    }
  };

  try {
    if (!interactiveInput) {
      return await runPrompt(prompt.length ? prompt : undefined, { plain: options.print });
    }
    process.stderr.write('agent-cil interactive mode. Type /exit to quit.\n');
    if (prompt) {
      const status = await runPrompt(prompt);
      if (status === 130) process.stderr.write('Interrupted.\n');
      // Invalid/incomplete model responses are never committed. A completed
      // tool-result checkpoint is retained when a later model turn fails, so
      // the interactive shell can safely continue without replaying tools.
    }
    while (rl && !rl.closed && !sigtermRequested) {
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
    return sigtermRequested ? 143 : 0;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    rl?.close();
    try {
      // 2.1.88 LocalShellTask kills agent-owned shells on exit, and
      // 2.1.304 waits for pendingKillBackstops during shutdown. Do this
      // BEFORE releasing the durable session lock, including exceptional
      // and SIGTERM paths.
      await cleanupLiveShellCommands();
    } finally {
      await journal.close();
    }
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
