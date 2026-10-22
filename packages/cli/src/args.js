export const CLI_VERSION = '0.1.0';
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export const HELP_TEXT = `agent-cil — independent command-line Agent runtime

Usage:
  agent-cil --print [options] [prompt]
  printf "your prompt" | agent-cil --print [options]

Options:
  -p, --print                 Run one prompt and exit (required in this first CLI slice)
  --model <id>                Anthropic model ID (default: AGENT_CIL_MODEL or ${DEFAULT_MODEL})
  --max-turns <n>             Maximum model rounds for one prompt (default: 8)
  --system-prompt <text>      Add a system prompt
  --output-format <format>    Output "text" (streamed) or "json" (one result object)
  --verbose                   Write turn diagnostics to stderr
  -h, --help                  Show this help
  -v, -V, --version           Show the CLI version

Environment:
  ANTHROPIC_API_KEY           Required for the default Anthropic Messages adapter
  AGENT_CIL_MODEL             Optional default model ID

Current limits:
  This is a non-interactive, one-prompt CLI slice. It does not yet implement
  the Claude Code SDK stream-json protocol, interactive REPL, built-in tools,
  MCP, or Claude Code's full option/permission semantics.
`;

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function optionValue(argv, index, option, inlineValue) {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) throw new CliUsageError(`${option} requires a value.`);
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value === '--' || value.startsWith('--')) {
    throw new CliUsageError(`${option} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

/** Parse only the CLI slice implemented here; unsupported flags fail explicitly. */
export function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw new TypeError('argv must be an array of strings.');
  }

  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v' || argv[0] === '-V')) {
    return { action: 'version' };
  }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { action: 'help' };
  }

  const parsed = {
    action: 'run',
    print: false,
    model: undefined,
    maxTurns: 8,
    systemPrompt: undefined,
    outputFormat: 'text',
    verbose: false,
    prompt: '',
  };
  const promptParts = [];
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (positionalOnly) {
      promptParts.push(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (arg === '--print' || arg === '-p') {
      parsed.print = true;
      continue;
    }
    if (arg === '--verbose') {
      parsed.verbose = true;
      continue;
    }

    const separator = arg.indexOf('=');
    const option = separator > 0 ? arg.slice(0, separator) : arg;
    const inlineValue = separator > 0 ? arg.slice(separator + 1) : undefined;

    if (option === '--model') {
      const result = optionValue(argv, i, option, inlineValue);
      parsed.model = result.value;
      i = result.nextIndex;
    } else if (option === '--max-turns') {
      const result = optionValue(argv, i, option, inlineValue);
      if (!/^[1-9]\d*$/.test(result.value)) {
        throw new CliUsageError('--max-turns must be a positive integer.');
      }
      const maxTurns = Number(result.value);
      if (!Number.isSafeInteger(maxTurns)) {
        throw new CliUsageError('--max-turns must be a positive safe integer.');
      }
      parsed.maxTurns = maxTurns;
      i = result.nextIndex;
    } else if (option === '--system-prompt') {
      const result = optionValue(argv, i, option, inlineValue);
      parsed.systemPrompt = result.value;
      i = result.nextIndex;
    } else if (option === '--output-format') {
      const result = optionValue(argv, i, option, inlineValue);
      if (!['text', 'json'].includes(result.value)) {
        throw new CliUsageError('--output-format must be "text" or "json".');
      }
      parsed.outputFormat = result.value;
      i = result.nextIndex;
    } else if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v' || arg === '-V') {
      throw new CliUsageError(`${arg} must be used on its own.`);
    } else if (arg.startsWith('-')) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    } else {
      promptParts.push(arg);
    }
  }

  parsed.prompt = promptParts.join(' ');
  return parsed;
}
