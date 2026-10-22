import { CLI_VERSION, DEFAULT_MODEL, HELP_TEXT, parseCliArgs } from './args.js';

async function readStdin(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('stdin must be an async iterable stream.');
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function createDefaultModel({ model, systemPrompt, env }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('ANTHROPIC_API_KEY is required. Set it in the environment or provide a model adapter in code.');
  }
  const { AnthropicMessagesAdapter } = await import('../../runtime/src/anthropic-messages-adapter.js');
  return new AnthropicMessagesAdapter({
    apiKey,
    model,
    ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
  });
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the supported one-shot CLI path. Dependencies are injectable for tests;
 * help/version never initialize a model or require credentials.
 */
export async function runCli(argv, {
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  signal,
  modelFactory = createDefaultModel,
} = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`agent-cil: ${errorMessage(error)}\nRun "agent-cil --help" for usage.\n`);
    return 2;
  }

  if (parsed.action === 'help') {
    stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.action === 'version') {
    stdout.write(`agent-cil ${CLI_VERSION}\n`);
    return 0;
  }
  if (!parsed.print) {
    stderr.write('agent-cil: interactive mode is not implemented yet; use --print with a prompt or piped stdin.\n');
    return 2;
  }

  let prompt = parsed.prompt;
  try {
    if (prompt.trim().length === 0) {
      if (stdin.isTTY) {
        stderr.write('agent-cil: --print requires a prompt when stdin is a terminal.\n');
        return 2;
      }
      prompt = await readStdin(stdin);
    }
    if (prompt.trim().length === 0) {
      stderr.write('agent-cil: prompt is empty.\n');
      return 2;
    }

    const model = await modelFactory({
      model: parsed.model ?? env.AGENT_CIL_MODEL ?? DEFAULT_MODEL,
      systemPrompt: parsed.systemPrompt,
      env,
    });
    const [{ AgentLoop }, { ToolRegistry }] = await Promise.all([
      import('../../runtime/src/agent-loop.js'),
      import('../../runtime/src/tool-registry.js'),
    ]);
    const loop = new AgentLoop({
      model,
      tools: new ToolRegistry(),
      maxTurns: parsed.maxTurns,
    });

    let streamedText = false;
    loop.on('textDelta', ({ text }) => {
      if (parsed.outputFormat === 'text') {
        stdout.write(text);
        streamedText = true;
      }
    });
    if (parsed.verbose) {
      loop.on('turnStarted', ({ turn }) => stderr.write(`[agent-cil] model round ${turn}\n`));
      loop.on('usage', ({ turn, usage }) => stderr.write(`[agent-cil] usage round ${turn}: ${JSON.stringify(usage)}\n`));
      loop.on('modelError', ({ turn, error }) => stderr.write(`[agent-cil] model round ${turn} failed: ${errorMessage(error)}\n`));
    }

    const result = await loop.run({ input: prompt, signal });
    if (parsed.outputFormat === 'json') {
      stdout.write(JSON.stringify({
        ok: true,
        text: messageText(result.finalMessage),
        stopReason: result.stopReason,
        turns: result.turns,
      }) + '\n');
    } else if (streamedText) {
      stdout.write('\n');
    }
    return 0;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (parsed.outputFormat === 'json') {
      stdout.write(JSON.stringify({
        ok: false,
        error: { name: normalized.name || 'Error', message: normalized.message },
      }) + '\n');
    } else {
      if (normalized.name === 'AbortError' && parsed.outputFormat === 'text') stdout.write('\n');
      stderr.write(`agent-cil: ${normalized.message}\n`);
    }
    if (signal?.aborted || normalized.name === 'AbortError') {
      return signal?.reason?.code === 'SIGTERM' ? 143 : 130;
    }
    return 1;
  }
}
