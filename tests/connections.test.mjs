import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionDecision, undoConnection } from '../js/connections.js';

const river = { slug: 'river-map', title: 'River map' };
const cloud = { slug: 'cloud-atlas', title: 'Cloud atlas' };

test('keeping deduplicates both memberships and clears the target hidden membership', () => {
  const before = {
    long_notes: 'Keep my writing.', highlights: [{ id: 'margin', note: 'A question' }],
    links: [cloud, cloud], hidden_links: ['river-map', 'river-map', 'field-book', 'field-book'],
  };
  const snapshot = structuredClone(before);
  const kept = connectionDecision(before, 'keep', river);
  assert.deepEqual(kept, { ...before, links: [cloud, river], hidden_links: ['field-book'] });
  assert.deepEqual(connectionDecision(kept, 'keep', river), kept);
  assert.deepEqual(before, snapshot);
});

test('keeping an existing link preserves its saved metadata without creating duplicates', () => {
  const original = { ...river, source: 'my notebook' };
  const notes = { links: [original, river], hidden_links: ['river-map', 'cloud-atlas', 'cloud-atlas'] };
  const next = connectionDecision(notes, 'keep', { ...river, title: 'New title' });
  assert.deepEqual(next.links, [original]);
  assert.deepEqual(next.hidden_links, ['cloud-atlas']);
});

test('unkeep removes only the target link and leaves hidden choices intact', () => {
  const notes = { links: [river, river, cloud, cloud], hidden_links: ['river-map', 'river-map'], long_notes: 'Independent notes' };
  const next = connectionDecision(notes, 'unkeep', 'river-map');
  assert.deepEqual(next, { ...notes, links: [cloud], hidden_links: ['river-map'] });
  assert.deepEqual(connectionDecision(next, 'unkeep', 'river-map'), next);
});

test('hide and show change only hidden membership and deduplicate persisted arrays', () => {
  const before = { links: [river, river], hidden_links: ['cloud-atlas', 'cloud-atlas'], updated_at: 'unchanged' };
  const hidden = connectionDecision(before, 'hide', 'river-map');
  assert.deepEqual(hidden, { ...before, links: [river], hidden_links: ['cloud-atlas', 'river-map'] });
  assert.deepEqual(connectionDecision(hidden, 'hide', 'river-map'), hidden);
  const shown = connectionDecision(hidden, 'show', 'river-map');
  assert.deepEqual(shown, { ...before, links: [river], hidden_links: ['cloud-atlas'] });
  assert.deepEqual(connectionDecision(shown, 'show', 'river-map'), shown);
});

test('Undo Keep restores its prior hidden choice while preserving later notes and other connections', () => {
  const before = { links: [cloud], hidden_links: ['river-map'], long_notes: 'Before' };
  const after = connectionDecision(before, 'keep', river);
  const current = {
    ...after, long_notes: 'New writing', highlights: [{ id: 'new-highlight', note: 'Keep this' }],
    links: [...after.links, { slug: 'field-book', title: 'Field book' }], hidden_links: ['island-log'],
  };
  const snapshot = structuredClone(current);
  const restored = undoConnection(current, before, after, 'river-map');
  assert.deepEqual(restored, {
    ...current, links: [cloud, { slug: 'field-book', title: 'Field book' }], hidden_links: ['river-map', 'island-log'],
  });
  assert.deepEqual(current, snapshot);
});

test('Undo Unkeep restores the original link at its former position without removing new links', () => {
  const before = { links: [river, cloud], hidden_links: [] };
  const after = connectionDecision(before, 'unkeep', 'river-map');
  const current = { ...after, links: [...after.links, { slug: 'field-book', title: 'Field book' }] };
  assert.deepEqual(undoConnection(current, before, after, 'river-map').links, [river, cloud, { slug: 'field-book', title: 'Field book' }]);
});

test('Undo Hide and Show preserve independent hidden decisions', () => {
  const before = { links: [river], hidden_links: ['cloud-atlas'] };
  const hidden = connectionDecision(before, 'hide', 'river-map');
  const current = { ...hidden, hidden_links: [...hidden.hidden_links, 'field-book'], long_notes: 'After' };
  assert.deepEqual(undoConnection(current, before, hidden, 'river-map'), { ...current, hidden_links: ['cloud-atlas', 'field-book'] });
  const shown = connectionDecision(hidden, 'show', 'river-map');
  assert.deepEqual(undoConnection({ ...shown, hidden_links: ['cloud-atlas', 'field-book'] }, hidden, shown, 'river-map').hidden_links,
    ['cloud-atlas', 'river-map', 'field-book']);
});

test('Undo cannot overwrite newer target membership or saved link content', () => {
  const before = { links: [], hidden_links: [] };
  const after = connectionDecision(before, 'keep', river);
  const hiddenLater = connectionDecision(after, 'hide', 'river-map');
  assert.deepEqual(undoConnection(hiddenLater, before, after, 'river-map'), hiddenLater);
  const renamedLater = { ...after, links: [{ ...river, title: 'My revised title' }] };
  assert.deepEqual(undoConnection(renamedLater, before, after, 'river-map'), renamedLater);
  const unkept = connectionDecision(after, 'unkeep', 'river-map');
  assert.deepEqual(undoConnection(unkept, before, after, 'river-map'), unkept);
});
