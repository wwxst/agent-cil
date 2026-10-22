#!/usr/bin/env node
import { readFile, writeFile, stat, readdir, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { AgentLoop, AnthropicMessagesAdapter, ToolRegistry } from '../../runtime/src/index.js';

const VERSION = '0.1.0';
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_WALK_FILES = 5000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.cache']);
const BACKSLASH = String.fromCharCode(92);
const REGEX_META = new Set(['.', '+', '^', '$', '(', ')', '|', '[', ']', '{', '}', BACKSLASH]);
const execAsync = promisify(exec);

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

async function readTextFile(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('Not a regular file: ' + filePath);
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new Error('File exceeds the 1 MiB read limit: ' + filePath);
  }
  const content = await readFile(filePath, 'utf8');
  if (content.includes('\0')) throw new Error('Refusing to read a binary file as text: ' + filePath);
  return content;
}

export function createBuiltinTools({ workspace = process.cwd() } = {}) {
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
    execute: async ({ file_path }) => readTextFile(resolveWorkspacePath(root, file_path)),
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
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
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
      const original = await readTextFile(target);
      const first = original.indexOf(old_string);
      if (first < 0) throw new Error('old_string was not found in ' + file_path);
      if (original.indexOf(old_string, first + old_string.length) >= 0) {
        throw new Error('old_string occurs more than once; provide a unique match.');
      }
      const updated = original.slice(0, first) + new_string + original.slice(first + old_string.length);
      await writeFile(target, updated, 'utf8');
      return { path: relative(root, target).split(sep).join('/'), edited: true };
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
      const info = await stat(start);
      const files = info.isFile() ? [start] : await walkFiles(start);
      const matcher = new RegExp(pattern, ignore_case ? 'i' : '');
      const matches = [];
      let truncated = false;
      for (const file of files) {
        if (matches.length >= 200) { truncated = true; break; }
        let content;
        try {
          content = await readTextFile(file);
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
    execute: async ({ command, timeout_ms = 30000 }, { signal } = {}) => {
      try {
        const result = await execAsync(command, {
          cwd: root,
          signal,
          timeout: timeout_ms,
          maxBuffer: MAX_TOOL_OUTPUT_BYTES,
          windowsHide: true,
        });
        return { exit_code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        return {
          exit_code: Number.isInteger(error?.code) ? error.code : 1,
          stdout: typeof error?.stdout === 'string' ? error.stdout : '',
          stderr: typeof error?.stderr === 'string' ? error.stderr : '',
          error: error?.killed ? 'Command was killed or timed out.' : (error?.message || String(error)),
        };
      }
    },
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
  let rl;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  const model = new AnthropicMessagesAdapter({
    apiKey,
    model: options.model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    baseUrl: options.baseUrl || env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    maxTokens: options.maxTokens,
    system: options.system,
  });
  const tools = createBuiltinTools({ workspace });
  const loop = new AgentLoop({
    model,
    tools,
    permissionPolicy: async ({ name }) => {
      if (['Read', 'Glob', 'Grep'].includes(name)) return { behavior: 'allow' };
      return {
        behavior: 'ask',
        reason: name === 'Bash' ? 'This command executes a shell process.' : 'This tool modifies workspace files.',
      };
    },
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
