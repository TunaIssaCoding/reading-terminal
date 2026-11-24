const EPOCH = '1970-01-01T00:00:00.000Z';
const PROGRESS = new Set(['new', 'reading', 'finished', 'let_go']);
const LEGACY_FIELDS = new Set(['status', 'status_changed_at', 'status_updated_at', 'status_changed_at_updated_at', 'commented_from', 'commented_from_updated_at']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'constructor', 'prototype'].includes(key);

/** Bot metadata stays read-only; missing summaries are supplied by the reader's lede. */
export function libraryFields(record) {
  const fields = { ...record };
  fields.added_at = record.added_at || record.created_at || '';
  fields.read_minutes = Number.isFinite(record.read_minutes) ? record.read_minutes : Math.ceil((Number.isFinite(record.words) ? record.words : 0) / 230);
  fields.source_label = record.source_label || record.source_type || '';
  return fields;
}

/** Read sparse state without materializing untouched library records. */
export function effectiveState(record = {}, entry = {}, time = EPOCH) {
  const legacy = { ...record, ...entry };
  if (Object.hasOwn(entry, 'status')) legacy.commented_from = entry.commented_from;
  const progress = PROGRESS.has(legacy.progress) ? legacy.progress
    : legacy.status === 'read' ? 'finished' : legacy.status === 'commented'
      ? legacy.commented_from === 'unread' ? 'reading' : 'finished' : 'new';
  return {
    progress,
    position: Number.isFinite(legacy.position) ? legacy.position : 0,
    starred: typeof legacy.starred === 'boolean' ? legacy.starred : false,
    triaged_at: PROGRESS.has(legacy.progress) ? legacy.triaged_at || null : progress === 'new' ? null : time,
    progress_changed_at: legacy.progress_changed_at || legacy.status_changed_at || legacy.updated_at || time,
    last_opened_at: legacy.last_opened_at || null,
  };
}

/** Convert legacy user state once, without mutating user or bot data. */
export function migrateState(input, library = [], time = EPOCH) {
  if (input != null && !object(input)) throw new Error('Invalid user state: expected an object keyed by article id.');
  const source = input || {};
  const state = structuredClone(source);
  const entries = Object.entries(source);
  for (const [id, entry] of entries) {
    if (!safeKey(id) || !id || !object(entry)) throw new Error('Invalid article state entry.');
  }
  // New arrivals need no state write. Only non-default library legacy values
  // need materializing during the initial cutover, never on all-v2 loads.
  const allV2 = entries.length > 0 && entries.every(([, entry]) => PROGRESS.has(entry.progress));
  const records = new Map(library.map(record => [String(record.id || record.slug), record]));
  if (!allV2) for (const [id, record] of records) {
    const nonDefault = (record.status != null && record.status !== 'unread') || record.starred === true;
    if (safeKey(id) && !Object.hasOwn(state, id) && !PROGRESS.has(record.progress) && nonDefault) state[id] = {};
  }
  let changed = false;
  for (const [id, entry] of Object.entries(state)) {
    if (PROGRESS.has(entry.progress)) {
      for (const field of LEGACY_FIELDS) {
        if (Object.hasOwn(entry, field)) { delete entry[field]; changed = true; }
        if (object(entry._timestamps) && Object.hasOwn(entry._timestamps, field)) {
          delete entry._timestamps[field];
          changed = true;
        }
      }
      continue;
    }
    const record = records.get(id) || {};
    const current = effectiveState(record, entry, time);
    const timestamps = object(entry._timestamps) ? { ...entry._timestamps } : {};
    for (const field of LEGACY_FIELDS) { delete entry[field]; delete timestamps[field]; }
    const changedAt = current.progress_changed_at;
    Object.assign(entry, current, { _timestamps: timestamps });
    for (const field of ['progress', 'position', 'starred', 'triaged_at', 'progress_changed_at', 'last_opened_at']) {
      timestamps[field] ||= field === 'progress' || field === 'progress_changed_at' ? changedAt : time;
    }
    changed = true;
  }
  return { state, changed };
}

/** Post-boundary arrivals are untriaged; the older pile also requires new progress. */
export function splitArrivals(items, state = {}, arrivals_since) {
  const arrivals = [];
  const pile = [];
  const threshold = Date.parse(arrivals_since);
  for (const item of items) {
    const current = effectiveState(item, state[item.id || item.slug]);
    const added = Date.parse(libraryFields(item).added_at);
    if (current.triaged_at || !Number.isFinite(added) || !Number.isFinite(threshold)) continue;
    if (added >= threshold) arrivals.push(item);
    else if (current.progress === 'new') pile.push(item);
  }
  return { arrivals, pile };
}

export function defaultView(queueIds, arrivals) {
  // Phase 4 can insert the Edition default here.
  return queueIds.length ? 'queue' : arrivals.length ? 'arrivals' : 'library';
}

export function pileThisWeek(items, state, arrivals_since, date = new Date()) {
  const now = date.getTime();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const threshold = Date.parse(arrivals_since);
  const current = splitArrivals(items, state, arrivals_since).pile.length;
  let start = current;
  for (const item of items) {
    const added = Date.parse(libraryFields(item).added_at);
    const triaged = Date.parse(effectiveState(item, state?.[item.id || item.slug]).triaged_at);
    if (added < threshold && triaged >= monday.getTime() && triaged <= now) start += 1;
  }
  return { start, current };
}

export function libraryShelves(items, arrivals_since, date = new Date()) {
  const shelves = { started: [], keepers: [], short: [], pile: splitArrivals(items, {}, arrivals_since).pile };
  const cutoff = date.getTime() - 60 * 24 * 60 * 60 * 1000;
  for (const item of items) {
    const current = effectiveState(item);
    if (current.progress === 'reading') shelves.started.push(item);
    if (current.starred && (!current.last_opened_at || Date.parse(current.last_opened_at) < cutoff)) shelves.keepers.push(item);
    if (current.progress === 'new' && libraryFields(item).read_minutes <= 10) shelves.short.push(item);
  }
  return shelves;
}
