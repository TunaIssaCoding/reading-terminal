import test from 'node:test';
import assert from 'node:assert/strict';
import { triageDecision, undoDecision } from '../js/triage.js';

const time = '2026-11-24T12:00:00.000Z';
const original = { id: 'fictional', progress: 'new', starred: false, position: 0,
  triaged_at: null, progress_changed_at: '2026-10-01T00:00:00.000Z', last_opened_at: null };
const queue = { queue: ['one', 'two'], arrivals_since: '2026-11-01T00:00:00.000Z' };

for (const [action, progress] of [['up-next', 'new'], ['keep', 'new'], ['let-go', 'let_go'], ['read', 'reading']]) {
  test(`triage ${action} stamps decision and Undo restores state and queue`, () => {
    const before = structuredClone({ original, queue });
    const decision = triageDecision(original, queue, action, time);
    const changed = { ...original, ...decision.patch };
    const nextQueue = { ...queue, queue: decision.queueAfter };
    assert.equal(changed.triaged_at, time);
    assert.equal(changed.progress, progress);
    assert.equal(changed.last_opened_at, action === 'read' ? time : null);
    assert.deepEqual(nextQueue.queue, action === 'up-next' ? ['one', 'two', 'fictional'] : ['one', 'two']);
    const restored = undoDecision(changed, nextQueue, decision);
    assert.deepEqual({ ...changed, ...restored.patch }, original);
    assert.deepEqual(restored.queue, queue);
    assert.deepEqual({ original, queue }, before);
  });
}

test('the eleventh triage add leaves both inputs untouched', () => {
  const full = { ...queue, queue: Array.from({ length: 10 }, (_, i) => `fiction-${i}`) };
  const before = structuredClone({ original, full });
  assert.equal(triageDecision(original, full, 'up-next', time), null);
  assert.equal(triageDecision(original, full, 'enqueue', time), null);
  assert.deepEqual({ original, full }, before);
});

test('reader enqueue preserves reading and Keeper; removal triages without starring', () => {
  const reading = { ...original, progress: 'reading', position: .42, starred: true };
  const addition = triageDecision(reading, queue, 'enqueue', time);
  assert.deepEqual({ ...reading, ...addition.patch }, { ...reading, triaged_at: time });
  const queued = { ...queue, queue: ['one', 'fictional', 'two'] };
  const removal = triageDecision(original, queued, 'remove', time);
  const changed = { ...original, ...removal.patch };
  assert.equal(changed.progress, 'new');
  assert.equal(changed.starred, false);
  assert.deepEqual(removal.queueAfter, ['one', 'two']);
  const restored = undoDecision(changed, { ...queued, queue: removal.queueAfter }, removal);
  assert.deepEqual(restored.queue, queued);
  assert.deepEqual({ ...changed, ...restored.patch }, original);
});

test('Let go removes queue membership and Undo restores its original position', () => {
  const queued = { ...queue, queue: ['one', 'fictional', 'two'] };
  const decision = triageDecision(original, queued, 'let-go', time);
  assert.deepEqual(decision.queueAfter, ['one', 'two']);
  const restored = undoDecision({ ...original, ...decision.patch }, { ...queued, queue: decision.queueAfter }, decision);
  assert.deepEqual(restored.queue, queued);
});

test('Undo preserves independent Keeper edits and does not overwrite a later decision', () => {
  const decision = triageDecision(original, queue, 'keep', time);
  const changed = { ...original, ...decision.patch, starred: true };
  const restored = undoDecision(changed, queue, decision);
  assert.equal({ ...changed, ...restored.patch }.starred, true);
  assert.equal(undoDecision({ ...changed, triaged_at: '2026-11-24T12:00:01.000Z' }, queue, decision), null);
});
