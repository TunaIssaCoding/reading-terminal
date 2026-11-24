const HIGHLIGHT_TYPE = 'application/x-reading-highlight';
let nextPaneId = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function position(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Infinity;
}

function highlightStart(highlight) {
  return position(highlight.start ?? highlight.start_offset ?? highlight.anchor?.start ?? highlight.anchor?.offset);
}

function quotedDraft(base, quote) {
  const current = base.trimEnd();
  return `${current}${current ? '\n\n' : ''}${quote}\n\n`;
}

function meaningfulText(value) {
  return value.trim().replace(/\s+/g, ' ');
}

export class NotesPane {
  constructor({ root, getItem, onChange, onOpen, onRemoveLink, onJump, notify }) {
    this.root = root;
    this.getItem = getItem;
    this.onRemoveLink = onRemoveLink;
    this.quoteDraft = null;
    this.onChange = onChange;
    this.onOpen = onOpen;
    this.onJump = onJump;
    this.notify = notify;
    this.articleId = null;
    this.dragDepth = 0;
    const id = `long-notes-${++nextPaneId}`;
    const editorSection = element('section', 'long-notes-section');
    const heading = element('h2', 'notes-section-heading');
    const label = element('label', '', 'Long notes');
    label.htmlFor = id;
    heading.append(label);
    this.textarea = element('textarea', 'long-notes-editor');
    this.textarea.id = id;
    this.textarea.rows = 12;
    this.textarea.placeholder = 'Your thoughts, questions, and connections…';
    this.textarea.disabled = true;
    this.textarea.spellcheck = true;
    const hint = element('p', 'notes-editor-hint', 'Markdown welcome. Drop a highlighted passage here, or use its Send to notes button.');
    hint.id = `${id}-hint`;
    this.textarea.setAttribute('aria-describedby', hint.id);
    this.dropStatus = element('p', 'notes-drop-status');
    this.dropStatus.setAttribute('role', 'status');
    this.dropStatus.setAttribute('aria-live', 'polite');
    editorSection.append(heading, this.textarea, hint, this.dropStatus);
    const divider = element('hr', 'notes-divider');
    const marginSection = element('section', 'margin-notes-section');
    const marginHeading = element('h2', 'notes-section-heading', 'Highlights');
    marginHeading.id = `${id}-margins`;
    marginSection.setAttribute('aria-labelledby', marginHeading.id);
    marginSection.append(marginHeading, element('p', 'notes-section-hint', 'In reading order. Select a quote to return to it.'));
    this.margins = element('div', 'margin-notes-list');
    marginSection.append(this.margins);
    const linksSection = element('section', 'kept-links-section');
    const linksHeading = element('h2', 'notes-section-heading', 'Kept links');
    linksHeading.id = `${id}-links`;
    linksSection.setAttribute('aria-labelledby', linksHeading.id);
    this.links = element('div', 'kept-links-list');
    linksSection.append(linksHeading, this.links);
    root.replaceChildren(editorSection, divider, marginSection, linksSection);

    this.textarea.addEventListener('input', event => {
      this.autogrow();
      if (event.isComposing) return;
      if (this.quoteDraft) {
        const value = meaningfulText(this.textarea.value);
        if (value === meaningfulText(this.quoteDraft.value)) return;
        const unchanged = value === meaningfulText(this.quoteDraft.base);
        this.quoteDraft = null;
        if (unchanged) return;
      }
      this.onChange?.(this.textarea.value);
    });
    this.textarea.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.quoteDraft) return;
      event.preventDefault();
      event.stopPropagation();
      this.textarea.value = this.quoteDraft.base;
      this.quoteDraft = null;
      this.autogrow();
    });
    let previousWidth = 0;
    this.resize = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width === previousWidth) return;
      previousWidth = width; this.autogrow();
    });
    this.resize.observe(this.textarea);
    document.fonts?.ready.then(() => this.autogrow());
    root.addEventListener('click', event => {
      const target = event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
      const link = target?.closest('a[data-article]');
      if (link && root.contains(link)) {
        event.preventDefault();
        this.onOpen?.(link.dataset.article);
      }
    });
    const dropRoot = root.closest('aside') || root;
    dropRoot.addEventListener('dragenter', event => {
      if (!this.accepts(event)) return;
      event.preventDefault();
      this.dragDepth++;
      root.classList.add('is-drag-over');
      this.dropStatus.textContent = 'Drop to append this highlighted passage to your long notes.';
    });
    dropRoot.addEventListener('dragover', event => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = this.accepts(event) ? 'copy' : 'none';
    });
    dropRoot.addEventListener('dragleave', event => {
      if (event.relatedTarget && dropRoot.contains(event.relatedTarget)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (!this.dragDepth || !event.relatedTarget || !dropRoot.contains(event.relatedTarget)) this.clearDrag();
    });
    dropRoot.addEventListener('drop', event => {
      const accepted = this.accepts(event);
      this.clearDrag();
      event.preventDefault();
      if (!accepted) return;
      try {
        const highlight = JSON.parse(event.dataTransfer.getData(HIGHLIGHT_TYPE));
        if (!highlight || typeof highlight.id !== 'string' || !highlight.id || typeof highlight.quote !== 'string' || !highlight.quote.trim()) {
          this.notify?.('This drop was not a valid highlighted passage.');
          return;
        }
        this.appendQuote(highlight.quote);
      } catch {
        this.notify?.('This drop was not a valid highlighted passage.');
      }
    });
    document.addEventListener('dragend', () => this.clearDrag());
    this.updateMargins([]);
    this.updateLinks([]);
  }

  accepts(event) {
    return this.articleId !== null && Array.from(event.dataTransfer?.types || []).includes(HIGHLIGHT_TYPE);
  }

  clearDrag() {
    this.dragDepth = 0;
    this.root.classList.remove('is-drag-over');
    this.dropStatus.textContent = '';
  }

  autogrow() {
    const pane = this.root.closest('aside') || this.root;
    const scrollTop = pane.scrollTop;
    this.textarea.style.height = '0px';
    this.textarea.style.height = `${this.textarea.scrollHeight}px`;
    pane.scrollTop = scrollTop;
  }

  setArticle(item, notes = {}) {
    const articleId = item ? String(item.id ?? item.slug) : null;
    if (articleId !== this.articleId) this.quoteDraft = null;
    this.articleId = articleId;
    this.textarea.disabled = !item;
    const value = String(notes?.long_notes ?? '');
    if (this.quoteDraft) {
      if (value !== this.quoteDraft.base) {
        this.quoteDraft.base = value;
        this.quoteDraft.value = quotedDraft(value, this.quoteDraft.quote);
        this.textarea.value = this.quoteDraft.value;
      }
    } else if (this.textarea.value !== value) this.textarea.value = value;
    this.autogrow();
    this.textarea.setAttribute('aria-label', item ? `Long notes for ${item.title || 'this article'}` : 'Long notes');
    this.clearDrag();
    this.updateMargins(notes?.highlights || []);
    this.updateLinks(notes?.links || []);
  }

  updateMargins(highlights = []) {
    const notes = highlights.filter(highlight => !highlight.deleted).map((highlight, index) => ({ highlight, index }));
    notes.sort((a, b) => {
      const paragraphA = position(a.highlight.para ?? a.highlight.anchor?.para);
      const paragraphB = position(b.highlight.para ?? b.highlight.anchor?.para);
      if (paragraphA !== paragraphB) return paragraphA < paragraphB ? -1 : 1;
      const startA = highlightStart(a.highlight);
      const startB = highlightStart(b.highlight);
      return startA !== startB ? (startA < startB ? -1 : 1) : a.index - b.index;
    });
    const fragment = document.createDocumentFragment();
    if (!notes.length) fragment.append(element('p', 'empty-state margin-notes-empty', 'Your highlights and interlinear notes will appear here.'));
    for (const { highlight } of notes) {
      const entry = element('article', 'margin-note');
      entry.dataset.highlightId = String(highlight.id || '');
      const quote = element('blockquote', 'margin-note-quote');
      const jump = element('button', 'margin-quote-jump', String(highlight.quote || ''));
      jump.type = 'button';
      jump.disabled = !highlight.id;
      jump.addEventListener('click', () => this.onJump?.(highlight.id));
      quote.append(jump);
      const note = String(highlight.note || '').trim() ? element('p', 'margin-note-text', String(highlight.note)) : null;
      const send = element('button', 'margin-send-button', 'Send quote to long notes');
      send.type = 'button';
      send.disabled = this.articleId === null || !String(highlight.quote || '').trim();
      send.addEventListener('click', () => this.appendQuote(highlight.quote));
      entry.append(quote);
      if (note) entry.append(note);
      entry.append(send);
      fragment.append(entry);
    }
    this.margins.replaceChildren(fragment);
  }

  updateLinks(links = []) {
    const fragment = document.createDocumentFragment();
    const seen = new Set();
    for (const link of links) {
      if (!link || typeof link.slug !== 'string' || !/^[a-z\d][a-z\d_-]*$/i.test(link.slug) || seen.has(link.slug)) continue;
      seen.add(link.slug);
      const row = element('p', 'kept-link');
      row.dataset.slug = link.slug;
      const item = this.getItem?.(link.slug);
      const anchor = element(item ? 'a' : 'span', '', item?.title || link.title || link.slug);
      if (item) {
        anchor.href = `#article=${encodeURIComponent(link.slug)}`;
        anchor.dataset.article = link.slug;
      }
      row.append(anchor);
      if (!item) row.append(element('span', 'connection-missing', 'not in your library'));
      const remove = element('button', 'kept-link-remove', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove link to ${item?.title || link.title || link.slug}`);
      remove.addEventListener('click', () => this.onRemoveLink?.(link.slug));
      row.append(remove);
      fragment.append(row);
    }
    if (!seen.size) fragment.append(element('p', 'empty-state', 'Links you keep will appear here.'));
    this.links.replaceChildren(fragment);
  }

  focus() {
    this.textarea.focus();
  }

  reviseQuote(quote) {
    if (this.articleId === null || typeof quote !== 'string' || !quote.trim()) return false;
    const base = this.quoteDraft?.base ?? this.textarea.value;
    const quoted = quote.trim().replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n');
    const value = quotedDraft(base, quoted);
    this.quoteDraft = { base, quote: quoted, value };
    this.textarea.value = value;
    this.autogrow();
    this.focus();
    this.textarea.setSelectionRange(value.length, value.length);
    const pane = this.root.closest('aside') || this.root;
    const bottom = this.textarea.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom;
    if (bottom > 0) pane.scrollTop += bottom + 16;
    return true;
  }

  appendQuote(quote) {
    if (this.articleId === null || typeof quote !== 'string' || !quote.trim()) return false;
    this.quoteDraft = null;
    const current = this.textarea.value.trimEnd();
    const quoted = quote.trim().replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n');
    this.textarea.value = `${current}${current ? '\n\n' : ''}${quoted}`;
    this.autogrow();
    this.onChange?.(this.textarea.value);
    this.focus();
    this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
    const pane = this.root.closest('aside') || this.root;
    const bottom = this.textarea.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom;
    if (bottom > 0) pane.scrollTop += bottom + 16;
    this.notify?.('Passage appended to Notes.');
    return true;
  }
}
