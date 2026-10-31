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
  controller.setModel('model-after-command');
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.locale, 'zh-CN');
  assert.equal(snapshot.model, 'model-after-command');
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
  const [root, app] = await Promise.all([
    import('../../../legacy/2.1.88/restored-src/src/ink/root.ts'),
    import('../src/tui/AgentTui.tsx'),
  ]);
  assert.equal(typeof root.default, 'function');
  assert.equal(typeof app.default, 'function');
});
