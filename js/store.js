import { demoLibrary, demoArticles, demoNotes, demoSummaries, demoState, demoMeta } from './demo.js';

const SETTINGS_KEY = 'reading-terminal.settings';
const DATABASE = 'reading-terminal-cache';
const DEFAULT_SETTINGS = Object.freeze({ owner: 'TunaIssaCoding', repo: 'reading-data', branch: 'main', token: '' });
const EPOCH = '1970-01-01T00:00:00.000Z';
const STATE_FIELDS = ['status', 'starred', 'status_changed_at', 'last_opened_at'];
const STATUSES = new Set(['unread', 'read', 'commented']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
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
  if (path === 'user/state.json') return true;
  const match = /^user\/notes\/([^/]+)\.json$/.exec(path);
  if (!match) return false;
  try { safeSlug(match[1]); return true; } catch { return false; }
}

function noteSlug(path) {
  return path.slice('user/notes/'.length, -'.json'.length);
}

function emptyNotes() {
  return { long_notes: '', highlights: [], updated_at: EPOCH, long_notes_updated_at: EPOCH, deleted_highlights: {} };
}

function normalizeNotes(input) {
  if (input == null) return emptyNotes();
  if (!dictionary(input) || (input.long_notes !== undefined && typeof input.long_notes !== 'string') ||
      (input.highlights !== undefined && !Array.isArray(input.highlights))) {
    throw new Error('Invalid notes data: expected long_notes text and a highlights array.');
  }
  const result = {
    long_notes: input.long_notes || '', highlights: [],
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
    else result.highlights.push(clone(winner.value));
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
    const item = { _timestamps: {} };
    for (const field of STATE_FIELDS) {
      if (entry[field] === undefined) continue;
      if (field === 'status' && !STATUSES.has(entry[field])) throw new Error(`Invalid reading status for ${id}.`);
      if (field === 'starred' && typeof entry[field] !== 'boolean') throw new Error(`Invalid starred flag for ${id}.`);
      if (field.endsWith('_at') && typeof entry[field] !== 'string') throw new Error(`Invalid timestamp for ${id}.`);
      item[field] = entry[field];
      item._timestamps[field] = newest(entry._timestamps?.[field] || entry[`${field}_updated_at`] ||
        (field === 'status_changed_at' ? entry.status_updated_at : undefined) || entry.updated_at ||
        (field === 'last_opened_at' ? entry.last_opened_at : entry.status_changed_at));
    }
    if (item.status !== undefined) {
      item.commented_from = item.status === 'commented' && ['unread', 'read'].includes(entry.commented_from) ? entry.commented_from : null;
    }
    state[id] = item;
  }
  return state;
}

function mergeState(local, remote, base = {}) {
  const a = normalizeState(local);
  const b = normalizeState(remote);
  const ancestor = normalizeState(base);
  const result = {};
  for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const item = { _timestamps: {} };
    for (const field of STATE_FIELDS) {
      // Status and its automatic-promotion provenance are one conflict unit.
      const value = entry => field === 'status' && entry?.status !== undefined
        ? { status: entry.status, commented_from: entry.commented_from } : entry?.[field];
      const left = value(a[id]);
      const right = value(b[id]);
      const before = value(ancestor[id]);
      const lt = a[id]?._timestamps?.[field] || EPOCH;
      const rt = b[id]?._timestamps?.[field] || EPOCH;
      let useLeft;
      if (left === undefined) useLeft = false;
      else if (right === undefined || equal(left, right)) useLeft = true;
      else if (equal(left, before)) useLeft = false;
      else if (equal(right, before)) useLeft = true;
      else useLeft = stamp(lt) > stamp(rt) || (stamp(lt) === stamp(rt) && JSON.stringify(left) >= JSON.stringify(right));
      const selected = useLeft ? left : right;
      if (selected !== undefined) {
        if (field === 'status') Object.assign(item, selected);
        else item[field] = clone(selected);
        item._timestamps[field] = equal(left, right) ? newest(lt, rt) : useLeft ? lt : rt;
      }
    }
    result[id] = item;
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
      ...entry, id, slug, title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : slug,
      title_is_generated: Boolean(entry.title_is_generated), author: String(entry.author || ''), handle: String(entry.handle || ''),
      url: String(entry.url || ''), created_at: String(entry.created_at || ''), source_type: String(entry.source_type || ''),
      words: Number.isFinite(entry.words) ? entry.words : 0,
      tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
      summary: String(entry.summary || ''), images: Array.isArray(entry.images) ? entry.images : [],
      status: STATUSES.has(entry.status) ? entry.status : 'unread', starred: Boolean(entry.starred),
      status_changed_at: newest(entry.status_changed_at || entry.created_at),
    };
  });
}

function normalizeContent(path, content) {
  if (path === 'library.json') return normalizeLibrary(content);
  if (path === 'user/state.json') return normalizeState(content);
  if (path.startsWith('user/notes/')) return normalizeNotes(content);
  if (path === 'bot/meta.json') {
    if (!dictionary(content)) throw new Error('bot/meta.json must contain an object.');
    const lengths = {};
    for (const [slug, length] of Object.entries(content.notes_summary_len || {})) {
      if (safeKey(slug) && Number.isFinite(length) && length >= 0) lengths[slug] = length;
    }
    return { ...content, notes_summary_len: lengths };
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
    this.namespace = this.demo ? 'demo:v1' : JSON.stringify([this.settings.owner.toLowerCase(), this.settings.repo.toLowerCase(), this.settings.branch]);
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
    this._disposed = false;
  }

  _emit(status, message) { this.dispatchEvent(new CustomEvent('change', { detail: { status, message } })); }
  _error(error) {
    this._lastError = error;
    this._emit('error', error.message || 'Sync failed. Your queued edits are retained on this device.');
  }
  _key(path) { return `${this.namespace}\n${path}`; }
  _now() { this._clock = Math.max(Date.now(), this._clock + 1); return new Date(this._clock).toISOString(); }
  _ensureReady() { return this._ready ||= this._load(); }

  async _load() {
    try {
      if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable. Enable browser storage for offline reading.');
      this._db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          for (const name of ['cache', 'queue']) {
            if (!request.result.objectStoreNames.contains(name)) {
              request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('namespace', 'namespace');
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open the local reading cache.'));
        request.onblocked = () => reject(new Error('Close another Reading Terminal tab so the local cache can be opened.'));
      });
      this._db.onversionchange = () => { this._db.close(); this._db = null; this._error(new Error('The local cache changed in another tab. Reload to continue saving offline.')); };
      const transaction = this._db.transaction(['cache', 'queue'], 'readonly');
      const [cache, queue] = await Promise.all(['cache', 'queue'].map(name => requestResult(transaction.objectStore(name).index('namespace').getAll(this.namespace))));
      for (const record of cache) if (!this._cache.has(record.path)) this._cache.set(record.path, record);
      for (const entry of queue) {
        if (!writablePath(entry.path)) continue;
        this._revision = Math.max(this._revision, entry.revision || 0);
        if (!this._queue.has(entry.path)) this._queue.set(entry.path, entry);
      }
    } catch (error) {
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
          content: normalizeContent(entry.path, entry.content),
        });
        this._revision = Math.max(this._revision, entry.revision || 0);
      }
    } catch (error) { this._error(new Error(`Could not read the device recovery journal: ${error.message}`)); }
    if (this.demo) {
      const seeds = { 'library.json': demoLibrary, 'user/state.json': demoState, 'bot/meta.json': demoMeta };
      for (const [slug, text] of Object.entries(demoArticles)) seeds[`articles/${slug}.md`] = text;
      for (const [slug, notes] of Object.entries(demoNotes)) seeds[`user/notes/${slug}.json`] = notes;
      for (const [slug, text] of Object.entries(demoSummaries)) seeds[`bot/summaries/${slug}.md`] = text;
      for (const [path, content] of Object.entries(seeds)) if (!this._cache.has(path)) this._putCache(path, clone(content), null);
    }
    for (const entry of this._queue.values()) this._putCache(entry.path, clone(entry.content), this._cache.get(entry.path)?.sha || null);
    if (this._db) {
      const transaction = this._db.transaction(['cache', 'queue'], 'readwrite');
      const done = transactionResult(transaction);
      for (const record of this._cache.values()) transaction.objectStore('cache').put(record);
      for (const entry of this._queue.values()) transaction.objectStore('queue').put(entry);
      await done;
    }
    if (this._queue.size) this._schedule();
  }

  _putCache(path, content, sha) {
    const record = { key: this._key(path), namespace: this.namespace, path, content, sha, fetched_at: new Date().toISOString() };
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
      if (cache) transaction.objectStore('cache').put(cache);
      if (queued) transaction.objectStore('queue').put(queued);
      else transaction.objectStore('queue').delete(this._key(path));
      await done;
    });
    this._persistTail = work.catch(error => { this._error(new Error(`Local save failed: ${error.message} Keep this tab open and export a backup.`)); });
    return work;
  }

  _schedule() {
    if (this._disposed) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; void this.flush(); }, 2000);
  }

  _queueEdit(path, content) {
    if (!writablePath(path)) throw new Error('Refusing to write outside user/state.json and user/notes/.');
    const old = this._queue.get(path);
    const cached = this._cache.get(path);
    const entry = {
      key: this._key(path), namespace: this.namespace, path,
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
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await this._ensureReady();
      const [library, state, meta] = await Promise.all([
        this._freshOrCached('library.json'), this._freshOrCached('user/state.json', {}),
        this._freshOrCached('bot/meta.json', { updated_at: null, notes_summary_len: {} }),
      ]);
      if (!this._lastError) this._emit(this._queue.size ? 'queued' : 'local', this.demo ? 'Demo · changes stay on this device.' : this._queue.size ? 'Local edits are waiting to sync.' : 'Private library ready.');
      return { library: clone(library), state: clone(state), meta: clone(meta) };
    })();
    try { return await this._initPromise; } catch (error) { this._initPromise = null; throw error; }
  }

  _contentUrl(path) {
    const { owner, repo, branch } = this.settings;
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  }

  async _request(url, options = {}) {
    if (globalThis.navigator?.onLine === false) throw new Error('Offline. Your local edits remain queued and will sync when you reconnect.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${this.settings.token}`, ...options.headers },
      });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).message || ''; } catch { /* Status alone is sufficient. */ }
        let message = `GitHub returned ${response.status}${detail ? `: ${detail}` : '.'}`;
        if (response.status === 401) message = 'GitHub rejected the token. Update it in Settings; queued notes are retained.';
        if (response.status === 403 || response.status === 429) message = response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429
          ? 'GitHub rate limit reached. Wait before syncing again; queued notes are retained.'
          : 'GitHub access denied. Check the token’s repository access and Contents read/write permission.';
        if (response.status === 404) message = 'GitHub could not find this repository, branch, or file. Check Settings and token access.';
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return response;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('GitHub did not respond in time. Your local edits remain queued; try syncing again.');
      if (error instanceof TypeError) throw new Error('Could not reach GitHub. Check your network; your local edits remain queued.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async _checkRepository() {
    if (this.demo) return;
    if (!this.settings.owner || !this.settings.repo || /[\\/\u0000-\u001f]/.test(this.settings.owner + this.settings.repo)) {
      throw new Error('Set a GitHub owner and repository name in Settings.');
    }
    if (!this._repositoryPromise) {
      this._repositoryPromise = this._request(`https://api.github.com/repos/${encodeURIComponent(this.settings.owner)}/${encodeURIComponent(this.settings.repo)}`)
        .then(response => response.json()).then(repository => {
          if (!repository.private) throw new Error('Reading data must be in a private repository. This connection was refused to protect your notes.');
          return repository;
        }).catch(error => { this._repositoryPromise = null; throw error; });
    }
    return this._repositoryPromise;
  }

  async _fetchRemote(path, fallback, kind = 'text') {
    await this._checkRepository();
    let response;
    try { response = await this._request(this._contentUrl(path), kind === 'blob' ? { headers: { Accept: 'application/vnd.github.raw+json' } } : {}); }
    catch (error) {
      if (error.status === 404 && fallback !== undefined) return { content: clone(fallback), sha: null };
      throw error;
    }
    if (kind === 'blob') {
      let blob = await response.blob();
      const extension = path.split('.').pop().toLowerCase();
      const type = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }[extension];
      if (type && blob.type !== type) blob = new Blob([blob], { type });
      return { content: blob, sha: null };
    }
    const data = await response.json();
    if (!data || data.type !== 'file') throw new Error(`Expected a file at ${path}.`);
    let text;
    if (data.encoding === 'base64' && typeof data.content === 'string') text = base64Text(data.content);
    else text = await (await this._request(this._contentUrl(path), { headers: { Accept: 'application/vnd.github.raw+json' } })).text();
    let content = text;
    if (path.endsWith('.json')) {
      try { content = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON. No remote data was overwritten.`); }
      content = normalizeContent(path, content);
    }
    return { content, sha: data.sha || null };
  }

  _notify(path, previous, content) {
    if (equal(previous, content)) return;
    if (path.startsWith('user/notes/')) this.dispatchEvent(new CustomEvent('notes-updated', { detail: { slug: noteSlug(path), notes: clone(content) } }));
    else if (path === 'user/state.json') this.dispatchEvent(new CustomEvent('state-updated', { detail: { state: clone(content) } }));
    else if (path.startsWith('bot/summaries/')) this.dispatchEvent(new CustomEvent('summary-updated', { detail: { slug: path.slice('bot/summaries/'.length, -3), markdown: content } }));
    else if (path.startsWith('articles/')) this.dispatchEvent(new CustomEvent('article-updated', { detail: { slug: path.slice('articles/'.length, -3), markdown: content } }));
  }

  async _refresh(path, fallback, kind = 'text') {
    if (this._reads.has(path)) return this._reads.get(path);
    const work = (async () => {
      const version = this._versions.get(path) || 0;
      const remote = await this._fetchRemote(path, fallback, kind);
      const previous = this._cache.get(path)?.content;
      const pending = this._queue.get(path);
      // A completed save or sync during this GET makes its response potentially stale.
      if (!pending && version !== (this._versions.get(path) || 0)) return clone(previous);
      let content = remote.content;
      if (pending) {
        content = path === 'user/state.json' ? mergeState(pending.content, remote.content, pending.base) : mergeNotes(pending.content, remote.content, pending.base);
        this._queue.set(path, { ...pending, content: clone(content), base: clone(remote.content), revision: ++this._revision });
      }
      this._putCache(path, content, remote.sha);
      this._notify(path, previous, content);
      await this._persist(path);
      return clone(this._cache.get(path).content);
    })();
    this._reads.set(path, work);
    try { return await work; } finally { this._reads.delete(path); }
  }

  async _freshOrCached(path, fallback, kind = 'text') {
    await this._ensureReady();
    if (this.demo) {
      if (this._cache.has(path)) return clone(this._cache.get(path).content);
      if (fallback !== undefined) return clone(fallback);
      throw new Error(`The fictional demo does not contain ${path}.`);
    }
    try { return await this._refresh(path, fallback, kind); }
    catch (error) {
      this._error(error);
      if (this._cache.has(path)) return clone(this._cache.get(path).content);
      throw error;
    }
  }

  async _get(path, fallback, kind = 'text') {
    await this._ensureReady();
    const cached = this._cache.get(path);
    if (cached) {
      if (!this.demo) void this._refresh(path, fallback, kind).catch(error => this._error(error));
      return clone(cached.content);
    }
    return this._freshOrCached(path, fallback, kind);
  }

  getArticle(slug) { return this._get(`articles/${safeSlug(slug)}.md`); }
  getNotes(slug) { return this._get(`user/notes/${safeSlug(slug)}.json`, emptyNotes()); }
  getSummary(slug) { return this._get(`bot/summaries/${safeSlug(slug)}.md`, ''); }
  getSearchIndex() {
    return this._searchIndexPromise ||= (async () => {
      await this._ensureReady();
      let content = this._cache.get('search-index.json')?.content;
      if (!this.demo) {
        try { content = await this._refresh('search-index.json', {}); }
        catch { /* Optional index: use cached entries or lazy article fetching. */ }
      }
      if (!dictionary(content)) return {};
      return Object.fromEntries(Object.entries(content).filter(([slug, text]) => safeKey(slug) && typeof text === 'string'));
    })();
  }

  async getAsset(path, from = '') {
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
    const cached = this._cache.get(normalized);
    const existing = this._assetUrls.get(normalized);
    if (existing && existing.version === cached?.fetched_at) return existing.url;
    if (existing) URL.revokeObjectURL(existing.url);
    const url = URL.createObjectURL(blob);
    this._assetUrls.set(normalized, { url, version: cached?.fetched_at });
    return url;
  }

  saveState(state) {
    const incoming = normalizeState(state);
    const previous = normalizeState(this._cache.get('user/state.json')?.content);
    const result = clone(previous);
    const time = this._now();
    for (const [id, entry] of Object.entries(incoming)) {
      const next = { ...(previous[id] || {}), _timestamps: { ...previous[id]?._timestamps } };
      for (const field of STATE_FIELDS) if (entry[field] !== undefined) {
        next[field] = entry[field];
        if (!equal(entry[field], previous[id]?.[field]) ||
            (field === 'status' && entry.commented_from !== previous[id]?.commented_from)) next._timestamps[field] = time;
      }
      if (entry.status !== undefined) next.commented_from = entry.commented_from;
      if (entry.status !== undefined && entry.status !== previous[id]?.status && entry.status_changed_at === previous[id]?.status_changed_at) {
        next.status_changed_at = time;
        next._timestamps.status_changed_at = time;
      }
      result[id] = next;
    }
    return this._queueEdit('user/state.json', result);
  }

  saveNotes(slug, notes) {
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
    if (!writablePath(path)) throw new Error('Refusing to write outside user/state.json and user/notes/.');
    await this._checkRepository();
    const body = { message: `Update reading ${path === 'user/state.json' ? 'state' : 'notes'}`, content: utf8Base64(`${JSON.stringify(content, null, 2)}\n`), branch: this.settings.branch };
    if (sha) body.sha = sha;
    const response = await this._request(this._contentUrl(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    return result.content?.sha || null;
  }

  async _push(snapshot) {
    const path = snapshot.path;
    let sent;
    let sha;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fallback = path === 'user/state.json' ? {} : emptyNotes();
      const remote = await this._fetchRemote(path, fallback);
      sent = path === 'user/state.json' ? mergeState(snapshot.content, remote.content, snapshot.base) : mergeNotes(snapshot.content, remote.content, snapshot.base);
      try { sha = await this._putRemote(path, sent, remote.sha); break; }
      catch (error) {
        if (![409, 422].includes(error.status)) throw error;
        if (attempt === 3) throw new Error('GitHub still reports a conflicting update. Your edits remain queued; try syncing again shortly.');
      }
    }
    const current = this._queue.get(path);
    const previous = this._cache.get(path)?.content;
    let content = sent;
    if (current && current.revision !== snapshot.revision) {
      // Rebase edits made while GET/PUT was in flight onto what actually reached GitHub.
      content = path === 'user/state.json' ? mergeState(current.content, sent, snapshot.content) : mergeNotes(current.content, sent, snapshot.content);
      this._queue.set(path, { ...current, content: clone(content), base: clone(sent), revision: ++this._revision });
    } else this._queue.delete(path);
    this._putCache(path, clone(content), sha);
    this._notify(path, previous, content);
    await this._persist(path);
  }

  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._flushPromise) return this._flushPromise;
    this._flushPromise = (async () => {
      await this._ensureReady();
      // Finish cache reconciliation before taking a write snapshot. In particular,
      // a failed offline GET must release its repository check before reconnect.
      await Promise.allSettled([...this._reads].filter(([path]) => writablePath(path)).map(([, read]) => read));
      await this._persistTail;
      if (!this._queue.size) return { pending: 0 };
      this._emit('sync', this.demo ? 'Saving demo locally…' : 'Syncing with your private repository…');
      try {
        if (this.demo && !this._db) throw new Error('IndexedDB is unavailable. Demo edits remain in the recovery journal; enable browser storage for normal offline saving.');
        while (this._queue.size) {
          const snapshot = clone(this._queue.values().next().value);
          if (this.demo) {
            this._queue.delete(snapshot.path);
            await this._persist(snapshot.path);
          } else await this._push(snapshot);
        }
        this._lastError = null;
        this._emit('local', this.demo ? 'Saved on this device · demo.' : 'All changes synced to your private repository.');
      } catch (error) { this._error(error); }
      return { pending: this._queue.size };
    })();
    try { return await this._flushPromise; } finally { this._flushPromise = null; }
  }

  async testConnection() {
    if (this.demo) return { ok: true, demo: true, message: 'Demo mode is local. Add a token to test a private repository connection.' };
    this._repositoryPromise = null;
    const repository = await this._checkRepository();
    const result = await this._fetchRemote('library.json');
    if (repository.permissions?.push === false) throw new Error('The token can read this repository but cannot write. Enable Contents read/write for note syncing.');
    return {
      ok: true, demo: false, articles: result.content.length,
      message: `Connected to private ${this.settings.owner}/${this.settings.repo} on ${this.settings.branch}: ${result.content.length} articles. Reading confirmed; the token needs Contents read/write to sync edits.`,
    };
  }

  async _remoteNoteSlugs() {
    await this._checkRepository();
    let response;
    try { response = await this._request(this._contentUrl('user/notes')); }
    catch (error) { if (error.status === 404) return []; throw error; }
    const files = await response.json();
    if (!Array.isArray(files)) throw new Error('Expected user/notes to be a directory.');
    if (files.length >= 1000) {
      const { owner, repo, branch } = this.settings;
      const response = await this._request(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const tree = await response.json();
      if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('The repository is too large for a complete GitHub tree listing. This backup includes cached notes only.');
      return tree.tree.filter(entry => entry.type === 'blob' && /^user\/notes\/[^/]+\.json$/.test(entry.path))
        .map(entry => safeSlug(noteSlug(entry.path)));
    }
    return files.filter(file => file.type === 'file' && typeof file.name === 'string' && file.name.endsWith('.json')).map(file => safeSlug(file.name.slice(0, -5)));
  }

  async exportData() {
    await this._ensureReady();
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
    const notes = {};
    for (const [path, record] of this._cache) if (path.startsWith('user/notes/')) notes[noteSlug(path)] = clone(record.content);
    if (warnings.length) this._emit('error', 'Backup contains all cached user data, but some remote notes were unavailable. Keep an additional backup after reconnecting.');
    return {
      format: 'reading-terminal-user-data', version: 1, exported_at: new Date().toISOString(), complete: warnings.length === 0,
      source: { owner: this.demo ? '' : this.settings.owner, repo: this.demo ? '' : this.settings.repo, branch: this.demo ? '' : this.settings.branch, demo: this.demo },
      state: clone(this._cache.get('user/state.json')?.content || {}), notes, warnings,
    };
  }

  async importData(data) {
    if (!dictionary(data) || (data.format && data.format !== 'reading-terminal-user-data') || (data.version && data.version !== 1) ||
        !dictionary(data.state) || !dictionary(data.notes)) throw new Error('Choose a Reading Terminal user-data JSON backup containing state and notes.');
    const state = normalizeState(data.state);
    const incoming = Object.entries(data.notes).map(([slug, notes]) => [safeSlug(slug), normalizeNotes(notes)]);
    await this._ensureReady();
    // Validate the complete backup before making any changes, then merge through the normal durable queue.
    const mergedState = mergeState(this._cache.get('user/state.json')?.content || {}, state);
    await this.saveState(mergedState);
    for (const [slug, notes] of incoming) {
      const path = `user/notes/${slug}.json`;
      let current = this._cache.get(path)?.content;
      if (!current) {
        try { current = await this.getNotes(slug); } catch { current = emptyNotes(); }
      }
      const merged = mergeNotes(current, notes);
      await this.saveNotes(slug, merged);
      this._notify(path, current, this._cache.get(path).content);
    }
    this.dispatchEvent(new CustomEvent('state-updated', { detail: { state: clone(this._cache.get('user/state.json').content) } }));
    this._emit('queued', this.demo ? 'Backup merged into this device’s demo data.' : 'Backup merged locally and queued for private-repository sync.');
    return { notes: incoming.length, state: clone(this._cache.get('user/state.json').content) };
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._timer);
    for (const { url } of this._assetUrls.values()) URL.revokeObjectURL(url);
    this._assetUrls.clear();
    // Do not close the database while an already-started local save is committing.
    void this._persistTail.finally(() => { this._db?.close(); this._db = null; });
  }
}
