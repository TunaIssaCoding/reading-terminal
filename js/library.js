const STATUSES = ['unread', 'read', 'commented'];
const LABELS = { unread: 'Unread', read: 'Read', commented: 'Commented' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lookup(collection, key) {
  return collection instanceof Map ? collection.get(key) : collection?.[key];
}

function noteLength(item, meta) {
  const recorded = lookup(meta?.notes_summary_len, item.slug) ?? lookup(meta?.notes_summary_len, item.id);
  if (typeof recorded === 'number' && Number.isFinite(recorded) && recorded >= 0) return recorded;
  if (typeof item.notes_summary === 'string') return item.notes_summary.length;
  const notes = item.notes || item;
  return String(notes.long_notes || '').length + (notes.highlights || []).reduce((sum, highlight) => sum + (highlight.deleted ? 0 : String(highlight.note || '').length), 0);
}

function timestamp(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export class Library {
  constructor({ root, onOpen, onStar, onStatus, onTag }) {
    this.root = root;
    this.onOpen = onOpen;
    this.onStar = onStar;
    this.onStatus = onStatus;
    this.onTag = onTag;
    this.openGroups = new Set(STATUSES);
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
          this.onOpen?.(id);
          break;
        case 'star':
          this.onStar?.(id);
          break;
        case 'tag':
          this.onTag?.(control.dataset.tag);
          break;
        case 'status':
          control.closest('details').open = false;
          this.onStatus?.(id, control.dataset.status);
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

  render(items, { activeId, query = '', tag = '', starredOnly = false, bodies = {}, meta = {} } = {}) {
    const term = String(query).trim().toLocaleLowerCase();
    const grouped = Object.fromEntries(STATUSES.map(status => [status, []]));
    for (const item of items) {
      if (starredOnly && !item.starred) continue;
      if (tag && !(item.tags || []).includes(tag)) continue;
      if (term) {
        const body = lookup(bodies, item.slug) ?? lookup(bodies, item.id) ?? '';
        const searchable = [item.title, item.author, item.handle, ...(item.tags || []), body].join('\n').toLocaleLowerCase();
        if (!searchable.includes(term)) continue;
      }
      const status = STATUSES.includes(item.status) ? item.status : 'unread';
      grouped[status].push(item);
    }
    const fragment = document.createDocumentFragment();
    this.groups = [];
    let total = 0;
    for (const status of STATUSES) {
      const rows = grouped[status];
      rows.sort(status === 'commented'
        ? (a, b) => noteLength(b, meta) - noteLength(a, meta)
        : (a, b) => timestamp(b.status_changed_at) - timestamp(a.status_changed_at));
      total += rows.length;
      const group = element('details', 'library-group');
      group.dataset.status = status;
      group.open = this.openGroups.has(status);
      const summary = element('summary', 'library-group-heading');
      summary.append(element('span', '', LABELS[status]), element('span', 'library-count', String(rows.length)));
      summary.setAttribute('aria-label', `${LABELS[status]}, ${rows.length} ${rows.length === 1 ? 'article' : 'articles'}`);
      group.append(summary);
      const list = element('ul', 'library-items');
      for (const item of rows) list.append(this.createRow(item, activeId, status));
      group.append(list);
      group.addEventListener('toggle', () => {
        if (group.open) this.openGroups.add(status);
        else this.openGroups.delete(status);
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

  createRow(item, activeId, status) {
    const row = element('li', 'library-item');
    row.dataset.libraryId = String(item.id);
    row.classList.toggle('is-active', String(item.id) === String(activeId));
    const titleLine = element('div', 'library-title-line');
    const star = element('button', 'library-star', item.starred ? '★' : '☆');
    star.type = 'button';
    star.dataset.action = 'star';
    star.classList.toggle('is-starred', Boolean(item.starred));
    star.setAttribute('aria-pressed', String(Boolean(item.starred)));
    star.setAttribute('aria-label', `${item.starred ? 'Unstar' : 'Star'} ${item.title || 'Untitled article'}`);
    const title = element('button', 'library-title', item.title || 'Untitled article');
    title.type = 'button';
    title.dataset.action = 'open';
    title.classList.toggle('title-generated', Boolean(item.title_is_generated));
    title.title = item.title || 'Untitled article';
    if (String(item.id) === String(activeId)) title.setAttribute('aria-current', 'page');
    titleLine.append(star, title);
    const menu = element('details', 'item-status-menu');
    const menuToggle = element('summary', 'item-status-toggle', '⋯');
    menuToggle.setAttribute('aria-label', `Change status for ${item.title || 'article'}; currently ${LABELS[status]}`);
    menu.append(menuToggle);
    const choices = element('div', 'item-status-options');
    for (const nextStatus of STATUSES) {
      const button = element('button', '', LABELS[nextStatus]);
      button.type = 'button';
      button.dataset.action = 'status';
      button.dataset.status = nextStatus;
      button.setAttribute('aria-pressed', String(status === nextStatus));
      choices.append(button);
    }
    menu.append(choices);
    titleLine.append(menu);
    row.append(titleLine);
    const metadata = element('div', 'library-metadata');
    (item.tags || []).slice(0, 3).forEach((tag, index) => {
      const chip = element('button', `tag-chip${index === 0 ? ' tag-domain' : ''}`, tag);
      chip.type = 'button';
      chip.dataset.action = 'tag';
      chip.dataset.tag = tag;
      chip.title = tag;
      chip.setAttribute('aria-label', `Filter by tag ${tag}`);
      metadata.append(chip);
    });
    const byline = element('span', 'library-byline');
    const author = item.author || item.handle;
    if (author) byline.append(document.createTextNode(String(author)));
    if (item.created_at) {
      const date = new Date(item.created_at);
      if (Number.isFinite(date.getTime())) {
        if (author) byline.append(document.createTextNode(' · '));
        const time = element('time', '', date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
        time.dateTime = date.toISOString();
        byline.append(time);
      }
    }
    byline.title = byline.textContent;
    metadata.append(byline);
    row.append(metadata);
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
