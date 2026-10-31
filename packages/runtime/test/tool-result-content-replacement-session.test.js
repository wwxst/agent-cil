import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSessionJournal } from '../src/legacy-session/session-storage.js';
import {
  applyToolResultBudget, buildLargeToolResultMessage, persistToolResult,
  reconstructContentReplacementState,
} from '../src/legacy-tools/tool-result-storage.js';

async function withSession(fn) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-content-replacement-'));
  const sessionId = randomUUID();
  const storage = {
    workspace,
    directory: join(workspace, '.agent-cil', 'sessions', sessionId, 'tool-results'),
  };
  let journal;
  try {
    journal = await openSessionJournal({ workspace, sessionId });
    await journal.append({
      messages: [{ role: 'user', content: 'Run the search once.' }],
      kind: 'input',
    });
    const assistant = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'grep-once', name: 'Grep', input: {} }],
    };
    const original = 'complete source output\n'.repeat(3000);
    await journal.append({
      messages: [
        { role: 'user', content: 'Run the search once.' },
        assistant,
        { role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'grep-once', content: original,
        }] },
      ],
      kind: 'tool',
    });
    await fn({ workspace, sessionId, storage, journal, original });
  } finally {
    if (journal) await journal.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

test('content replacement is a hash-chained session metadata record and survives resume', {
  timeout: 30000,
}, async () => {
  await withSession(async ({ workspace, sessionId, storage, journal, original }) => {
    const persisted = await persistToolResult(original, 'grep-once', storage);
    const replacement = buildLargeToolResultMessage(persisted);
    const records = [{
      kind: 'tool-result', toolUseId: 'grep-once', replacement,
    }];
    const before = journal.messages;
    await journal.appendContentReplacements(records);
    assert.deepEqual(journal.messages, before,
      'replacement metadata must not rewrite the durable full tool result');
    assert.deepEqual(journal.contentReplacements, records);
    assert.equal(journal.canContinueWithoutPrompt, true);
    const path = journal.path;
    await journal.close();

    const resumed = await openSessionJournal({ workspace, sessionId, resume: true });
    try {
      assert.deepEqual(resumed.contentReplacements, records);
      assert.equal(resumed.messages[2].content[0].content, original);
      const state = reconstructContentReplacementState(
        resumed.messages, resumed.contentReplacements,
      );
      const projected = await applyToolResultBudget(
        resumed.messages, state, storage, { limit: 1 },
      );
      assert.deepEqual(projected.newlyReplaced, [],
        'resume must reapply the recorded replacement without another write');
      assert.equal(projected.messages[2].content[0].content, replacement);
      assert.equal(await readFile(join(storage.directory, 'grep-once.txt'), 'utf8'), original);
      const recordsOnDisk = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(recordsOnDisk.at(-1).type, 'session_content_replacement');
      assert.equal(recordsOnDisk.at(-1).kind, 'tool_result_replacement');
    } finally {
      await resumed.close();
    }
  });
});

test('session journal rejects replacement records that point outside the session result directory', {
  timeout: 30000,
}, async () => {
  await withSession(async ({ journal, storage }) => {
    await mkdir(storage.directory, { recursive: true });
    const forged = {
      kind: 'tool-result',
      toolUseId: 'grep-once',
      replacement: '<persisted-output>\nOutput too large. Full output saved to: /tmp/forged.txt\n\nPreview\nabc\n</persisted-output>',
    };
    await assert.rejects(journal.appendContentReplacements([forged]),
      /path does not match this session tool result/);
    assert.deepEqual(journal.contentReplacements, []);
  });
});


test('resume falls back to the retained full result if its persisted preview file was deleted', {
  timeout: 30000,
}, async () => {
  await withSession(async ({ workspace, sessionId, storage, journal, original }) => {
    const persisted = await persistToolResult(original, 'grep-once', storage);
    const replacement = buildLargeToolResultMessage(persisted);
    await journal.appendContentReplacements([{
      kind: 'tool-result', toolUseId: 'grep-once', replacement,
    }]);
    await journal.close();
    await rm(join(storage.directory, 'grep-once.txt'), { force: true });

    const resumed = await openSessionJournal({ workspace, sessionId, resume: true });
    try {
      assert.deepEqual(resumed.contentReplacements, [],
        'a stale path preview is not re-applied when its backing file is gone');
      assert.equal(resumed.messages[2].content[0].content, original,
        'the journal still contains the complete successful tool result');
    } finally {
      await resumed.close();
    }
  });
});
