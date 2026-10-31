import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { AgentSessionManager } from '../src/session-manager.js';
import {
  FileSessionStore,
  InMemorySessionStore,
  SessionConflictError,
  SessionNotFoundError,
} from '../src/session-store.js';

class ScriptedModel {
  constructor(scripts) { this.scripts = [...scripts]; }
  async *stream(context) {
    const script = this.scripts.shift();
    if (typeof script === 'function') { yield* script(context); return; }
    for (const event of script ?? []) yield event;
  }
}

const answer = text => [
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn' },
];
const ids = () => {
  let value = 0;
  return () => 'turn-' + (++value);
};

test('keeps history across multiple warm user turns', async () => {
  const model = new ScriptedModel([
    answer('first answer'),
    context => {
      assert.equal(context.messages.length, 3);
      assert.equal(context.messages[0].content, 'first question');
      assert.equal(context.messages[1].content[0].text, 'first answer');
      assert.equal(context.messages[2].content, 'second question');
      return answer('second answer');
    },
  ]);
  const manager = new AgentSessionManager({
    loop: new AgentLoop({ model }),
    store: new InMemorySessionStore(),
    idFactory: ids(),
  });
  await manager.create({ id: 'session-warm', metadata: { label: 'test' } });

  const first = await manager.run('session-warm', 'first question');
  assert.equal(first.session.turnCount, 1);
  assert.equal(first.session.modelRoundCount, 1);
  assert.equal(first.session.turns[0].status, 'completed');

  const second = await manager.run('session-warm', 'second question');
  assert.equal(second.session.turnCount, 2);
  assert.equal(second.session.modelRoundCount, 2);
  assert.equal(second.session.messages.length, 4);
  assert.equal(second.session.messages.at(-1).content[0].text, 'second answer');
});

test('restores a JSON-file session with a fresh manager and model adapter', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-cil-session-'));
  try {
    const firstStore = new FileSessionStore({ directory });
    const firstManager = new AgentSessionManager({
      loop: new AgentLoop({ model: new ScriptedModel([answer('persisted answer')]) }),
      store: firstStore,
      idFactory: ids(),
    });
    await firstManager.create({ id: 'session-cold', metadata: { origin: 'test' } });
    const first = await firstManager.run('session-cold', 'remember this');
    assert.equal(first.session.revision, 2);

    const storedText = await readFile(path.join(directory, 'session-cold.json'), 'utf8');
    assert.equal(JSON.parse(storedText).messages[1].content[0].text, 'persisted answer');

    const secondManager = new AgentSessionManager({
      loop: new AgentLoop({
        model: new ScriptedModel([
          context => {
            assert.equal(context.messages[0].content, 'remember this');
            assert.equal(context.messages[1].content[0].text, 'persisted answer');
            assert.equal(context.messages[2].content, 'continue after restart');
            return answer('restored successfully');
          },
        ]),
      }),
      store: new FileSessionStore({ directory }),
      idFactory: ids(),
    });
    const restored = await secondManager.get('session-cold');
    assert.equal(restored.turnCount, 1);
    const second = await secondManager.run('session-cold', 'continue after restart');
    assert.equal(second.session.turnCount, 2);
    assert.equal(second.session.messages.at(-1).content[0].text, 'restored successfully');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('records failed turns without committing their incomplete message history', async () => {
  const model = new ScriptedModel([
    async function* () { throw new Error('simulated provider outage'); },
    answer('recovered answer'),
  ]);
  const manager = new AgentSessionManager({
    loop: new AgentLoop({ model }),
    store: new InMemorySessionStore(),
    idFactory: ids(),
  });
  await manager.create({ id: 'session-retry' });

  await assert.rejects(manager.run('session-retry', 'failed input'), /simulated provider outage/);
  const afterFailure = await manager.get('session-retry');
  assert.equal(afterFailure.messages.length, 0);
  assert.equal(afterFailure.turns[0].status, 'failed');
  assert.match(afterFailure.turns[0].error.message, /provider outage/);

  const recovered = await manager.run('session-retry', 'safe follow-up');
  assert.equal(recovered.session.turnCount, 1);
  assert.equal(recovered.session.turns[1].status, 'completed');
  assert.equal(recovered.session.messages[0].content, 'safe follow-up');
});

test('reconciles a persisted in-progress turn after a known runtime interruption', async () => {
  const store = new InMemorySessionStore();
  const manager = new AgentSessionManager({
    loop: new AgentLoop({ model: new ScriptedModel([answer('unused')]) }),
    store,
    idFactory: ids(),
  });
  await manager.create({ id: 'session-interrupted' });
  let record = await manager.get('session-interrupted');
  record.turns.push({
    id: 'turn-stale',
    status: 'running',
    input: 'possibly executed',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    result: null,
    error: null,
  });
  record = await store.save(record, { expectedRevision: record.revision });

  const recovered = await manager.recoverInterruptedTurns('session-interrupted');
  assert.equal(recovered.turns[0].status, 'interrupted');
  assert.match(recovered.turns[0].error.message, /Review side effects/);
  assert.equal(recovered.messages.length, 0);
});

test('revision checks prevent stale session writes', async () => {
  const store = new InMemorySessionStore();
  await store.create({
    id: 'session-revision',
    status: 'active',
    revision: 0,
    createdAt: 'now',
    updatedAt: 'now',
    metadata: {},
    messages: [],
    turnCount: 0,
    modelRoundCount: 0,
    turns: [],
  });
  const stale = await store.get('session-revision');
  const current = await store.save(stale, { expectedRevision: 0 });
  assert.equal(current.revision, 1);
  await assert.rejects(store.save(stale, { expectedRevision: 0 }), SessionConflictError);
});

test('close blocks future turns and delete removes the stored session', async () => {
  const manager = new AgentSessionManager({
    loop: new AgentLoop({ model: new ScriptedModel([answer('unused')]) }),
    store: new InMemorySessionStore(),
    idFactory: ids(),
  });
  await manager.create({ id: 'session-close' });
  const closed = await manager.close('session-close');
  assert.equal(closed.status, 'closed');
  await assert.rejects(manager.run('session-close', 'should not run'), /closed session/);
  assert.equal(await manager.delete('session-close'), true);
  await assert.rejects(manager.get('session-close'), SessionNotFoundError);
});

test('rejects unsafe session IDs before constructing storage paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-cil-session-path-'));
  try {
    const store = new FileSessionStore({ directory });
    await assert.rejects(store.get('../outside'), TypeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
