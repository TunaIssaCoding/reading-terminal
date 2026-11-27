import { libraryFields } from './model.js';

const PROGRESS = ['new', 'reading', 'finished', 'let_go'];
const LABELS = { new: 'New', reading: 'Reading', finished: 'Finished', let_go: 'Let go', 'with-notes': 'With notes' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lookup(collection, key) {
  return collection instanceof Map ? collection.get(key) : collection?.[key];
}

export function noteCount(item) {
  const notes = item.notes || {};
  return Number(Boolean(String(notes.long_notes || '').trim())) + (notes.highlights || []).reduce((count, highlight) => (
    count + Number(!highlight.deleted && !notes.deleted_highlights?.[highlight.id] && Boolean(String(highlight.note || '').trim()))
  ), 0);
}

/** Display a stored lowercase tag in sentence case: "tech & ai" -> "Tech & AI". */
export function tagLabel(tag) {
  const value = String(tag || '').trim();
  return (value.charAt(0).toLocaleUpperCase() + value.slice(1)).replace(/\bai\b/gi, 'AI');
}

function timestamp(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export class Library {
  constructor({ root, onOpen, onStar, onProgress, onTag }) {
    this.root = root;
    this.onOpen = onOpen;
    this.onStar = onStar;
    this.onProgress = onProgress;
    this.onTag = onTag;
    this.openGroups = new Set([...PROGRESS, 'with-notes']);
    this.focusedId = null;
    this.groups = [];
    this.densityToggle = root.ownerDocument.getElementById('library-density');
    this.setDensity(localStorage.getItem('reading-library-density'));
    this.densityToggle?.addEventListener('click', () => {
      const density = root.dataset.density === 'compact' ? 'comfortable' : 'compact';
      this.setDensity(density);
      localStorage.setItem('reading-library-density', density);
    });
    root.addEventListener('click', event => {
      const control = event.target.closest('button[data-action]');
      if (!control || !root.contains(control)) return;
      const row = control.closest('[data-library-id]');
      const id = row?.dataset.libraryId;
      switch (control.dataset.action) {
        case 'open':
          this.focusedId = id;
          this.updateCursor();
          this.onOpen?.(id);
          break;
        case 'star':
          this.onStar?.(id);
          break;
        case 'tag':
          this.onTag?.(control.dataset.tag);
          break;
        case 'progress':
          control.closest('details').open = false;
          this.onProgress?.(id, control.dataset.progress);
          break;
      }
    });
  }

  setDensity(value) {
    const compact = value !== 'comfortable';
    this.root.dataset.density = compact ? 'compact' : 'comfortable';
    if (this.densityToggle) {
      this.densityToggle.setAttribute('aria-pressed', String(compact));
      this.densityToggle.textContent = compact ? 'Compact' : 'Comfortable';
      this.densityToggle.setAttribute('aria-label', `${compact ? 'Compact' : 'Comfortable'} library density`);
      this.densityToggle.title = `Switch to ${compact ? 'comfortable' : 'compact'} library spacing`;
    }
  }

  render(items, { activeId, query = '', tag = '', starredOnly = false, progress = '', withNotes = false, shortOnly = false, source = '', bodies = {} } = {}) {
    const term = String(query).trim().toLocaleLowerCase();
    const groupKeys = withNotes ? ['with-notes'] : PROGRESS;
    const grouped = Object.fromEntries(groupKeys.map(key => [key, []]));
    for (const original of items) {
      const item = libraryFields(original);
      const current = PROGRESS.includes(item.progress) ? item.progress : 'new';
      if (starredOnly && !item.starred) continue;
      if (progress && current !== progress) continue;
      if (withNotes && !noteCount(item)) continue;
      if (shortOnly && item.read_minutes > 10) continue;
      if (source && item.source_label !== source) continue;
      if (tag && !(item.tags || []).includes(tag)) continue;
      if (term) {
        const body = lookup(bodies, item.slug) ?? lookup(bodies, item.id) ?? '';
        const searchable = [item.title, item.author, item.handle, ...(item.tags || []), body].join('\n').toLocaleLowerCase();
        if (!searchable.includes(term)) continue;
      }
      grouped[withNotes ? 'with-notes' : current].push(item);
    }
    const fragment = document.createDocumentFragment();
    this.groups = [];
    let total = 0;
    for (const key of groupKeys) {
      const rows = grouped[key];
      rows.sort(withNotes
        ? (a, b) => timestamp(b.notes?.updated_at) - timestamp(a.notes?.updated_at) || timestamp(b.added_at) - timestamp(a.added_at)
        : (a, b) => timestamp(b.added_at) - timestamp(a.added_at));
      total += rows.length;
      const group = element('details', 'library-group');
      group.dataset.progress = key;
      group.open = this.openGroups.has(key);
      const summary = element('summary', 'library-group-heading');
      summary.append(element('span', '', LABELS[key]), element('span', 'library-count', String(rows.length)));
      summary.setAttribute('aria-label', `${LABELS[key]}, ${rows.length} ${rows.length === 1 ? 'article' : 'articles'}`);
      group.append(summary);
      const list = element('ul', 'library-items');
      for (const item of rows) list.append(this.createRow(item, activeId));
      group.append(list);
      group.addEventListener('toggle', () => {
        if (group.open) this.openGroups.add(key);
        else this.openGroups.delete(key);
      });
      fragment.append(group);
      this.groups.push({ node: group, ids: rows.map(item => String(item.id)) });
    }
    if (!total) fragment.append(element('p', 'empty-state library-empty', 'No articles match these filters.'));
    this.root.replaceChildren(fragment);
    const visible = this.visibleIds();
    if (!visible.includes(this.focusedId)) this.focusedId = visible.includes(String(activeId)) ? String(activeId) : visible[0] ?? null;
    this.updateCursor();
  }

  createRow(item, activeId) {
    const progress = PROGRESS.includes(item.progress) ? item.progress : 'new';
    const row = element('li', 'library-item');
    row.dataset.libraryId = String(item.id);
    row.classList.toggle('is-active', String(item.id) === String(activeId));
    const titleLine = element('div', 'library-title-line');
    const star = element('button', 'library-star', item.starred ? '★' : '☆');
    star.type = 'button';
    star.dataset.action = 'star';
    star.classList.toggle('is-starred', Boolean(item.starred));
    star.setAttribute('aria-pressed', String(Boolean(item.starred)));
    star.setAttribute('aria-label', `${item.starred ? 'Remove keeper' : 'Keep as worth coming back to'}: ${item.title || 'Untitled article'}`);
    star.title = item.starred ? 'Keeper — worth coming back to' : 'Worth coming back to';
    const title = element('button', 'library-title', item.title || 'Untitled article');
    title.type = 'button';
    title.dataset.action = 'open';
    title.classList.toggle('title-generated', Boolean(item.title_is_generated));
    title.title = item.title || 'Untitled article';
    if (String(item.id) === String(activeId)) title.setAttribute('aria-current', 'page');
    titleLine.append(star, title);
    const menu = element('details', 'item-progress-menu');
    const menuToggle = element('summary', 'item-progress-toggle', '⋯');
    menuToggle.setAttribute('aria-label', `Change progress for ${item.title || 'article'}; currently ${LABELS[progress]}`);
    menu.append(menuToggle);
    const choices = element('div', 'item-progress-options');
    for (const nextProgress of PROGRESS) {
      const button = element('button', '', LABELS[nextProgress]);
      button.type = 'button';
      button.dataset.action = 'progress';
      button.dataset.progress = nextProgress;
      button.setAttribute('aria-pressed', String(progress === nextProgress));
      choices.append(button);
    }
    menu.append(choices);
    titleLine.append(menu);
    row.append(titleLine);
    const metadata = element('div', 'library-metadata');
    (item.tags || []).slice(0, 1).forEach(tag => {
      const chip = element('button', 'tag-chip tag-domain', tagLabel(tag));
      chip.type = 'button';
      chip.dataset.action = 'tag';
      chip.dataset.tag = tag;
      chip.title = tag;
      chip.setAttribute('aria-label', `Filter by tag ${tag}`);
      metadata.append(chip);
    });
    metadata.append(element('span', 'library-source', item.source_label));
    metadata.append(element('span', 'library-minutes', `${item.read_minutes} min`));
    const count = noteCount(item);
    if (count) {
      const badge = element('span', 'library-notes', `✎ ${count}`);
      badge.setAttribute('aria-label', `${count} ${count === 1 ? 'note' : 'notes'}`);
      metadata.append(badge);
    }
    row.append(metadata);
    if (progress === 'reading') {
      const bar = element('progress', 'library-progress');
      bar.max = 1;
      bar.value = Math.max(0, Math.min(1, Number(item.position) || 0));
      bar.setAttribute('aria-label', `Reading position for ${item.title || 'Untitled article'}`);
      row.append(bar);
    }
    return row;
  }

  visibleIds() {
    return this.groups.flatMap(group => group.node.open ? group.ids : []);
  }

  updateCursor() {
    for (const row of this.root.querySelectorAll('[data-library-id]')) {
      row.classList.toggle('is-focused', row.dataset.libraryId === this.focusedId);
    }
  }

  move(delta) {
    const ids = this.visibleIds();
    if (!ids.length) return null;
    const current = ids.indexOf(this.focusedId);
    const index = current < 0 ? (delta < 0 ? ids.length - 1 : 0) : Math.max(0, Math.min(ids.length - 1, current + delta));
    this.focusedId = ids[index];
    this.updateCursor();
    const row = [...this.root.querySelectorAll('[data-library-id]')].find(node => node.dataset.libraryId === this.focusedId);
    row?.querySelector('.library-title')?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return this.focusedId;
  }

  openFocused() {
    const visible = this.visibleIds();
    if (!visible.includes(this.focusedId)) this.focusedId = visible[0] ?? null;
    if (this.focusedId !== null) this.onOpen?.(this.focusedId);
    return this.focusedId;
  }
}
