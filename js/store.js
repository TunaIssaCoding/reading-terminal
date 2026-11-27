import { demoLibrary, demoArticles, demoNotes, demoSummaries, demoState, demoMeta, demoQueue, demoEdition } from './demo.js';
import { migrateState, libraryFields } from './model.js';
import { localDate, parseEdition } from './edition.js';

const SETTINGS_KEY = 'reading-terminal.settings';
const DATABASE = 'reading-terminal-cache';
const DEFAULT_SETTINGS = Object.freeze({ owner: 'TunaIssaCoding', repo: 'reading-data', branch: 'main', token: '' });
const EPOCH = '1970-01-01T00:00:00.000Z';
const STATE_FIELDS = ['progress', 'position', 'starred', 'triaged_at', 'progress_changed_at', 'last_opened_at'];
const PROGRESS = new Set(['new', 'reading', 'finished', 'let_go']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// GitHub allows 500 commits an hour. Commit after a 2 s pause, but at most once every 10 s (360 an hour).
const COMMIT_PAUSE_MS = 2000;
const COMMIT_GAP_MS = 10000;
const RATE_LIMIT_WAIT_MS = 60000;

/** How long GitHub asked us to wait, in ms, or 0 when a 403 is not a rate limit. The body is searched, never shown. */
function rateLimitWait(response, body, now = Date.now()) {
  const seconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    return Math.max(RATE_LIMIT_WAIT_MS, Number.isFinite(reset) ? reset - now : 0);
  }
  return response.status === 429 || /rate limit/i.test(body) ? RATE_LIMIT_WAIT_MS : 0;
}
const clone = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const newest = (...values) => values.filter(value => typeof value === 'string').sort((a, b) => stamp(b) - stamp(a) || b.localeCompare(a))[0] || EPOCH;
const dictionary = value => value && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => typeof key === 'string' && key.length > 0 && !FORBIDDEN_KEYS.has(key);

function settingsValue(value = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => [key,
    typeof value[key] === 'string' ? value[key].trim() || fallback : fallback,
  ]));
}

export function getSettings() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) || '{}');
    return settingsValue(dictionary(value) ? value : {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  const value = settingsValue(settings);
  if (!globalThis.localStorage) throw new Error('Device storage is unavailable. Connection settings could not be saved.');
  globalThis.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  return { ...value };
}

function safeSlug(slug) {
  if (!safeKey(slug) || slug === '.' || slug === '..' || /[\\/\u0000-\u001f\u007f]/.test(slug)) {
    throw new Error('This article has an unsafe or missing slug. Use a single filename without path separators.');
  }
  return slug;
}

function writablePath(path) {
  if (path === 'user/state.json' || path === 'user/queue.json') return true;
  const match = /^user\/notes\/([^/]+)\.json$/.exec(path);
  if (!match) return false;
  try { safeSlug(match[1]); return true; } catch { return false; }
}

function noteSlug(path) {
  return path.slice('user/notes/'.length, -'.json'.length);
}

function emptyNotes() {
  return { long_notes: '', highlights: [], links: [], hidden_links: [], updated_at: EPOCH, long_notes_updated_at: EPOCH, deleted_highlights: {} };
}

function normalizeNotes(input) {
  if (input == null) return emptyNotes();
  if (!dictionary(input) || (input.long_notes !== undefined && typeof input.long_notes !== 'string') ||
      (input.highlights !== undefined && !Array.isArray(input.highlights)) ||
      (input.links !== undefined && !Array.isArray(input.links)) ||
      (input.hidden_links !== undefined && !Array.isArray(input.hidden_links))) {
    throw new Error('Invalid notes data: expected text and highlights, links and hidden_links arrays.');
  }
  const result = {
    long_notes: input.long_notes || '', highlights: [],
    links: mergeLinks(input.links || []), hidden_links: [...new Set((input.hidden_links || []).map(safeSlug))].sort(),
    updated_at: newest(input.updated_at),
    long_notes_updated_at: newest(input.long_notes_updated_at || input.updated_at),
    deleted_highlights: {},
  };
  if (dictionary(input.deleted_highlights)) {
    for (const [id, time] of Object.entries(input.deleted_highlights)) {
      if (safeKey(id)) result.deleted_highlights[id] = newest(typeof time === 'string' ? time : time?.updated_at);
    }
  }
  const highlights = new Map();
  for (const entry of input.highlights || []) {
    if (!dictionary(entry) || !safeKey(entry.id)) throw new Error('Invalid highlight: every highlight needs a stable id.');
    const updated = newest(entry.updated_at || entry.created_at || input.updated_at);
    if (entry.deleted) {
      result.deleted_highlights[entry.id] = newest(result.deleted_highlights[entry.id], updated);
      continue;
    }
    const value = {
      id: entry.id, quote: String(entry.quote || ''), prefix: String(entry.prefix || ''), suffix: String(entry.suffix || ''),
      para: Number.isInteger(entry.para) && entry.para >= 0 ? entry.para : 0,
      note: String(entry.note || ''), created_at: newest(entry.created_at || updated), updated_at: updated,
    };
    if (Number.isInteger(entry.start) && entry.start >= 0) value.start = entry.start;
    if (typeof entry.still_agree_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.still_agree_at) &&
        Number.isFinite(Date.parse(entry.still_agree_at))) value.still_agree_at = entry.still_agree_at;
    const previous = highlights.get(value.id);
    if (!previous || stamp(updated) > stamp(previous.updated_at) ||
        (stamp(updated) === stamp(previous.updated_at) && JSON.stringify(value) > JSON.stringify(previous))) highlights.set(value.id, value);
  }
  for (const [id, entry] of highlights) {
    const deleted = result.deleted_highlights[id];
    if (deleted && stamp(deleted) >= stamp(entry.updated_at)) continue;
    delete result.deleted_highlights[id];
    result.highlights.push(entry);
  }
  result.highlights.sort((a, b) => a.para - b.para || stamp(a.created_at) - stamp(b.created_at) || a.id.localeCompare(b.id));
  return result;
}

function mergeLinks(...lists) {
  const links = new Map();
  for (const list of lists) for (const link of list) {
    if (!dictionary(link) || typeof link.title !== 'string') throw new Error('Invalid note link: expected slug and title.');
    const slug = safeSlug(link.slug);
    const previous = links.get(slug);
    if (!previous || link.title.localeCompare(previous.title) > 0) links.set(slug, { slug, title: link.title });
  }
  return [...links.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function mergeHiddenLinks(a, b, base) {
  const left = new Set(a);
  const right = new Set(b);
  const ancestor = new Set(base);
  return [...new Set([...a, ...b])].filter(slug => ancestor.has(slug)
    ? left.has(slug) && right.has(slug) : left.has(slug) || right.has(slug)).sort();
}

function mergeKeptLinks(a, b, base) {
  const membership = new Set(mergeHiddenLinks(a.map(link => link.slug), b.map(link => link.slug), base.map(link => link.slug)));
  return mergeLinks(a, b).filter(link => membership.has(link.slug));
}

function mergeHighlight(left, right, before, winner) {
  if (!left || !right) return clone(winner);
  const content = highlight => {
    const { still_agree_at, updated_at, ...fields } = highlight || {};
    return fields;
  };
  // An agreement-only edit must not replace an independently edited quote or note.
  const selected = equal(content(left), content(before)) ? right
    : equal(content(right), content(before)) ? left : winner;
  const result = { ...selected, updated_at: newest(left.updated_at, right.updated_at) };
  const agreement = left.still_agree_at === right.still_agree_at ? left.still_agree_at
    : left.still_agree_at === before?.still_agree_at ? right.still_agree_at
      : right.still_agree_at === before?.still_agree_at ? left.still_agree_at
        : winner.still_agree_at;
  if (agreement === undefined) delete result.still_agree_at;
  else result.still_agree_at = agreement;
  return result;
}

function longNoteMerge(local, remote, base) {
  const a = local.long_notes;
  const b = remote.long_notes;
  if (a === b) return { text: a, time: newest(local.long_notes_updated_at, remote.long_notes_updated_at) };
  if (a === base.long_notes) return { text: b, time: remote.long_notes_updated_at };
  if (b === base.long_notes) return { text: a, time: local.long_notes_updated_at };
  // A previously reconciled version already contains the other complete version.
  // Do not repeatedly nest the same conflict when an offline retry sees it again.
  if (a.includes('<<<<<<< Notes conflict:') && b && a.includes(b)) return { text: a, time: local.long_notes_updated_at };
  if (b.includes('<<<<<<< Notes conflict:') && a && b.includes(a)) return { text: b, time: remote.long_notes_updated_at };
  const localFirst = stamp(local.long_notes_updated_at) > stamp(remote.long_notes_updated_at) ||
    (stamp(local.long_notes_updated_at) === stamp(remote.long_notes_updated_at) && a.localeCompare(b) >= 0);
  const first = localFirst ? local : remote;
  const second = localFirst ? remote : local;
  return {
    text: `<<<<<<< Notes conflict: newer version (${first.long_notes_updated_at})\n${first.long_notes}\n======= Other version (${second.long_notes_updated_at})\n${second.long_notes}\n>>>>>>> Both versions kept; edit this section to reconcile.`,
    time: newest(local.long_notes_updated_at, remote.long_notes_updated_at),
  };
}

/** Three-way merge. Neither input is mutated; concurrent long-text edits keep both versions. */
export function mergeNotes(local, remote, base = null) {
  const a = normalizeNotes(local);
  const b = normalizeNotes(remote);
  const ancestor = normalizeNotes(base);
  const text = longNoteMerge(a, b, ancestor);
  const am = new Map(a.highlights.map(highlight => [highlight.id, highlight]));
  const bm = new Map(b.highlights.map(highlight => [highlight.id, highlight]));
  const old = new Map(ancestor.highlights.map(highlight => [highlight.id, highlight]));
  const ids = new Set([...am.keys(), ...bm.keys(), ...old.keys(), ...Object.keys(a.deleted_highlights), ...Object.keys(b.deleted_highlights), ...Object.keys(ancestor.deleted_highlights)]);
  const result = {
    long_notes: text.text, highlights: [], updated_at: newest(a.updated_at, b.updated_at),
    long_notes_updated_at: text.time, deleted_highlights: {},
    links: mergeKeptLinks(a.links, b.links, ancestor.links), hidden_links: mergeHiddenLinks(a.hidden_links, b.hidden_links, ancestor.hidden_links),
  };
  for (const id of [...ids].sort()) {
    const left = am.get(id);
    const right = bm.get(id);
    const candidates = [
      left && { value: left, time: left.updated_at, deleted: false },
      right && { value: right, time: right.updated_at, deleted: false },
    ].filter(Boolean);
    let deleted = newest(a.deleted_highlights[id], b.deleted_highlights[id], ancestor.deleted_highlights[id]);
    let hasDeletion = Boolean(a.deleted_highlights[id] || b.deleted_highlights[id] || ancestor.deleted_highlights[id]);
    // Older clients may express deletion by omission instead of a tombstone.
    if (old.has(id) && (!left || !right)) {
      hasDeletion = true;
      deleted = newest(deleted, !left ? a.updated_at : undefined, !right ? b.updated_at : undefined);
    }
    if (hasDeletion) candidates.push({ time: deleted, deleted: true });
    candidates.sort((x, y) => stamp(y.time) - stamp(x.time) || Number(y.deleted) - Number(x.deleted) ||
      JSON.stringify(y.value || '').localeCompare(JSON.stringify(x.value || '')));
    const winner = candidates[0];
    if (!winner) continue;
    if (winner.deleted) result.deleted_highlights[id] = winner.time;
    else result.highlights.push(mergeHighlight(left, right, old.get(id), winner.value));
  }
  result.highlights.sort((x, y) => x.para - y.para || stamp(x.created_at) - stamp(y.created_at) || x.id.localeCompare(y.id));
  return result;
}

function normalizeState(input) {
  if (input == null) return {};
  if (!dictionary(input)) throw new Error('Invalid user state: expected an object keyed by article id.');
  const state = {};
  for (const [id, entry] of Object.entries(input)) {
    if (!safeKey(id) || !dictionary(entry)) throw new Error('Invalid article state entry.');
    const item = clone(entry);
    item._timestamps = dictionary(entry._timestamps) ? { ...entry._timestamps } : {};
    for (const field of STATE_FIELDS) {
      if (entry[field] === undefined) continue;
      if (field === 'progress' && !PROGRESS.has(entry[field])) throw new Error(`Invalid reading progress for ${id}.`);
      if (field === 'position' && (!Number.isFinite(entry[field]) || entry[field] < 0 || entry[field] > 1)) throw new Error(`Invalid reading position for ${id}.`);
      if (field === 'starred' && typeof entry[field] !== 'boolean') throw new Error(`Invalid starred flag for ${id}.`);
      if (field.endsWith('_at') && entry[field] !== null && typeof entry[field] !== 'string') throw new Error(`Invalid timestamp for ${id}.`);
      item._timestamps[field] = newest(entry._timestamps?.[field] || entry[`${field}_updated_at`] ||
        entry.updated_at || (field === 'last_opened_at' ? entry.last_opened_at : entry.progress_changed_at));
    }
    state[id] = item;
  }
  return state;
}

export function mergeState(local, remote, base = {}) {
  const a = normalizeState(local);
  const b = normalizeState(remote);
  const ancestor = normalizeState(base);
  const result = {};
  for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const item = { _timestamps: { ...a[id]?._timestamps, ...b[id]?._timestamps } };
    const fields = new Set([...Object.keys(a[id] || {}), ...Object.keys(b[id] || {})]);
    fields.delete('_timestamps');
    for (const field of fields) {
      if (!safeKey(field)) continue;
      const left = a[id]?.[field];
      const right = b[id]?.[field];
      const before = ancestor[id]?.[field];
      const lt = a[id]?._timestamps?.[field] || EPOCH;
      const rt = b[id]?._timestamps?.[field] || EPOCH;
      let useLeft;
      if (equal(left, right)) useLeft = true;
      else if (equal(left, before)) useLeft = false;
      else if (equal(right, before)) useLeft = true;
      else if (left === undefined) useLeft = false;
      else if (right === undefined) useLeft = true;
      else useLeft = stamp(lt) > stamp(rt) || (stamp(lt) === stamp(rt) && STATE_FIELDS.includes(field) && JSON.stringify(left) >= JSON.stringify(right));
      const selected = useLeft ? left : right;
      if (selected !== undefined) {
        item[field] = clone(selected);
        if (STATE_FIELDS.includes(field) || a[id]?._timestamps?.[field] || b[id]?._timestamps?.[field]) {
          item._timestamps[field] = equal(left, right) ? newest(lt, rt) : useLeft ? lt : rt;
        }
      }
    }
    result[id] = item;
  }
  return result;
}

/** Conversion is not a user edit: re-convert the ancestor and fresh remote on every retry. */
export function mergeMigratingState(local, remote, base, library, time) {
  return mergeState(local, migrateState(remote, library, time).state, migrateState(base, library, time).state);
}

function normalizeQueue(input) {
  if (input == null) return null;
  if (!dictionary(input) || !Array.isArray(input.queue) || typeof input.arrivals_since !== 'string' ||
      !Number.isFinite(Date.parse(input.arrivals_since))) throw new Error('Invalid reading queue: expected queue and arrivals_since.');
  for (const id of input.queue) if (!safeKey(id)) throw new Error('Invalid reading queue: article ids must be non-empty strings.');
  const queue = [...new Set(input.queue)];
  if (queue.length > 10) throw new Error('Up next is full. Finish or remove one first.');
  return { ...clone(input), queue };
}

/** Remote order wins concurrent changes; only additions and removals relative to base are replayed. */
export function mergeQueue(local, remote, base = null) {
  const a = normalizeQueue(local);
  const b = normalizeQueue(remote);
  const ancestor = normalizeQueue(base);
  if (!a) throw new Error('Invalid reading queue: a local queue is required.');
  if (!b) return a;
  const result = { ...b };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'queue' || !safeKey(key)) continue;
    const value = equal(b[key], ancestor?.[key]) && a[key] !== undefined ? a[key]
      : b[key] !== undefined ? b[key] : a[key];
    if (value !== undefined) result[key] = clone(value);
  }
  // The original arrival boundary belongs to the repository, not this device.
  result.arrivals_since = b.arrivals_since;
  const before = ancestor?.queue || [];
  if (equal(b.queue, before)) result.queue = a.queue.slice();
  else {
    const localIds = new Set(a.queue);
    const baseIds = new Set(before);
    const removed = new Set(before.filter(id => !localIds.has(id)));
    const queue = b.queue.filter(id => !removed.has(id));
    const present = new Set(queue);
    for (const id of a.queue) if (!baseIds.has(id) && !present.has(id)) {
      queue.push(id);
      present.add(id);
    }
    result.queue = queue.slice(0, 10);
  }
  return result;
}

function normalizeLibrary(input) {
  if (!Array.isArray(input)) throw new Error('library.json must contain an array of articles.');
  const ids = new Set();
  const slugs = new Set();
  return input.map(entry => {
    if (!dictionary(entry)) throw new Error('library.json contains an invalid article.');
    const slug = safeSlug(entry.slug);
    const id = String(entry.id || slug);
    if (!safeKey(id) || ids.has(id) || slugs.has(slug)) throw new Error('Library article ids and slugs must be unique.');
    ids.add(id); slugs.add(slug);
    return {
      ...libraryFields(entry), id, slug, title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : slug,
      title_is_generated: Boolean(entry.title_is_generated), author: String(entry.author || ''), handle: String(entry.handle || ''),
      url: String(entry.url || ''), created_at: String(entry.created_at || ''), source_type: String(entry.source_type || ''),
      words: Number.isFinite(entry.words) ? entry.words : 0,
      tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
      images: Array.isArray(entry.images) ? entry.images : [],
    };
  });
}

function normalizeContent(path, content) {
  if (path === 'library.json') return normalizeLibrary(content);
  if (path === 'user/state.json') return normalizeState(content);
  if (path === 'user/queue.json') return normalizeQueue(content);
  if (path.startsWith('user/notes/')) return normalizeNotes(content);
  if (path === 'bot/meta.json') {
    if (!dictionary(content)) throw new Error('bot/meta.json must contain an object.');
    return { ...content };
  }
  return content;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('The local save could not be committed.'));
  });
}

function openCacheDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB is unavailable. Enable browser storage for offline reading.'));
    const request = indexedDB.open(DATABASE, 2);
    let failed = false;
    request.onupgradeneeded = () => {
      for (const name of ['cache', 'queue', 'backups']) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('namespace', 'namespace');
        }
      }
    };
    request.onsuccess = () => {
      if (failed) request.result.close();
      else resolve(request.result);
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(new Error('Could not open the local reading cache. Check browser storage and close other Reading Terminal tabs.'));
    };
  });
}

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64Text(text) {
  const binary = atob(text.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
}

/** Browser-only persistence, with no DOM access until an instance is constructed. */
export class ReadingStore extends EventTarget {
  constructor(settings = getSettings()) {
    super();
    this.settings = settingsValue(settings);
    this.demo = !this.settings.token;
    this.namespace = this.demo ? 'demo:v2' : JSON.stringify([this.settings.owner.toLowerCase(), this.settings.repo.toLowerCase(), this.settings.branch]);
    this._journalKey = `reading-terminal.pending:${this.namespace}`;
    this._cache = new Map();
    this._queue = new Map();
    this._versions = new Map();
    this._reads = new Map();
    this._assetUrls = new Map();
    this._revision = Date.now();
    this._clock = Date.now();
    this._persistTail = Promise.resolve();
    this._db = null;
    this._ready = null;
    this._initPromise = null;
    this._flushPromise = null;
    this._timer = null;
    this._drain = false;
    this._lastCommitAt = 0;
    this._retryAt = 0;
    this._disposed = false;
    this._locking = false;
    this._lockPromise = null;
    this._closePromise = null;
    this._controllers = new Set();
  }

  _emit(status, message) {
    if (!this._disposed) this.dispatchEvent(new CustomEvent('change', { detail: { status, message } }));
  }
  _error(error) {
    if (this._disposed) return;
    this._lastError = error;
    this._emit('error', error.message || 'Sync failed. Your queued edits are retained on this device.');
  }
  _key(path) { return `${this.namespace}\n${path}`; }
  _now() { this._clock = Math.max(Date.now(), this._clock + 1); return new Date(this._clock).toISOString(); }
  _ensureReady() { return this._ready ||= this._load(); }
  _assertActive() {
    if (this._disposed) throw new Error('This library is locked or disconnected. Unlock it to continue.');
  }
  _assertOpen() {
    this._assertActive();
    if (this._locking) throw new Error('This library is locking. Unlock it to continue.');
  }

  async _load() {
    if (this.demo) {
      try {
        const storage = globalThis.localStorage;
        for (let index = (storage?.length || 0) - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (key === 'demo:v1' || key?.endsWith(':demo:v1')) storage.removeItem(key);
        }
      } catch (error) { this._error(new Error(`Could not clear legacy demo preferences: ${error.message}`)); }
    }
    try {
      this._db = await openCacheDatabase();
      if (this._disposed) return;
      this._db.onversionchange = () => { this._db.close(); this._db = null; this._error(new Error('The local cache changed in another tab. Reload to continue saving offline.')); };
      if (this.demo) {
        const cleanup = this._db.transaction(['cache', 'queue', 'backups'], 'readwrite');
        const done = transactionResult(cleanup);
        for (const name of ['cache', 'queue', 'backups']) {
          const request = cleanup.objectStore(name).index('namespace').openCursor('demo:v1');
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
          };
        }
        await done;
        if (this._disposed) return;
      }
      const transaction = this._db.transaction(['cache', 'queue'], 'readonly');
      const [cache, queue] = await Promise.all(['cache', 'queue'].map(name => requestResult(transaction.objectStore(name).index('namespace').getAll(this.namespace))));
      if (this._disposed) return;
      for (const record of cache) if (!this._cache.has(record.path)) {
        if (record.path === 'library.json') record.content = normalizeLibrary(record.content);
        this._cache.set(record.path, record);
      }
      for (const entry of queue) {
        if (!writablePath(entry.path)) continue;
        this._revision = Math.max(this._revision, entry.revision || 0);
        if (!this._queue.has(entry.path)) this._queue.set(entry.path, {
          ...entry, createOnly: entry.path === 'user/queue.json' ? entry.createOnly !== false : undefined,
          content: normalizeContent(entry.path, entry.content),
        });
      }
    } catch (error) {
      if (this._disposed) return;
      this._db = null;
      this._error(new Error(`${error.message} Pending text will also use a device recovery journal when available.`));
    }
    try {
      const journal = JSON.parse(globalThis.localStorage?.getItem(this._journalKey) || '[]');
      if (Array.isArray(journal)) for (const entry of journal) {
        if (!entry || !writablePath(entry.path)) continue;
        const previous = this._queue.get(entry.path);
        if (!previous || entry.revision > previous.revision) this._queue.set(entry.path, {
          ...entry, key: this._key(entry.path), namespace: this.namespace,
          createOnly: entry.path === 'user/queue.json' ? entry.createOnly !== false : undefined,
          content: normalizeContent(entry.path, entry.content),
        });
        this._revision = Math.max(this._revision, entry.revision || 0);
      }
    } catch (error) { this._error(new Error(`Could not read the device recovery journal: ${error.message}`)); }
    if (this.demo) {
      const seeds = { 'library.json': demoLibrary, 'user/state.json': demoState, 'user/queue.json': demoQueue, 'bot/meta.json': demoMeta };
      for (const [slug, text] of Object.entries(demoArticles)) seeds[`articles/${slug}.md`] = text;
      for (const [slug, notes] of Object.entries(demoNotes)) seeds[`user/notes/${slug}.json`] = notes;
      for (const [slug, text] of Object.entries(demoSummaries)) seeds[`bot/summaries/${slug}.md`] = text;
      const edition = demoEdition();
      seeds[`bot/editions/${edition.date}.json`] = edition;
      for (const [path, content] of Object.entries(seeds)) if (!path.startsWith('user/') || !this._cache.has(path)) {
        this._putCache(path, normalizeContent(path, clone(content)), null, JSON.stringify(content));
      }
    }
    for (const entry of this._queue.values()) this._putCache(entry.path, clone(entry.content), this._cache.get(entry.path)?.sha || null);
    if (this._db) {
      const transaction = this._db.transaction(['cache', 'queue'], 'readwrite');
      const done = transactionResult(transaction);
      for (const record of this._cache.values()) transaction.objectStore('cache').put(record);
      for (const entry of this._queue.values()) transaction.objectStore('queue').put(entry);
      await done;
    }
  }

  _putCache(path, content, sha, raw = this._cache.get(path)?.raw) {
    const record = { key: this._key(path), namespace: this.namespace, path, content, sha, fetched_at: new Date().toISOString() };
    if (path === 'user/state.json' && typeof raw === 'string') record.raw = raw;
    this._assertActive();
    this._cache.set(path, record);
    this._versions.set(path, (this._versions.get(path) || 0) + 1);
    return record;
  }

  _journal() {
    try {
      if (!globalThis.localStorage) return false;
      if (this._queue.size) globalThis.localStorage.setItem(this._journalKey, JSON.stringify([...this._queue.values()]));
      else globalThis.localStorage.removeItem(this._journalKey);
      return true;
    } catch { return false; }
  }

  _persist(path) {
    this._assertActive();
    const cache = clone(this._cache.get(path));
    const queued = clone(this._queue.get(path));
    const journalSaved = this._journal();
    const work = this._persistTail.then(async () => {
      await this._ensureReady();
      if (!this._db) {
        if (queued && journalSaved) {
          this._emit('error', 'IndexedDB is unavailable. Pending notes are retained in the recovery journal, but offline article caching is unavailable.');
          return;
        }
        throw new Error('Local storage is unavailable. Keep this tab open and export your notes before leaving.');
      }
      const transaction = this._db.transaction(['cache', 'queue'], 'readwrite');
      const done = transactionResult(transaction);
      if (cache && !this._disposed) transaction.objectStore('cache').put(cache);
      if (queued) transaction.objectStore('queue').put(queued);
      else transaction.objectStore('queue').delete(this._key(path));
      await done;
    });
    this._persistTail = work.catch(error => { this._error(new Error(`Local save failed: ${error.message} Keep this tab open and export a backup.`)); });
    return work;
  }

  _schedule() {
    if (this._disposed || this._locking || !this._initialized) return;
    clearTimeout(this._timer);
    // Leaving the app flushes at once; this paced sync covers edits while you stay.
    const now = Date.now();
    const wait = Math.max(COMMIT_PAUSE_MS, this._lastCommitAt + COMMIT_GAP_MS - now, this._retryAt - now);
    this._timer = setTimeout(() => { this._timer = null; void this.flush({ drain: false }); }, wait);
  }

  /** True while GitHub has asked the app to wait before calling it again. */
  get rateLimited() { return Date.now() < this._retryAt; }

  _queueEdit(path, content, options = {}) {
    this._assertOpen();
    if (!writablePath(path)) throw new Error('Refusing to write outside user/state.json, user/queue.json and user/notes/.');
    const old = this._queue.get(path);
    const cached = this._cache.get(path);
    const entry = {
      key: this._key(path), namespace: this.namespace, path,
      migration: options.migration || old?.migration,
      createOnly: path === 'user/queue.json' ? options.createOnly ?? old?.createOnly ?? true : undefined,
      content: clone(content), base: clone(old ? old.base : cached?.content ?? null), revision: ++this._revision,
    };
    this._queue.set(path, entry);
    this._putCache(path, clone(content), cached?.sha || null);
    const durable = this._persist(path);
    this._emit('queued', this.demo ? 'Saving on this device…' : 'Saved locally; queued for private-repository sync.');
    this._schedule();
    return durable;
  }

  async init() {
    this._assertOpen();
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await this._ensureReady();
      this._assertOpen();
      const [library, original, meta, existingQueue] = await Promise.all([
        this._freshOrCached('library.json'), this._freshOrCached('user/state.json', {}),
        this._freshOrCached('bot/meta.json', { updated_at: null }), this._freshOrCached('user/queue.json', null),
      ]);
      this._assertOpen();
      const time = this._now();
      const { state, changed } = migrateState(original, library, time);
      if (changed) {
        const cached = this._cache.get('user/state.json');
        await this._savePreV2Backup(cached?.raw ?? JSON.stringify(original));
        await this._queueEdit('user/state.json', state, { migration: { time, library } });
      }
      const queue = existingQueue || { queue: [], arrivals_since: time };
      if (!existingQueue) await this._queueEdit('user/queue.json', queue, { createOnly: true });
      this._initialized = true;
      if (this._queue.size) this._schedule();
      if (!this._lastError) this._emit(this._queue.size ? 'queued' : this.demo ? 'local' : 'synced', this.demo ? 'Demo · changes stay on this device.' : this._queue.size ? 'Local edits are waiting to sync.' : 'Private library ready.');
      return { library: clone(library), state: clone(state), meta: clone(meta), queue: clone(queue) };
    })();
    try { return await this._initPromise; } catch (error) { this._initPromise = null; throw error; }
  }

  async _savePreV2Backup(raw) {
    await this._ensureReady();
    this._assertOpen();
    if (!this._db) throw new Error('Reading migration needs IndexedDB to retain your original state backup. Enable browser storage and reload; no migration was written.');
    const transaction = this._db.transaction('backups', 'readwrite');
    const done = transactionResult(transaction);
    const backups = transaction.objectStore('backups');
    const key = this._key('pre-v2-state');
    const request = backups.get(key);
    request.onsuccess = () => {
      if (!request.result) backups.put({ key, namespace: this.namespace, raw });
    };
    await done;
  }

  async getPreV2Backup() {
    await this._ensureReady();
    this._assertOpen();
    if (!this._db) return null;
    const transaction = this._db.transaction('backups', 'readonly');
    const record = await requestResult(transaction.objectStore('backups').get(this._key('pre-v2-state')));
    return record?.raw ?? null;
  }

  _mergePending(entry, remote) {
    if (entry.path === 'user/queue.json') return entry.createOnly !== false
      ? remote || entry.content : mergeQueue(entry.content, remote, entry.base);
    if (entry.path !== 'user/state.json') return mergeNotes(entry.content, remote, entry.base);
    return entry.migration
      ? mergeMigratingState(entry.content, remote, entry.base, entry.migration.library, entry.migration.time)
      : mergeState(entry.content, remote, entry.base);
  }

  _contentUrl(path) {
    const { owner, repo, branch } = this.settings;
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  }

  async _request(url, options = {}, kind = 'json') {
    this._assertActive();
    if (globalThis.navigator?.onLine === false) throw new Error('Offline. Your local edits remain queued and will sync when you reconnect.');
    const controller = new AbortController();
    this._controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${this.settings.token}`, ...options.headers },
      });
      this._assertActive();
      if (!response.ok) {
        // Remote error text is untrusted and can echo request credentials.
        let message = `GitHub returned ${response.status}. Your local edits remain queued.`;
        let retryAfter = 0;
        if (response.status === 401) message = 'GitHub rejected the token. Update it in Settings; queued notes are retained.';
        if (response.status === 403 || response.status === 429) {
          retryAfter = rateLimitWait(response, await response.text().catch(() => ''));
          if (retryAfter) {
            this._retryAt = Math.max(this._retryAt, Date.now() + retryAfter);
            message = `GitHub asked the app to slow down. Your notes are saved on this device and will sync in about ${Math.max(1, Math.ceil(retryAfter / 60000))} min.`;
          } else message = 'GitHub access denied. Check the token’s repository access and Contents read/write permission.';
        }
        if (response.status === 404) message = 'GitHub could not find this repository, branch, or file. Check Settings and token access.';
        const error = new Error(message);
        error.status = response.status;
        if (retryAfter) error.retryAfter = retryAfter;
        throw error;
      }
      const result = await response[kind]();
      this._assertActive();
      return result;
    } catch (error) {
      this._assertActive();
      if (error.name === 'AbortError') throw new Error('GitHub did not respond in time. Your local edits remain queued; try syncing again.');
      if (error instanceof TypeError) throw new Error('Could not reach GitHub. Check your network; your local edits remain queued.');
      throw error;
    } finally {
      clearTimeout(timer);
      this._controllers.delete(controller);
    }
  }

  async _checkRepository() {
    this._assertActive();
    if (this.demo) return;
    if (!this.settings.owner || !this.settings.repo || /[\\/\u0000-\u001f]/.test(this.settings.owner + this.settings.repo)) {
      throw new Error('Set a GitHub owner and repository name in Settings.');
    }
    if (!this._repositoryPromise) {
      this._repositoryPromise = this._request(`https://api.github.com/repos/${encodeURIComponent(this.settings.owner)}/${encodeURIComponent(this.settings.repo)}`)
        .then(repository => {
          this._assertActive();
          if (!repository.private) throw new Error('Reading data must be in a private repository. This connection was refused to protect your notes.');
          return repository;
        }).catch(error => { this._repositoryPromise = null; throw error; });
    }
    return this._repositoryPromise;
  }

  async _fetchRemote(path, fallback, kind = 'text') {
    await this._checkRepository();
    let response;
    try {
      response = await this._request(this._contentUrl(path),
        kind === 'blob' ? { headers: { Accept: 'application/vnd.github.raw+json' } } : {},
        kind === 'blob' ? 'blob' : 'json');
    }
    catch (error) {
      if (error.status === 404 && fallback !== undefined) return { content: clone(fallback), sha: null };
      throw error;
    }
    if (kind === 'blob') {
      let blob = response;
      const extension = path.split('.').pop().toLowerCase();
      const type = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }[extension];
      if (type && blob.type !== type) blob = new Blob([blob], { type });
      return { content: blob, sha: null };
    }
    const data = response;
    if (!data || data.type !== 'file') throw new Error(`Expected a file at ${path}.`);
    let text;
    if (data.encoding === 'base64' && typeof data.content === 'string') text = base64Text(data.content);
    else text = await this._request(this._contentUrl(path), { headers: { Accept: 'application/vnd.github.raw+json' } }, 'text');
    let content = text;
    if (/^bot\/editions\/\d{4}-\d{2}-\d{2}\.json$/.test(path)) {
      content = parseEdition(text, this._cache.get('library.json')?.content || [], path.slice('bot/editions/'.length, -5));
    } else if (path.endsWith('.json')) {
      try { content = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON. No remote data was overwritten.`); }
      content = normalizeContent(path, content);
    }
    return { content, sha: data.sha || null, ...(path === 'user/state.json' ? { raw: text } : {}) };
  }

  _notify(path, previous, content) {
    if (this._disposed || !this._initialized || equal(previous, content)) return;
    if (path.startsWith('user/notes/')) this.dispatchEvent(new CustomEvent('notes-updated', { detail: { slug: noteSlug(path), notes: clone(content) } }));
    else if (path === 'user/state.json') this.dispatchEvent(new CustomEvent('state-updated', { detail: { state: clone(content) } }));
    else if (path === 'user/queue.json') this.dispatchEvent(new CustomEvent('queue-updated', { detail: { queue: clone(content) } }));
    else if (path.startsWith('bot/summaries/')) this.dispatchEvent(new CustomEvent('summary-updated', { detail: { slug: path.slice('bot/summaries/'.length, -3), markdown: content } }));
    else if (path.startsWith('articles/')) this.dispatchEvent(new CustomEvent('article-updated', { detail: { slug: path.slice('articles/'.length, -3), markdown: content } }));
  }

  async _refresh(path, fallback, kind = 'text') {
    this._assertActive();
    if (this._reads.has(path)) return this._reads.get(path);
    const work = (async () => {
      const version = this._versions.get(path) || 0;
      const remote = await this._fetchRemote(path, fallback, kind);
      this._assertActive();
      const previous = this._cache.get(path)?.content;
      const pending = this._queue.get(path);
      // A completed save or sync during this GET makes its response potentially stale.
      if (!pending && version !== (this._versions.get(path) || 0)) return clone(previous);
      let content = remote.content;
      if (pending) {
        content = this._mergePending(pending, remote.content);
        if (path === 'user/queue.json' && pending.createOnly !== false && remote.content) this._queue.delete(path);
        else this._queue.set(path, { ...pending, content: clone(content), base: clone(remote.content), revision: ++this._revision });
      }
      this._putCache(path, content, remote.sha, remote.raw);
      this._notify(path, previous, content);
      await this._persist(path);
      this._assertActive();
      return clone(this._cache.get(path).content);
    })();
    this._reads.set(path, work);
    try { return await work; } finally { this._reads.delete(path); }
  }

  async _freshOrCached(path, fallback, kind = 'text') {
    this._assertOpen();
    await this._ensureReady();
    this._assertOpen();
    if (this.demo) {
      if (this._cache.has(path)) return clone(this._cache.get(path).content);
      if (fallback !== undefined) return clone(fallback);
      throw new Error(`The fictional demo does not contain ${path}.`);
    }
    try { return await this._refresh(path, fallback, kind); }
    catch (error) {
      this._assertOpen();
      this._error(error);
      if (this._cache.has(path)) return clone(this._cache.get(path).content);
      // Queue creation is create-only, so offline uncertainty cannot replace a remote queue.
      if (path === 'user/queue.json' && fallback === null) return null;
      throw error;
    }
  }

  async _get(path, fallback, kind = 'text') {
    this._assertOpen();
    await this._ensureReady();
    this._assertOpen();
    const cached = this._cache.get(path);
    if (cached) {
      if (!this.demo) void this._refresh(path, fallback, kind).catch(error => this._error(error));
      return clone(cached.content);
    }
    return this._freshOrCached(path, fallback, kind);
  }

  getArticle(slug) { return this._get(`articles/${safeSlug(slug)}.md`); }
  getNotes(slug) { return this._get(`user/notes/${safeSlug(slug)}.json`, emptyNotes()); }

  /** Check GitHub for a newer copy of one article's notes; a change arrives as 'notes-updated'. */
  async refreshNotes(slug) {
    if (this.demo || this._disposed || !this._initialized || this.rateLimited || globalThis.navigator?.onLine === false) return false;
    try { await this._refresh(`user/notes/${safeSlug(slug)}.json`, emptyNotes()); return true; }
    catch { return false; } // A missed background check is retried on the next one.
  }
  getSummary(slug) { return this._get(`bot/summaries/${safeSlug(slug)}.md`, ''); }
  async getEdition(date = localDate(), { refresh = false } = {}) {
    this._assertOpen();
    await this._ensureReady();
    this._assertOpen();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const path = `bot/editions/${date}.json`;
    if (this.demo && date === localDate() && !this._cache.has(path)) {
      this._putCache(path, demoEdition(), null);
      await this._persist(path);
    }
    if (!this.demo && (refresh || !this._cache.has(path))) {
      try { await this._refresh(path, null); }
      catch (error) { this._error(error); /* Keep the cached edition when offline. */ }
    }
    this._assertOpen();
    const content = this._cache.get(path)?.content;
    return content == null ? null : parseEdition(content, this._cache.get('library.json')?.content || [], date);
  }
  getSearchIndex() {
    this._assertOpen();
    return this._searchIndexPromise ||= (async () => {
      await this._ensureReady();
      this._assertOpen();
      let content = this._cache.get('search-index.json')?.content;
      if (!this.demo) {
        try { content = await this._refresh('search-index.json', {}); }
        catch { /* Optional index: use cached entries or lazy article fetching. */ }
      }
      this._assertOpen();
      if (!dictionary(content)) return {};
      return Object.fromEntries(Object.entries(content).filter(([slug, text]) => safeKey(slug) && typeof text === 'string'));
    })();
  }

  async getAsset(path, from = '') {
    this._assertOpen();
    if (typeof path !== 'string' || !path || /^[a-z][a-z\d+.-]*:|^\/\//i.test(path) || /[\\\u0000-\u001f?#]/.test(path)) {
      throw new Error('Private assets must use a repository-relative path.');
    }
    // Bare assets/ paths are repo-root relative; ./ and ../ resolve from the article.
    const parts = path.startsWith('/') || /^(?:\.\/)?assets\//.test(path) ? [] : from.split('/').slice(0, -1);
    for (const part of path.replace(/^\//, '').split('/')) {
      if (part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Error('Private asset paths cannot leave the repository.');
        parts.pop();
      } else if (part) parts.push(part);
      else throw new Error('Private assets must name a file in the repository.');
    }
    const normalized = parts.join('/');
    if (!normalized) throw new Error('Private assets must name a file in the repository.');
    const blob = await this._get(normalized, undefined, 'blob');
    this._assertOpen();
    const cached = this._cache.get(normalized);
    const existing = this._assetUrls.get(normalized);
    if (existing && existing.version === cached?.fetched_at) return existing.url;
    if (existing) URL.revokeObjectURL(existing.url);
    const url = URL.createObjectURL(blob);
    this._assetUrls.set(normalized, { url, version: cached?.fetched_at });
    return url;
  }

  saveState(state) {
    this._assertOpen();
    const incoming = normalizeState(state);
    const previous = normalizeState(this._cache.get('user/state.json')?.content);
    const result = clone(previous);
    const time = this._now();
    for (const [id, entry] of Object.entries(incoming)) {
      const next = { ...(previous[id] || {}), ...entry, _timestamps: { ...previous[id]?._timestamps } };
      for (const field of STATE_FIELDS) if (entry[field] !== undefined) {
        next[field] = entry[field];
        if (!equal(entry[field], previous[id]?.[field])) next._timestamps[field] = time;
      }
      if (entry.progress !== undefined && entry.progress !== previous[id]?.progress &&
          (entry.progress_changed_at === undefined || entry.progress_changed_at === previous[id]?.progress_changed_at)) {
        next.progress_changed_at = time;
        next._timestamps.progress_changed_at = time;
      }
      result[id] = next;
    }
    return this._queueEdit('user/state.json', result);
  }

  saveQueue(value) {
    this._assertOpen();
    if (!dictionary(value)) throw new Error('Invalid reading queue: expected an object.');
    const path = 'user/queue.json';
    const previous = normalizeQueue(this._cache.get(path)?.content);
    const content = normalizeQueue({ ...previous, ...value, arrivals_since: previous?.arrivals_since || value.arrivals_since });
    const durable = this._queueEdit(path, content, { createOnly: false });
    this._notify(path, previous, content);
    return durable;
  }

  saveNotes(slug, notes) {
    this._assertOpen();
    const path = `user/notes/${safeSlug(slug)}.json`;
    const previous = normalizeNotes(this._cache.get(path)?.content);
    const incoming = normalizeNotes({ ...previous, ...notes });
    const time = this._now();
    incoming.deleted_highlights = { ...previous.deleted_highlights, ...incoming.deleted_highlights };
    const old = new Map(previous.highlights.map(highlight => [highlight.id, highlight]));
    const ids = new Set(incoming.highlights.map(highlight => highlight.id));
    for (const id of old.keys()) if (!ids.has(id)) incoming.deleted_highlights[id] = time;
    for (const highlight of incoming.highlights) {
      const previousHighlight = old.get(highlight.id);
      const { updated_at: ignored, ...fields } = highlight;
      const { updated_at: oldIgnored, ...oldFields } = previousHighlight || {};
      if (!equal(fields, oldFields)) highlight.updated_at = time;
      if (!previousHighlight) highlight.created_at = highlight.created_at === EPOCH ? time : highlight.created_at;
      if (stamp(highlight.updated_at) > stamp(incoming.deleted_highlights[highlight.id])) delete incoming.deleted_highlights[highlight.id];
    }
    incoming.updated_at = time;
    incoming.long_notes_updated_at = incoming.long_notes !== previous.long_notes ? time : previous.long_notes_updated_at;
    return this._queueEdit(path, incoming);
  }

  async _putRemote(path, content, sha) {
    if (!writablePath(path)) throw new Error('Refusing to write outside user/state.json, user/queue.json and user/notes/.');
    await this._checkRepository();
    const body = { message: `Update reading ${path === 'user/state.json' ? 'state' : path === 'user/queue.json' ? 'queue' : 'notes'}`, content: utf8Base64(`${JSON.stringify(content, null, 2)}\n`), branch: this.settings.branch };
    if (sha) body.sha = sha;
    const result = await this._request(this._contentUrl(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return result.content?.sha || null;
  }

  async _push(snapshot) {
    const path = snapshot.path;
    let sent;
    let sha;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fallback = path === 'user/state.json' ? {} : path === 'user/queue.json' ? null : emptyNotes();
      const remote = await this._fetchRemote(path, fallback);
      this._assertActive();
      sent = this._mergePending(snapshot, remote.content);
      if (path === 'user/queue.json' && snapshot.createOnly !== false && remote.content) { sha = remote.sha; break; }
      if (equal(sent, remote.content)) { sha = remote.sha; break; }
      try { sha = await this._putRemote(path, sent, remote.sha); this._lastCommitAt = Date.now(); break; }
      catch (error) {
        if (![409, 422].includes(error.status)) throw error;
        if (attempt === 3) throw new Error('GitHub still reports a conflicting update. Your edits remain queued; try syncing again shortly.');
      }
    }
    this._assertActive();
    const current = this._queue.get(path);
    const previous = this._cache.get(path)?.content;
    let content = sent;
    if (current && current.revision !== snapshot.revision) {
      // Rebase edits made while GET/PUT was in flight onto what actually reached GitHub.
      content = path === 'user/state.json' ? mergeState(current.content, sent, snapshot.content)
        : path === 'user/queue.json' ? mergeQueue(current.content, sent, snapshot.content)
          : mergeNotes(current.content, sent, snapshot.content);
      this._queue.set(path, { ...current, migration: undefined, content: clone(content), base: clone(sent), revision: ++this._revision });
    } else this._queue.delete(path);
    this._putCache(path, clone(content), sha);
    this._notify(path, previous, content);
    await this._persist(path);
  }

  /**
   * Send queued edits to GitHub. A drain (leaving the app, coming online) sends everything, including
   * edits made while it runs. The paced sync sends each file once; later edits wait for the next one.
   */
  async flush({ drain = true } = {}) {
    if (this._disposed) return { pending: 0 };
    // Never flush legacy recovery entries before init has backed up and migrated them.
    if (!this._initialized) {
      if (this._initPromise) await this._initPromise;
      else return { pending: this._queue.size };
    }
    clearTimeout(this._timer);
    this._timer = null;
    if (this._flushPromise) {
      if (drain) this._drain = true;
      return this._flushPromise;
    }
    if (!this.demo && this.rateLimited) { this._schedule(); return { pending: this._queue.size }; }
    this._drain = drain;
    this._flushPromise = (async () => {
      await this._ensureReady();
      if (this._disposed) return { pending: 0 };
      // Finish cache reconciliation before taking a write snapshot. In particular,
      // a failed offline GET must release its repository check before reconnect.
      await Promise.allSettled([...this._reads].filter(([path]) => writablePath(path)).map(([, read]) => read));
      await this._persistTail;
      if (this._disposed || !this._queue.size) return { pending: 0 };
      this._emit('sync', this.demo ? 'Saving demo locally…' : 'Syncing with your private repository…');
      try {
        if (this.demo && !this._db) throw new Error('IndexedDB is unavailable. Demo edits remain in the recovery journal; enable browser storage for normal offline saving.');
        const sent = new Set();
        while (this._queue.size) {
          const next = [...this._queue.values()].find(entry => this._drain || !sent.has(entry.path));
          if (!next) break;
          const snapshot = clone(next);
          sent.add(snapshot.path);
          if (this.demo) {
            this._queue.delete(snapshot.path);
            await this._persist(snapshot.path);
          } else await this._push(snapshot);
        }
        this._lastError = null;
        if (this._queue.size) {
          this._emit('queued', 'Saved locally; the next sync follows shortly.');
          this._schedule();
        } else this._emit(this.demo ? 'local' : 'synced', this.demo ? 'Saved on this device · demo.' : 'All changes synced to your private repository.');
      } catch (error) {
        this._error(error);
        if (error.retryAfter) this._schedule();
      }
      return { pending: this._queue.size };
    })();
    try { return await this._flushPromise; } finally { this._flushPromise = null; this._drain = false; }
  }

  async testConnection() {
    this._assertOpen();
    if (this.demo) return { ok: true, demo: true, message: 'Demo mode is local. Add a token to test a private repository connection.' };
    this._repositoryPromise = null;
    const repository = await this._checkRepository();
    const result = await this._fetchRemote('library.json');
    this._assertOpen();
    if (repository.permissions?.push === false) throw new Error('The token can read this repository but cannot write. Enable Contents read/write for note syncing.');
    return {
      ok: true, demo: false, articles: result.content.length,
      message: `Connected to private ${this.settings.owner}/${this.settings.repo} on ${this.settings.branch}: ${result.content.length} articles. Reading confirmed; the token needs Contents read/write to sync edits.`,
    };
  }

  async _remoteNoteSlugs() {
    await this._checkRepository();
    let files;
    try { files = await this._request(this._contentUrl('user/notes')); }
    catch (error) { if (error.status === 404) return []; throw error; }
    if (!Array.isArray(files)) throw new Error('Expected user/notes to be a directory.');
    if (files.length >= 1000) {
      const { owner, repo, branch } = this.settings;
      const tree = await this._request(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('The repository is too large for a complete GitHub tree listing. This backup includes cached notes only.');
      return tree.tree.filter(entry => entry.type === 'blob' && /^user\/notes\/[^/]+\.json$/.test(entry.path))
        .map(entry => safeSlug(noteSlug(entry.path)));
    }
    return files.filter(file => file.type === 'file' && typeof file.name === 'string' && file.name.endsWith('.json')).map(file => safeSlug(file.name.slice(0, -5)));
  }

  async getNoteSlugs() {
    await this._ensureReady();
    this._assertOpen();
    const slugs = new Set([...this._cache.keys()].filter(path => path.startsWith('user/notes/')).map(noteSlug));
    if (!this.demo) {
      try { for (const slug of await this._remoteNoteSlugs()) slugs.add(slug); }
      catch (error) { this._error(error); }
    }
    this._assertOpen();
    return [...slugs].sort();
  }

  async exportData() {
    this._assertOpen();
    await this._ensureReady();
    this._assertOpen();
    const warnings = [];
    const slugs = new Set();
    for (const path of this._cache.keys()) if (path.startsWith('user/notes/')) slugs.add(noteSlug(path));
    if (!this.demo) {
      try { for (const slug of await this._remoteNoteSlugs()) slugs.add(slug); }
      catch (error) { warnings.push(error.message); }
    }
    for (const slug of slugs) {
      try { await this._freshOrCached(`user/notes/${safeSlug(slug)}.json`, emptyNotes()); }
      catch (error) { warnings.push(`${slug}: ${error.message}`); }
    }
    try { await this._freshOrCached('user/state.json', {}); } catch (error) { warnings.push(error.message); }
    try { await this._freshOrCached('user/queue.json', null); } catch (error) { warnings.push(error.message); }
    this._assertOpen();
    const notes = {};
    for (const [path, record] of this._cache) if (path.startsWith('user/notes/')) notes[noteSlug(path)] = clone(record.content);
    if (warnings.length) this._emit('error', 'Backup contains all cached user data, but some remote notes were unavailable. Keep an additional backup after reconnecting.');
    return {
      format: 'reading-terminal-user-data', version: 1, exported_at: new Date().toISOString(), complete: warnings.length === 0,
      source: { owner: this.demo ? '' : this.settings.owner, repo: this.demo ? '' : this.settings.repo, branch: this.demo ? '' : this.settings.branch, demo: this.demo },
      state: clone(this._cache.get('user/state.json')?.content || {}), queue: clone(this._cache.get('user/queue.json')?.content || null), notes, warnings,
    };
  }

  async importData(data) {
    this._assertOpen();
    if (!dictionary(data) || (data.format && data.format !== 'reading-terminal-user-data') || (data.version && data.version !== 1) ||
        !dictionary(data.state) || !dictionary(data.notes)) throw new Error('Choose a Reading Terminal user-data JSON backup containing state and notes.');
    const state = normalizeState(migrateState(data.state, [], this._now()).state);
    const queue = normalizeQueue(data.queue);
    const incoming = Object.entries(data.notes).map(([slug, notes]) => [safeSlug(slug), normalizeNotes(notes)]);
    await this._ensureReady();
    this._assertOpen();
    // Validate the complete backup before making any changes, then merge through the normal durable queue.
    const mergedState = mergeState(this._cache.get('user/state.json')?.content || {}, state);
    await this.saveState(mergedState);
    if (queue && !await this._freshOrCached('user/queue.json', null)) await this._queueEdit('user/queue.json', queue, { createOnly: true });
    for (const [slug, notes] of incoming) {
      const path = `user/notes/${slug}.json`;
      let current = this._cache.get(path)?.content;
      if (!current) {
        try { current = await this.getNotes(slug); } catch { current = emptyNotes(); }
      }
      const merged = mergeNotes(current, notes);
      await this.saveNotes(slug, merged);
      this._assertOpen();
      this._notify(path, current, this._cache.get(path).content);
    }
    this._assertOpen();
    this.dispatchEvent(new CustomEvent('state-updated', { detail: { state: clone(this._cache.get('user/state.json').content) } }));
    this._emit('queued', this.demo ? 'Backup merged into this device’s demo data.' : 'Backup merged locally and queued for private-repository sync.');
    return { notes: incoming.length, state: clone(this._cache.get('user/state.json').content) };
  }

  _stop() {
    this._disposed = true;
    clearTimeout(this._timer);
    this._timer = null;
    for (const controller of this._controllers) controller.abort();
    this._controllers.clear();
    this.settings.token = '';
    for (const { url } of this._assetUrls.values()) URL.revokeObjectURL(url);
    this._assetUrls.clear();
    this._cache.clear();
    this._queue.clear();
    this._versions.clear();
    this._reads.clear();
    this._initPromise = null;
    this._searchIndexPromise = null;
    this._repositoryPromise = null;
    this._lastError = null;
  }

  lock() {
    if (this._lockPromise) return this._lockPromise;
    this._locking = true;
    this._lockPromise = (async () => {
      let timer;
      try {
        await Promise.race([
          this.flush().catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, 1500); }),
        ]);
      } finally {
        clearTimeout(timer);
        this._stop();
      }
      // Already-scheduled writes own immutable queue snapshots. Drain those
      // before deleting cache records, so neither an old GET nor a local save
      // can restore private content after Lock has completed.
      await this._ready?.catch(() => {});
      await this._persistTail;
      await this._closePromise;
      try {
        const db = this._db ||= await openCacheDatabase();
        const transaction = db.transaction('cache', 'readwrite');
        const done = transactionResult(transaction);
        const cache = transaction.objectStore('cache');
        const cursor = cache.index('namespace').openKeyCursor(this.namespace);
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          cache.delete(cursor.result.primaryKey);
          cursor.result.continue();
        };
        // The queue object store and synchronous recovery journal are excluded.
        await done;
      } catch {
        throw new Error('The library is locked, but its offline cache could not be cleared. Allow browser storage and lock again.');
      } finally {
        this._db?.close();
        this._db = null;
      }
    })().catch(error => {
      this._lockPromise = null;
      throw error;
    });
    return this._lockPromise;
  }

  dispose() {
    if (this._lockPromise || this._closePromise) return;
    this._stop();
    // Keep already-started local saves durable without allowing their network
    // continuations to repopulate memory or start another authenticated request.
    this._closePromise = (async () => {
      await this._ready?.catch(() => {});
      await this._persistTail;
      this._db?.close();
      this._db = null;
    })();
  }
}

/** Validate setup access using the same private-only check as normal reads. */
export async function checkPrivateRepository(settings) {
  const store = new ReadingStore(settings);
  try {
    if (store.demo) throw new Error('Enter a GitHub access token to check the private reading repository.');
    return await store._checkRepository();
  } finally {
    store.dispose();
  }
}
