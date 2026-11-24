const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Capture only fields this decision owns; unrelated notes/Keeper edits survive Undo. */
export function triageDecision(item, queue, action, time) {
  const ids = queue.queue;
  if ((action === 'up-next' || action === 'enqueue') && !ids.includes(item.id) && ids.length >= 10) return null;
  const patch = { triaged_at: time };
  if (action === 'up-next' || action === 'keep') patch.progress = 'new';
  if (action === 'let-go') patch.progress = 'let_go';
  if (action === 'read') {
    patch.last_opened_at = time;
    if (item.progress === 'new') patch.progress = 'reading';
  }
  if (patch.progress && patch.progress !== item.progress) patch.progress_changed_at = time;
  const before = {};
  for (const field of Object.keys(patch)) before[field] = item[field] === undefined ? null : item[field];
  let next = ids.slice();
  if ((action === 'up-next' || action === 'enqueue') && !ids.includes(item.id)) next.push(item.id);
  if (action === 'let-go' || action === 'remove') next = next.filter(id => id !== item.id);
  return { id: item.id, action, before, patch, queueBefore: ids.slice(), queueAfter: next };
}
/** Revert owned state fields and the queue snapshot for a queue-changing decision. */
export function undoDecision(item, queue, decision) {
  if (!item || Object.keys(decision.patch).some(field => !same(item[field], decision.patch[field]))) return null;
  const changedQueue = !same(decision.queueBefore, decision.queueAfter);
  const ids = changedQueue ? decision.queueBefore.slice() : queue.queue.slice();
  return { patch: { ...decision.before }, queue: { ...queue, queue: ids } };
}
