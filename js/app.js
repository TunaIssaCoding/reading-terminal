import { ReadingStore, getSettings, saveSettings } from './store.js';
import { Library } from './library.js';
import { NotesPane } from './notes.js';
import { Reader } from './reader.js';
import { VaultAccess } from './auth.js';

const $ = selector => document.querySelector(selector);
const now = () => new Date().toISOString();
const emptyNotes = () => ({ long_notes: '', highlights: [], updated_at: '' });
const text = (tag, value, className) => {
  const el = document.createElement(tag); el.textContent = value;
  if (className) el.className = className;
  return el;
};
let store, libraryItems = [], state = {}, meta = {}, active = null, notes = emptyNotes(), bot = '';
let openVersion = 0, connectionVersion = 0, query = '', tag = '', starredOnly = false, searchVersion = 0;
let articleReady = false;
let bodies = new Map(), searchIndex = new Map(), notesCache = new Map(), summaries = new Map();
let syncedAt = null;
function updateSyncTime() {
  if (!syncedAt || $('#sync-status').dataset.status !== 'synced') return;
  const minutes = Math.max(0, Math.floor((Date.now() - syncedAt.getTime()) / 60000));
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`;
  $('#sync-status').textContent = `Synced ${age}`;
  $('#sync-status').title = syncedAt.toLocaleString();
}
setInterval(updateSyncTime, 15000);
const notices = new Set();
function placeToasts() { (document.querySelector('dialog[open]') || document.body).append($('#toast')); }
function notify(message, { undo, commit } = {}) {
  const root = $('#toast'), entry = text('div', '', 'toast-message');
  entry.append(text('span', message));
  let timer;
  const dismiss = () => {
    clearTimeout(timer); notices.delete(dismiss); entry.remove(); root.hidden = !root.childElementCount;
  };
  if (undo) {
    const button = text('button', 'Undo'); button.type = 'button';
    button.addEventListener('click', () => { dismiss(); persist(Promise.resolve().then(undo)); });
    entry.append(button);
  }
  notices.add(dismiss); root.append(entry); root.hidden = false; placeToasts();
  timer = setTimeout(() => { dismiss(); if (commit) persist(Promise.resolve().then(commit)); }, 6000);
  return dismiss;
}
function handleError(error) { notify(error.message || String(error)); }
const persist = promise => Promise.resolve(promise).catch(handleError);
const library = new Library({ root: $('#library'), onOpen: openArticle, onStar: toggleStar, onStatus: setStatus, onTag: filterTag });
const pane = new NotesPane({ root: $('#notes-content'), onChange: value => {
  if (!active) return;
  notes.long_notes = value; notes.long_notes_updated_at = now(); saveNotes();
}, onOpen: openArticle, notify });
const reader = new Reader({ root: $('#article-body'), warnings: $('#anchor-warnings'), onChange: highlights => {
  if (!active) return;
  notes.highlights = highlights; pane.updateMargins(highlights.filter(h => !h.deleted)); saveNotes();
}, onQuote: quote => { showDrawer('notes'); pane.appendQuote(quote); }, onOpen: openArticle,
getAsset: path => store.getAsset(path, active ? `articles/${active.slug}.md` : ''), notify, onDelete: deleteHighlight });

function items() {
  return libraryItems.map(item => ({ ...item, status: item.status || 'unread', ...state[item.id], notes: notesCache.get(item.slug) }));
}
function renderLibrary() {
  library.render(items(), { activeId: active?.id, query, tag, starredOnly, bodies: new Map([...searchIndex, ...bodies]), meta });
  $('#library-total').textContent = `${libraryItems.length} items`;
  $('#tag-filter').hidden = !tag; $('#tag-filter').textContent = `${tag} ×`;
  $('#star-filter').setAttribute('aria-pressed', String(starredOnly));
}
function currentItem(id = active?.id) { return items().find(item => String(item.id) === String(id)); }
function saveState() { persist(store.saveState(state)); renderLibrary(); updateReaderButtons(); }
function setStatus(id, status, commentedFrom = null) {
  const item = currentItem(id); if (!item) return;
  const timestamp = now();
  state[item.id] = { ...state[item.id], status, commented_from: commentedFrom, status_changed_at: timestamp, status_updated_at: timestamp };
  saveState();
}
const autoReadUndone = new Set();
function automaticStatus(id, status, commentedFrom = null) {
  const before = currentItem(id), currentStore = store;
  if (!before || before.status === status) return;
  setStatus(id, status, commentedFrom);
  const changedAt = state[id].status_updated_at;
  return notify(`Marked ${status} automatically.`, { undo: () => {
    if (store !== currentStore || state[id]?.status_updated_at !== changedAt) return;
    if (status === 'read') autoReadUndone.add(String(id));
    setStatus(id, before.status, before.commented_from || null);
  } });
}
function toggleRead() {
  const item = currentItem(); if (!item) return;
  if (item.status === 'commented') { notify('Commented takes priority. Use the item menu to set a different status.'); return; }
  setStatus(item.id, item.status === 'read' ? 'unread' : 'read');
}
function toggleStar(id = active?.id) {
  const item = currentItem(id); if (!item) return;
  state[item.id] = { ...state[item.id], starred: !item.starred, starred_updated_at: now() };
  saveState();
}
function updateReaderButtons() {
  const item = currentItem();
  $('#read-toggle').disabled = !item;
  $('#reader-star').disabled = !item;
  if (!item) return;
  $('#read-toggle').textContent = item.status === 'commented' ? 'Commented' : item.status === 'read' ? 'Mark unread · r' : 'Mark read · r';
  $('#reader-star').textContent = item.starred ? '★' : '☆';
  $('#reader-star').setAttribute('aria-pressed', String(Boolean(item.starred)));
  $('#reader-star').setAttribute('aria-label', item.starred ? 'Unstar current article' : 'Star current article');
}
function saveNotes() {
  notes.updated_at = now(); notesCache.set(active.slug, structuredClone(notes));
  persist(store.saveNotes(active.slug, notes));
  const item = currentItem();
  const hasNotes = notes.long_notes.trim() || notes.highlights.some(h => !h.deleted && h.note?.trim());
  if (hasNotes && item.status !== 'commented') automaticStatus(item.id, 'commented', item.status);
  else if (!hasNotes && item.status === 'commented' && item.commented_from) automaticStatus(item.id, item.commented_from);
  else renderLibrary();
}
function deleteHighlight(highlight) {
  if (!active) return;
  const slug = active.slug, id = active.id, currentStore = store, before = currentItem(id);
  notes.highlights = notes.highlights.filter(item => item.id !== highlight.id);
  reader.close(); reader.updateHighlights(notes.highlights); pane.updateMargins(notes.highlights);
  saveNotes();
  const deletionStatusTime = state[id]?.status_updated_at;
  notify('Highlight deleted.', { undo: async () => {
    if (store !== currentStore) return;
    const restored = structuredClone(notesCache.get(slug) || await currentStore.getNotes(slug));
    restored.highlights = restored.highlights.filter(item => item.id !== highlight.id);
    restored.highlights.push({ ...highlight, deleted: false, updated_at: now() });
    if (restored.deleted_highlights) delete restored.deleted_highlights[highlight.id];
    restored.updated_at = now(); notesCache.set(slug, restored);
    await currentStore.saveNotes(slug, restored);
    if (store !== currentStore) return;
    if (state[id]?.status_updated_at === deletionStatusTime && currentItem(id)?.status !== before.status) {
      setStatus(id, before.status, before.commented_from || null);
    }
    if (active?.slug === slug) {
      notes = restored; reader.updateHighlights(notes.highlights); pane.updateMargins(reader.getHighlights());
    }
    renderLibrary();
  } });
}
function filterTag(value) { tag = tag === value ? '' : value; renderLibrary(); showDrawer('library'); }
function externalLink(label, href) {
  try {
    const url = new URL(href);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const link = text('a', label); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  } catch { return null; }
}
function renderHeader(item) {
  const root = $('#article-header'); root.replaceChildren();
  root.append(text('p', `${item.source_type || 'ESSAY'} / ${Math.max(1, Math.ceil((item.words || 600) / 220))} MIN READ`.toUpperCase(), 'article-kicker'));
  root.append(text('h1', item.title, item.title_is_generated ? 'title-generated' : ''));
  const byline = text('div', '', 'article-byline');
  byline.append(text('span', [item.author, item.handle].filter(Boolean).join(' ')));
  if (item.created_at) {
    const date = new Date(item.created_at);
    if (!Number.isNaN(date.getTime())) { const dateEl = text('time', date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })); dateEl.dateTime = item.created_at; byline.append(dateEl); }
  }
  const source = externalLink('Source ↗', item.url); if (source) byline.append(source);
  const pdf = externalLink('PDF ↗', item.pdf_url);
  if (pdf) byline.append(pdf);
  else if (item.pdf_path) {
    const link = text('a', 'Loading PDF…');
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    byline.append(link);
    store.getAsset(item.pdf_path).then(url => {
      if (link.isConnected) { link.href = url; link.textContent = 'PDF ↗'; }
    }).catch(() => {
      if (link.isConnected) { link.textContent = 'PDF unavailable'; link.title = 'The PDF is missing or unavailable offline.'; }
    });
  }
  root.append(byline);
  const tags = text('div', '', 'article-tags');
  for (const value of item.tags || []) {
    const button = text('button', value, 'tag-chip'); button.addEventListener('click', () => filterTag(value)); tags.append(button);
  }
  root.append(tags);
  if (item.summary) {
    const summary = text('section', '', 'article-summary bot-content');
    summary.append(text('div', `Summary · from intake${item.summary_by ? ` · ${item.summary_by}` : ''}`, 'bot-label'), text('p', item.summary));
    root.append(summary);
  }
}
function renderImages(item) {
  $('#article-header .article-images')?.remove();
  if ($('#article-body img') || !item.images?.length) return;
  const strip = text('div', '', 'article-images');
  strip.setAttribute('aria-label', 'Article images');
  for (const path of item.images) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const figure = text('figure', '');
    const image = document.createElement('img');
    image.alt = `Image ${strip.childElementCount + 1} for ${item.title}`;
    image.loading = 'lazy'; image.decoding = 'async';
    figure.append(image); strip.append(figure);
    const external = externalLink('', path);
    if (external) image.src = external.href;
    else store.getAsset(path).then(url => { if (image.isConnected) image.src = url; })
      .catch(() => { if (image.isConnected) figure.replaceChildren(text('figcaption', 'Image unavailable offline or missing.')); });
  }
  $('#article-header').append(strip);
}
function articleSlug() {
  const match = location.hash.match(/^#(?:demo&)?article=(.*)$/);
  return match ? decodeURIComponent(match[1]) : '';
}
async function openArticle(id, navigation = 'push') {
  const item = currentItem(id) || items().find(item => item.slug === id);
  if (!item) { notify('That article is not in this library.'); return; }
  if (active?.id === item.id && articleReady) return;
  const version = ++openVersion;
  active = item; articleReady = false; notes = emptyNotes(); bot = '';
  renderHeader(item); renderLibrary(); updateReaderButtons();
  reader.setArticle('', []); $('#article-body').append(text('p', 'Opening article…', 'loading-message'));
  pane.setArticle(null); closeDrawers(); $('#reader-pane').scrollTop = 0;
  $('#reader-position').textContent = `${String(libraryItems.indexOf(libraryItems.find(i => i.id === item.id)) + 1).padStart(2, '0')} / ${String(libraryItems.length).padStart(2, '0')}   ·   THE READING ROOM`;
  const hash = `#${store.demo ? 'demo&' : ''}article=${encodeURIComponent(item.slug)}`;
  if (navigation === 'replace') history.replaceState(null, '', hash);
  else if (navigation === 'push' && location.hash !== hash) history.pushState(null, '', hash);
  // Opens are not edits: include this timestamp only with the next real state change.
  if (navigation !== 'replace') state[item.id] = { ...state[item.id], last_opened_at: now() };
  try {
    const [markdown, savedNotes, summary] = await Promise.all([store.getArticle(item.slug), store.getNotes(item.slug), store.getSummary(item.slug)]);
    if (version !== openVersion) return;
    const content = bodies.get(item.slug) ?? markdown;
    bodies.set(item.slug, content);
    notes = notesCache.get(item.slug) || savedNotes || emptyNotes();
    bot = summaries.get(item.slug) ?? summary;
    notes.long_notes ||= ''; notes.highlights ||= [];
    notesCache.set(item.slug, structuredClone(notes));
    reader.setArticle(content, notes.highlights);
    renderImages(item);
    pane.setArticle(item, { ...notes, highlights: reader.getHighlights() }, bot);
    articleReady = true;
    renderLibrary(); $('#reading-progress').textContent = '0%';
  } catch (error) {
    if (version !== openVersion) return;
    $('#article-body').replaceChildren(text('p', error.message, 'loading-message'));
    const retry = text('button', 'Retry opening article'); retry.addEventListener('click', () => openArticle(item.id)); $('#article-body').append(retry);
    handleError(error);
  }
}

async function connect(settings = getSettings()) {
  const version = ++connectionVersion; ++openVersion; ++searchVersion;
  store?.dispose();
  store = new ReadingStore(settings); const currentStore = store;
  autoReadUndone.clear(); syncedAt = null;
  libraryItems = []; state = {}; active = null; bodies = new Map(); searchIndex = new Map(); notesCache = new Map(); summaries = new Map();
  $('#mode-badge').textContent = settings.token ? 'PRIVATE' : 'DEMO';
  store.addEventListener('change', event => {
    if (store !== currentStore) return;
    const { status, message } = event.detail;
    $('#sync-status').dataset.status = status;
    if (status === 'synced') { syncedAt = new Date(); updateSyncTime(); }
    else { $('#sync-status').textContent = message; $('#sync-status').title = message; }
  });
  store.addEventListener('state-updated', event => {
    if (store !== currentStore) return;
    state = event.detail.state; renderLibrary(); updateReaderButtons();
  });
  store.addEventListener('notes-updated', event => {
    if (store !== currentStore) return;
    const { slug, notes: merged } = event.detail; notesCache.set(slug, merged);
    if (slug === active?.slug && articleReady) {
      notes = merged; reader.updateHighlights(merged.highlights || []);
      pane.setArticle(active, { ...merged, highlights: reader.getHighlights() }, bot);
    }
    renderLibrary();
  });
  store.addEventListener('summary-updated', event => {
    if (store !== currentStore) return;
    summaries.set(event.detail.slug, event.detail.markdown);
    if (event.detail.slug === active?.slug && articleReady) {
      bot = event.detail.markdown; pane.renderBot(bot);
    }
  });
  store.addEventListener('article-updated', event => {
    if (store !== currentStore) return;
    bodies.set(event.detail.slug, event.detail.markdown);
    if (event.detail.slug === active?.slug && articleReady) {
      reader.setArticle(event.detail.markdown, notes.highlights);
      renderImages(active);
      pane.updateMargins(reader.getHighlights());
    }
    if (query) renderLibrary();
  });
  try {
    const initial = await store.init();
    if (version !== connectionVersion) return;
    libraryItems = initial.library; state = initial.state || {}; meta = initial.meta || {};
    renderLibrary();
    const slug = articleSlug();
    const first = libraryItems.find(item => item.slug === slug) || currentItem(library.visibleIds()[0]) || libraryItems[0];
    if (first) await openArticle(first.id, 'replace');
    else {
      $('#article-header').replaceChildren(text('h1', 'A quiet place to read.'));
      reader.setArticle('Your library is empty. Add items to `library.json` in the private data repository.'); pane.setArticle(null); updateReaderButtons();
    }
    const commented = items().filter(item => item.status === 'commented');
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, commented.length) }, async () => {
      while (index < commented.length && store === currentStore) {
        const item = commented[index++];
        try { const data = await currentStore.getNotes(item.slug); if (store === currentStore) notesCache.set(item.slug, data); } catch { /* Sync status reports unavailable remote data. */ }
      }
    }));
    if (store === currentStore) renderLibrary();
  } catch (error) {
    if (version !== connectionVersion) return;
    $('#article-header').replaceChildren(text('h1', 'The library is not available yet.'));
    reader.setArticle('Check your connection settings, or clear the token to use the demo library. Your locally saved notes remain on this device.');
    pane.setArticle(null); updateReaderButtons(); handleError(error);
  }
}

async function disconnect() {
  ++connectionVersion; ++openVersion; ++searchVersion; clearTimeout(searchTimer);
  const previous = store; store = null;
  active = null; articleReady = false; libraryItems = []; state = {}; meta = {}; notes = emptyNotes(); bot = '';
  bodies.clear(); searchIndex.clear(); notesCache.clear(); summaries.clear();
  query = ''; tag = ''; starredOnly = false; $('#search').value = ''; $('#search-status').textContent = '';
  reader.close(); reader.setArticle('', []); pane.setArticle(null); $('#article-header').replaceChildren();
  renderLibrary(); updateReaderButtons(); closeDrawers();
  $('#reader-position').textContent = 'THE READING ROOM'; $('#sync-status').textContent = '';
  closeMore(); for (const dismiss of [...notices]) dismiss();
  if (previous) await previous.lock();
}

const access = new VaultAccess({ connect, disconnect, notify });

async function searchBodies(version) {
  const currentStore = store;
  if (!currentStore) return;
  const indexed = await currentStore.getSearchIndex();
  if (version !== searchVersion || store !== currentStore || !query.trim()) return;
  searchIndex = new Map(Object.entries(indexed));
  renderLibrary();
  const pending = libraryItems.filter(item => !bodies.has(item.slug) && !searchIndex.has(item.slug)); let index = 0, failed = 0;
  $('#search-status').textContent = pending.length ? 'Searching article bodies…' : '';
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (index < pending.length && version === searchVersion && query && store === currentStore) {
      const item = pending[index++];
      try { const body = await currentStore.getArticle(item.slug); if (store === currentStore) bodies.set(item.slug, body); }
      catch { failed++; }
      if (version === searchVersion) renderLibrary();
    }
  }));
  if (version === searchVersion) $('#search-status').textContent = failed ? `${failed} bodies unavailable; searching cached text and metadata.` : '';
}
let searchTimer;
$('#search').addEventListener('input', e => {
  query = e.target.value; renderLibrary(); const version = ++searchVersion;
  clearTimeout(searchTimer);
  if (query.trim()) searchTimer = setTimeout(() => {
    void searchBodies(version).catch(error => { if (version === searchVersion) handleError(error); });
  }, 300);
  else $('#search-status').textContent = '';
});
$('#star-filter').addEventListener('click', () => { starredOnly = !starredOnly; renderLibrary(); });
$('#tag-filter').addEventListener('click', () => { tag = ''; renderLibrary(); });
$('#read-toggle').addEventListener('click', toggleRead);
$('#reader-star').addEventListener('click', () => toggleStar());
$('#reader-pane').addEventListener('scroll', () => {
  if (!articleReady) return;
  const paneEl = $('#reader-pane'), bodyEl = $('#article-body');
  const bodyStart = bodyEl.getBoundingClientRect().top - paneEl.getBoundingClientRect().top + paneEl.scrollTop;
  const progress = Math.max(0, Math.min(1, (paneEl.scrollTop + paneEl.clientHeight - bodyStart) / Math.max(1, bodyEl.offsetHeight)));
  $('#reading-progress').textContent = `${Math.round(progress * 100)}%`;
  if (paneEl.scrollTop > 0 && progress >= .9 && currentItem()?.status === 'unread' && !autoReadUndone.has(String(active.id))) automaticStatus(active.id, 'read');
}, { passive: true });

const drawerMedia = matchMedia('(max-width: 860px)');
const mobile = () => drawerMedia.matches;
function closeMore(restoreFocus = false) {
  $('#more-menu').hidden = true; $('#view-menu').hidden = true;
  $('#more-toggle').setAttribute('aria-expanded', 'false');
  $('#view-toggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('#more-toggle').focus();
}
$('#more-toggle').addEventListener('click', () => {
  const opening = $('#more-menu').hidden;
  closeMore();
  if (opening) {
    reader.closeActions(); $('#more-menu').hidden = false;
    $('#more-toggle').setAttribute('aria-expanded', 'true'); $('#view-toggle').focus();
  }
});
$('#view-toggle').addEventListener('click', () => {
  $('#view-menu').hidden = !$('#view-menu').hidden;
  $('#view-toggle').setAttribute('aria-expanded', String(!$('#view-menu').hidden));
});
document.addEventListener('pointerdown', event => {
  const target = event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
  if (!target?.closest('.topbar-more')) closeMore();
  document.querySelectorAll('.item-status-menu[open]').forEach(menu => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});
function arrangeTopbar() {
  const destination = mobile() ? $('#mobile-extras') : $('.topbar');
  for (const id of ['mode-badge', 'sync-status', 'lock-button']) {
    if (mobile()) destination.append($('#' + id));
    else destination.insertBefore($('#' + id), id === 'mode-badge' ? $('.topbar-spacer') : $('.topbar-more'));
  }
}
function showDrawer(which) {
  if (!mobile()) return;
  document.body.classList.toggle('library-open', which === 'library');
  document.body.classList.toggle('notes-open', which === 'notes');
  $('#drawer-backdrop').hidden = false;
  $('#library-toggle').setAttribute('aria-expanded', String(which === 'library'));
  $('#notes-toggle').setAttribute('aria-expanded', String(which === 'notes'));
  $('#sidebar').inert = which !== 'library';
  $('#notes-pane').inert = which !== 'notes';
  $('#reader-pane').inert = true;
  if (which === 'library') $('#search').focus();
  else pane.focus();
}
function closeDrawers() {
  const restoreFocus = mobile() && document.activeElement?.closest('#sidebar, #notes-pane, #drawer-backdrop');
  document.body.classList.remove('library-open', 'notes-open'); $('#drawer-backdrop').hidden = true;
  $('#notes-toggle').setAttribute('aria-expanded', 'false');
  $('#library-toggle').setAttribute('aria-expanded', String(!mobile() && !document.body.classList.contains('sidebar-collapsed')));
  $('#sidebar').inert = mobile() || document.body.classList.contains('sidebar-collapsed');
  $('#notes-pane').inert = mobile();
  $('#reader-pane').inert = false;
  if (restoreFocus) $('#reader-pane').focus({ preventScroll: true });
}
$('#library-toggle').addEventListener('click', () => {
  if (mobile()) { if (document.body.classList.contains('library-open')) closeDrawers(); else showDrawer('library'); }
  else { document.body.classList.toggle('sidebar-collapsed'); closeDrawers(); }
});
$('#notes-toggle').addEventListener('click', () => { if (document.body.classList.contains('notes-open')) closeDrawers(); else showDrawer('notes'); });
$('#notes-close').addEventListener('click', closeDrawers); $('#drawer-backdrop').addEventListener('click', closeDrawers);
drawerMedia.addEventListener('change', () => { closeDrawers(); closeMore(); arrangeTopbar(); });
arrangeTopbar();
let theme = localStorage.getItem('reading-theme') || 'dark';
function setTheme() {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = `${theme === 'dark' ? 'Dark' : 'Light'} theme`;
  $('#theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}
setTheme();
$('#theme-toggle').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('reading-theme', theme); setTheme(); });
let width = Math.max(22, Math.min(50, Number(localStorage.getItem('reading-notes-width')) || 30));
function setWidth(value) { width = Math.max(22, Math.min(50, value)); document.documentElement.style.setProperty('--notes-width', `${width}vw`); $('#notes-resizer').setAttribute('aria-valuenow', String(Math.round(width))); }
setWidth(width);
$('#notes-resizer').addEventListener('pointerdown', e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); document.body.classList.add('resizing'); });
$('#notes-resizer').addEventListener('pointermove', e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setWidth((innerWidth - e.clientX) / innerWidth * 100); });
function endResize() { document.body.classList.remove('resizing'); localStorage.setItem('reading-notes-width', String(width)); }
$('#notes-resizer').addEventListener('pointerup', endResize); $('#notes-resizer').addEventListener('pointercancel', endResize);
$('#notes-resizer').addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setWidth(width + (e.key === 'ArrowLeft' ? 1 : -1)); endResize(); } });

function showSettings() {
  closeMore(); $('#advanced-connection').open = false;
  const settings = getSettings();
  for (const key of ['owner', 'repo', 'branch', 'token']) $('#settings-form').elements[key].value = settings[key] || '';
  access.renderSecurity();
  $('#connection-result').textContent = ''; $('#settings-dialog').showModal(); placeToasts();
}
function formSettings() { return Object.fromEntries(['owner', 'repo', 'branch', 'token'].map(key => [key, $('#settings-form').elements[key].value.trim()])); }
$('#settings-open').addEventListener('click', showSettings);
function showHelp() { closeMore(); $('#help-dialog').showModal(); placeToasts(); }
$('#help-open').addEventListener('click', showHelp);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('close', placeToasts);
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
});
$('#test-connection').addEventListener('click', async e => {
  e.target.disabled = true; e.target.textContent = 'Testing…';
  const test = new ReadingStore(formSettings());
  try { const result = await test.testConnection(); notify(result.message); }
  catch (error) { handleError(error); }
  finally { test.dispose(); e.target.disabled = false; e.target.textContent = 'Test connection'; }
});
$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const settings = formSettings();
  if (settings.token && !settings.owner) { $('#connection-result').textContent = 'Enter the GitHub owner for this private repository.'; return; }
  if (access.unlocked) await access.leaveVault();
  else await store?.flush().catch(handleError);
  saveSettings(settings); $('#settings-form').elements.token.value = ''; $('#settings-dialog').close(); await connect(settings);
});
$('#export-data').addEventListener('click', async e => {
  e.target.disabled = true;
  try {
    const data = await store.exportData(); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
    link.download = `reading-backup-${data.complete ? '' : 'PARTIAL-'}${new Date().toISOString().slice(0, 10)}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(data.complete
      ? 'Complete backup exported without the connection token.'
      : `Partial backup exported: cached notes are safe, but remote data was unavailable. Reconnect and export again. ${data.warnings.join(' ')}`);
  } catch (error) { handleError(error); }
  finally { e.target.disabled = false; }
});
$('#import-data').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try { await store.importData(JSON.parse(await file.text())); notify('Backup merged and saved locally.'); }
  catch (error) { notify(`Import failed: ${error.message}`); }
  e.target.value = '';
});
function closeArticle() {
  ++openVersion; active = null; articleReady = false; notes = emptyNotes(); bot = '';
  reader.close(); reader.setArticle('', []); pane.setArticle(null);
  $('#article-header').replaceChildren(text('h1', 'Choose something to read.'));
  $('#reader-position').textContent = 'THE READING ROOM'; $('#reading-progress').textContent = '';
  history.pushState(null, '', store?.demo ? '#demo' : location.pathname + location.search);
  renderLibrary(); updateReaderButtons();
  if (mobile()) showDrawer('library');
  else { document.body.classList.remove('sidebar-collapsed'); closeDrawers(); library.move(0); }
}
document.addEventListener('keydown', e => {
  if (access.blocked || access.busy || e.defaultPrevented || e.isComposing) return;
  const editing = e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
  if (editing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    if (!$('#more-menu').hidden) { closeMore(true); return; }
    const statusMenus = document.querySelectorAll('.item-status-menu[open]');
    if (statusMenus.length) { statusMenus.forEach(menu => { menu.open = false; }); return; }
    if (!$('#selection-actions').hidden) { reader.closeActions(); return; }
    if (document.body.matches('.library-open, .notes-open')) { closeDrawers(); return; }
    if (reader.active) { reader.close(); return; }
    if (active) closeArticle();
    return;
  }
  if (document.querySelector('dialog[open]') || !$('#more-menu').hidden) return;
  const move = delta => {
    if (mobile()) showDrawer('library');
    else { document.body.classList.remove('sidebar-collapsed'); closeDrawers(); }
    library.move(delta);
  };
  const actions = {
    j: () => move(1), k: () => move(-1), r: toggleRead, s: () => toggleStar(),
    h: () => reader.highlight(), n: () => { showDrawer('notes'); pane.focus(); },
    '/': () => { if (!mobile()) { document.body.classList.remove('sidebar-collapsed'); closeDrawers(); } showDrawer('library'); $('#search').focus(); }, '?': showHelp
  };
  if (e.key === 'Enter' && (!e.target.closest('button,a,summary') || e.target.matches('.library-title'))) {
    e.preventDefault(); library.openFocused();
  } else if (actions[e.key]) { e.preventDefault(); actions[e.key](); }
});
function restoreArticle() {
  if (access.blocked || !store) return;
  if (!/^#(?:demo&)?article=/.test(location.hash)) return;
  try {
    const slug = articleSlug();
    if (active?.slug !== slug) void openArticle(slug, 'restore');
  } catch { notify('Invalid article link.'); }
}
window.addEventListener('popstate', restoreArticle);
window.addEventListener('hashchange', restoreArticle);
window.addEventListener('blur', () => { if (store) persist(store.flush()); });
document.addEventListener('visibilitychange', () => { if (document.hidden && store) persist(store.flush()); });
window.addEventListener('online', () => { if (store) persist(store.flush()); });
closeDrawers(); void access.start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { /* The app still works when service workers are disabled. */ });
