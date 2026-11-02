import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createTuiController } from '../src/tui/controller.js';

test('TUI controller preserves streamed assistant output and updates the live locale', () => {
  const controller = createTuiController({ locale: 'en', model: 'fixture-model', permissionMode: 'default' });
  controller.addMessage('user', 'inspect this file');
  controller.beginAssistantMessage();
  controller.appendAssistantText('The ');
  controller.appendAssistantText('file is safe.');
  controller.finishAssistantMessage();
  controller.setLocale('zh-CN');
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.locale, 'zh-CN');
  assert.equal(snapshot.model, 'fixture-model');
  assert.deepEqual(snapshot.messages.map(message => [message.role, message.text]), [
    ['user', 'inspect this file'],
    ['assistant', 'The file is safe.'],
  ]);
  controller.close(0);
});

test('TUI permission request resolves only after an explicit approval decision', async () => {
  const controller = createTuiController();
  const pending = controller.requestApproval({
    name: 'Write',
    input: { file_path: 'example.txt', content: 'safe' },
    reason: 'The model wants to create a file.',
    defaultToNo: true,
  });
  assert.equal(controller.getSnapshot().pendingApproval.name, 'Write');
  assert.equal(controller.getSnapshot().pendingApproval.defaultToNo, true);
  assert.match(controller.getSnapshot().pendingApproval.input, /example\.txt/);
  controller.resolveApproval(true);
  assert.deepEqual(await pending, {
    approved: true,
    reason: 'User approved the tool call.',
  });
  assert.equal(controller.getSnapshot().pendingApproval, null);
  controller.close(0);
});

test('TUI permission approval retains original acceptFeedback for the next model turn', async () => {
  const controller = createTuiController();
  const pending = controller.requestApproval({
    name: 'Bash',
    input: { command: 'echo safe' },
    reason: 'Run a command.',
  });
  controller.resolveApproval(true, 'Only run the exact reviewed command.');
  assert.deepEqual(await pending, {
    approved: true,
    reason: 'User approved the tool call.',
    acceptFeedback: 'Only run the exact reviewed command.',
  });
  controller.close(0);
});

test('TUI permission rejection feedback becomes the denial reason and Escape attribution increments', async () => {
  const controller = createTuiController();
  const pending = controller.requestApproval({
    name: 'Bash',
    input: { command: 'echo unsafe' },
    reason: 'Run a command.',
  });
  controller.recordPermissionEscape();
  assert.equal(controller.getSnapshot().attribution.escapeCount, 1);
  controller.resolveApproval(false, 'I did not ask to run this command.');
  assert.deepEqual(await pending, {
    approved: false,
    reason: 'I did not ask to run this command.',
  });
  controller.close(0);
});

test('TUI permission cancellation is idempotent and stale Escape cannot change attribution', async () => {
  const controller = createTuiController();
  const pending = controller.requestApproval({
    name: 'Bash',
    input: { command: 'echo safe' },
    reason: 'Run a command.',
  });
  const firstResolution = controller.resolveApproval(false);
  if (firstResolution) controller.recordPermissionEscape();
  assert.equal(firstResolution, true);
  assert.equal(controller.resolveApproval(false), false);
  assert.equal(controller.getSnapshot().attribution.escapeCount, 1);
  assert.deepEqual(await pending, {
    approved: false,
    reason: 'User denied the tool call.',
  });
  controller.close(0);
});

test('TUI permission request is denied when its AgentLoop AbortSignal fires', async () => {
  const controller = createTuiController();
  const abort = new AbortController();
  const pending = controller.requestApproval({
    name: 'Bash',
    input: { command: 'echo safe' },
    reason: 'Run a command.',
    signal: abort.signal,
  });
  abort.abort(new Error('cancel'));
  assert.deepEqual(await pending, {
    approved: false,
    reason: 'Permission request was interrupted.',
  });
  assert.equal(controller.getSnapshot().pendingApproval, null);
  controller.close(0);
});

test('closing the TUI denies any outstanding approval and resolves its exit waiter', async () => {
  const controller = createTuiController();
  const pending = controller.requestApproval({
    name: 'Edit',
    input: { file_path: 'example.txt' },
    reason: 'Apply a patch.',
  });
  controller.close(143);
  assert.deepEqual(await pending, {
    approved: false,
    reason: 'The interactive session is closing.',
  });
  assert.equal(await controller.waitUntilExit(), 143);
  assert.equal(controller.getExitCode(), 143);
});

test('original 2.1.88 Ink root and TUI component load through the Node TSX compatibility boundary', async () => {
  process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
  const { register } = await import('tsx/esm/api');
  register();
  let root;
  try {
    root = await import('../../../legacy/2.1.88/restored-src/src/ink/root.ts');
  } catch (error) {
    assert.fail(`Original 2.1.88 Ink root failed to load: ${JSON.stringify({
      message: error?.message,
      code: error?.code,
      url: error?.url,
      cause: error?.cause?.message,
      stack: error?.stack,
    })}`);
  }
  const dependencies = [
    ['Ink Box', '../../../legacy/2.1.88/restored-src/src/ink/components/Box.js'],
    ['Ink ScrollBox', '../../../legacy/2.1.88/restored-src/src/ink/components/ScrollBox.js'],
    ['Ink Text', '../../../legacy/2.1.88/restored-src/src/ink/components/Text.js'],
    ['Ink terminal focus hook', '../../../legacy/2.1.88/restored-src/src/ink/hooks/use-terminal-focus.js'],
    ['original terminal size hook', '../../../legacy/2.1.88/restored-src/src/hooks/useTerminalSize.js'],
    ['Node BaseTextInput adapter', '../../../legacy/2.1.88/restored-src/src/components/BaseTextInput.node.js'],
    ['agent-cil PermissionPrompt', '../src/tui/PermissionPrompt.tsx'],
    ['marked package', 'marked'],
    ['wrap-ansi package', 'wrap-ansi'],
    ['original Ink wrapAnsi', '../../../legacy/2.1.88/restored-src/src/ink/wrapAnsi.js'],
    ['original Node Ink compatibility barrel', '../../../legacy/2.1.88/restored-src/src/ink.js'],
    ['original Ink Ansi', '../../../legacy/2.1.88/restored-src/src/ink/Ansi.js'],
    ['original MarkdownTable', '../../../legacy/2.1.88/restored-src/src/components/MarkdownTable.js'],
    ['original Markdown helpers', '../../../legacy/2.1.88/restored-src/src/utils/markdown.js'],
    ['original message helpers', '../../../legacy/2.1.88/restored-src/src/utils/messages.js'],
    ['agent-cil MessageContent', '../src/tui/MessageContent.tsx'],
    ['agent-cil useTextInput', '../src/tui/useTextInput.ts'],
    ['original prompt history', '../../../legacy/2.1.88/restored-src/src/history.js'],
    ['agent-cil input adapter', '../src/tui/input.js'],
    ['agent-cil i18n', '../src/i18n.js'],
  ];
  for (const [label, specifier] of dependencies) {
    try {
      await import(specifier);
    } catch (error) {
      assert.fail(`${label} failed to load: ${JSON.stringify({
        message: error?.message,
        code: error?.code,
        url: error?.url,
        cause: error?.cause?.message,
        stack: error?.stack,
      })}`);
    }
  }
  let app;
  try {
    app = await import('../src/tui/AgentTui.tsx');
  } catch (error) {
    assert.fail(`agent-cil AgentTui failed to load: ${JSON.stringify({
      message: error?.message,
      code: error?.code,
      url: error?.url,
      cause: error?.cause?.message,
      stack: error?.stack,
    })}`);
  }
  assert.equal(typeof root.default, 'function');
  assert.equal(typeof app.default, 'function');
});

test('TUI controller retains concurrent tool calls and their terminal lifecycle states', () => {
  const controller = createTuiController();
  controller.addMessage('user', 'inspect and update files');
  controller.beginAssistantMessage();
  controller.appendAssistantText('I will inspect first.');
  const first = controller.beginToolMessage('tool-read-1', 'Read');
  const second = controller.beginToolMessage('tool-write-2', 'Write');
  assert.ok(first);
  assert.ok(second);
  assert.equal(controller.finishToolMessage({
    toolUseId: 'tool-read-1',
  }), true);
  assert.equal(controller.finishToolMessage({
    toolUseId: 'tool-write-2',
    isError: true,
  }), true);
  assert.equal(controller.finishToolMessage({
    toolUseId: 'unknown-tool',
  }), false);
  controller.appendAssistantText(' Then report the result.');
  controller.finishAssistantMessage();

  const messages = controller.getSnapshot().messages;
  assert.deepEqual(messages.map(message => message.role), [
    'user', 'assistant', 'tool', 'tool',
  ]);
  assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => [
    message.toolUseId, message.toolName, message.status,
  ]), [
    ['tool-read-1', 'Read', 'succeeded'],
    ['tool-write-2', 'Write', 'failed'],
  ]);
  assert.equal(messages[1].text, 'I will inspect first. Then report the result.');
  controller.close(0);
});

test('TUI controller marks denied and interrupted tool calls without granting execution', () => {
  const controller = createTuiController();
  controller.beginToolMessage('denied-tool', 'Bash');
  controller.finishToolMessage({ toolUseId: 'denied-tool', denied: true, isError: true });
  controller.beginToolMessage('interrupted-tool', 'Bash');
  controller.finishToolMessage({ toolUseId: 'interrupted-tool', interrupted: true, isError: true });
  assert.deepEqual(controller.getSnapshot().messages.map(message => message.status), [
    'denied', 'interrupted',
  ]);
  controller.close(0);
});

test('TUI controller marks assistant streaming lifecycle for incremental Markdown rendering', () => {
  const controller = createTuiController();
  controller.beginAssistantMessage();
  controller.appendAssistantText('A growing response');
  let message = controller.getSnapshot().messages[0];
  assert.equal(message.streaming, true);
  assert.equal(message.text, 'A growing response');
  controller.finishAssistantMessage();
  message = controller.getSnapshot().messages[0];
  assert.equal(message.streaming, false);
  controller.close(0);
});
