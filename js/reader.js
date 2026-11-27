import { renderMarkdown } from './markdown.js';

const uid = () => crypto.randomUUID();
const elementTarget = target => target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
const isTyping = target => elementTarget(target)?.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), .note-editor');
const textNodes = root => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
};
function point(nodes, offset) {
  for (const node of nodes) {
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
  }
  const last = nodes.at(-1);
  return [last, last?.length || 0];
}
function rangeAt(nodes, start, end) {
  const range = document.createRange();
  range.setStart(...point(nodes, start)); range.setEnd(...point(nodes, end));
  return range;
}

/**
 * Where a highlight's note goes: just after the sentence the highlight ends in, past its closing
 * quotes and spaces, or at the end of the paragraph. A full stop only ends a sentence when the next
 * word starts with a capital, a digit or a quote, so "e.g. this" and "3.14" don't split.
 */
export function sentenceEnd(text, offset) {
  let from = Math.max(0, Math.min(offset, text.length));
  while (from > 0 && /\s/.test(text[from - 1])) from--;
  const end = /[.!?…]+["'”’»)\]]*(?=\s+[\p{Lu}\p{N}"'“‘«(\[]|\s*$)/gu;
  end.lastIndex = Math.max(0, from - 1);
  const match = end.exec(text);
  if (!match) return text.length;
  let index = match.index + match[0].length;
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

function fit(editor) {
  editor.style.height = 'auto';
  editor.style.height = `${editor.scrollHeight}px`;
}

function separateImageParagraphs(root) {
  for (const paragraph of root.querySelectorAll('p')) {
    const images = [...paragraph.querySelectorAll('img')];
    if (!images.length || !paragraph.textContent.trim()) continue;
    const parts = []; let previous = null;
    for (const image of [...images, null]) {
      const range = document.createRange(); range.selectNodeContents(paragraph);
      if (previous) range.setStartAfter(previous);
      if (image) range.setEndBefore(image);
      const content = range.cloneContents();
      if (content.textContent.trim()) {
        const block = document.createElement('p'); block.append(content); parts.push(block);
      }
      if (image) {
        const block = document.createElement('p'); block.append(image.cloneNode(true)); parts.push(block);
      }
      previous = image;
    }
    paragraph.replaceWith(...parts);
  }
}

export class Reader {
  constructor({ root, warnings, onChange, onQuote, onDelete, onOpen, getAsset, notify }) {
    Object.assign(this, { root, warnings, onChange, onQuote, onDelete, onOpen, getAsset, notify });
    this.highlights = []; this.lines = []; this.active = null;
    this.actions = document.querySelector('#selection-actions');
    document.addEventListener('selectionchange', () => this.captureSelection());
    this.actions.addEventListener('pointerdown', e => e.preventDefault());
    document.querySelector('#highlight-selection').addEventListener('click', () => this.highlight());
    document.querySelector('#send-selection').addEventListener('click', () => {
      if (!this.selection) return;
      const quote = this.selection.quote;
      this.closeActions(); this.onQuote(quote);
    });
    document.querySelector('#copy-selection').addEventListener('click', async () => {
      if (!this.selection) return;
      const quote = this.selection.quote;
      this.closeActions();
      try { await navigator.clipboard.writeText(quote); window.getSelection()?.removeAllRanges(); this.notify('Passage copied.'); }
      catch { this.notify('Clipboard unavailable. Use your browser’s Copy command.'); }
    });
    document.addEventListener('pointerdown', e => {
      if (!this.actions.contains(elementTarget(e.target))) this.closeActions();
    });
    const reposition = () => { if (!this.actions.hidden) this.positionActions(); };
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    this.root.addEventListener('click', e => {
      const mark = elementTarget(e.target)?.closest('[data-highlight]');
      if (mark && window.getSelection()?.isCollapsed !== false) {
        e.preventDefault(); this.edit(mark.dataset.highlight);
      } else {
        const link = elementTarget(e.target)?.closest('[data-article]');
        if (link) { e.preventDefault(); this.onOpen(link.dataset.article); }
      }
    });
    this.root.addEventListener('dragstart', e => this.drag(e));
    this.root.addEventListener('dragend', () => document.body.classList.remove('dragging-highlight'));
    this.root.addEventListener('input', e => this.input(e));
    this.root.addEventListener('compositionend', e => this.input(e));
    this.root.addEventListener('keydown', e => this.editorKey(e));
    this.root.addEventListener('click', e => {
      const button = elementTarget(e.target)?.closest('[data-note-action]');
      if (!button) return;
      const item = this.highlights.find(h => h.id === button.dataset.id);
      if (!item) return;
      if (button.dataset.noteAction === 'delete') {
        this.onDelete(structuredClone(item));
      } else if (button.dataset.noteAction === 'quote') this.onQuote(item.quote);
      else this.edit(item.id);
    });
  }
  setArticle(markdown, highlights = []) {
    this.markdown = markdown; this.highlights = structuredClone(highlights);
    this.active = null; this.selection = null; this.closeActions(); this.layout();
  }
  updateHighlights(highlights) {
    this.highlights = structuredClone(highlights); this.layout();
  }
  getHighlights() {
    return this.highlights.filter(h => !h.deleted).map(h => {
      const anchor = this.anchors?.find(value => value.h.id === h.id);
      const line = anchor?.start === undefined ? null : this.lines.find(value => value.start <= anchor.start && value.end > anchor.start);
      return structuredClone(line ? { ...h, start: anchor.start, para: line.para } : h);
    });
  }
  closeActions() { this.actions.hidden = true; this.selection = null; this.selectionRange = null; }
  close() {
    this.active = null; this.closeActions(); this.renderNotes();
    if (isTyping(document.activeElement) && this.root.contains(document.activeElement)) document.activeElement.blur();
  }
  layout() {
    const focused = this.caret();
    this.closeActions();
    this.root.innerHTML = renderMarkdown(this.markdown || '');
    separateImageParagraphs(this.root);
    this.lines = []; this.paragraphs = []; this.text = '';
    const candidates = [...this.root.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre')]
      .filter(el => !el.querySelector('p, li, pre') && !el.querySelector('img'));
    for (const el of candidates) {
      if (el.tagName !== 'PRE') {
        for (const node of textNodes(el)) node.data = node.data.replace(/[\t\r\n ]+/g, ' ');
      }
      const text = el.textContent;
      if (!text.trim()) continue;
      if (this.text) this.text += '\n\n';
      const start = this.text.length;
      this.paragraphs.push({ el, text, start, nodes: textNodes(el) });
      this.text += text;
    }
    this.anchors = this.highlights.filter(h => !h.deleted).map(h => ({ h, ...this.anchor(h) }));
    for (const anchor of this.anchors) if (anchor.start !== undefined) anchor.noteAt = this.noteOffset(anchor.end);
    for (let para = 0; para < this.paragraphs.length; para++) {
      const { el, text, nodes, start: globalStart } = this.paragraphs[para];
      const globalEnd = globalStart + text.length;
      // Text flows normally. A paragraph is split only after a highlighted sentence, so a note can
      // open up space right below that sentence; empty note slots take no space.
      const breaks = [...new Set([globalStart, globalEnd,
        ...this.anchors.map(a => a.noteAt).filter(at => at > globalStart && at < globalEnd)])].sort((a, b) => a - b);
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < breaks.length - 1; i++) {
        const from = breaks[i], to = breaks[i + 1];
        const line = document.createElement('span'); line.className = 'source-line';
        const source = document.createElement('span'); source.className = 'line-text';
        const gap = document.createElement('span'); gap.className = 'line-gap';
        const overlapping = this.anchors.filter(a => a.start !== undefined && a.start < to && a.end > from);
        const cuts = [...new Set([from, to, ...overlapping.flatMap(a => [Math.max(from, a.start), Math.min(to, a.end)])])].sort((a, b) => a - b);
        for (let c = 0; c < cuts.length - 1; c++) {
          const a = cuts[c], b = cuts[c + 1];
          const highlight = overlapping.find(v => v.h.id === this.active && v.start <= a && v.end >= b)
            || overlapping.find(v => v.start <= a && v.end >= b);
          const run = document.createElement(highlight ? 'mark' : 'span');
          run.className = 'source-run'; run.dataset.offset = a; run.dataset.end = b;
          if (highlight) {
            run.dataset.highlight = highlight.h.id; run.draggable = true;
            run.title = 'Click to add or edit a note · drag to long notes';
          }
          const range = rangeAt(nodes, a - globalStart, b - globalStart);
          let content = range.cloneContents();
          // A range contained in one link omits that link's own element. Keep its inline ancestry.
          for (let ancestor = elementTarget(range.commonAncestorContainer); ancestor && ancestor !== el; ancestor = ancestor.parentElement) {
            const wrapper = ancestor.cloneNode(false);
            wrapper.append(content); content = wrapper;
          }
          run.append(content);
          source.append(run);
        }
        line.append(source, gap); fragment.append(line);
        this.lines.push({ element: line, source, gap, start: from, end: to, para });
      }
      el.replaceChildren(fragment); el.classList.add('source-paragraph');
    }
    this.renderNotes(focused);
    this.renderWarnings();
    for (const img of this.root.querySelectorAll('img[data-asset-path]')) {
      const path = img.dataset.assetPath;
      img.removeAttribute('src');
      this.getAsset(path).then(url => { if (img.isConnected) img.src = url; })
        .catch(() => { img.alt = `${img.alt || 'Image'} — unavailable offline or missing`; });
    }
  }
  /** The text offset a highlight's note sits at: the end of the sentence its last character is in. */
  noteOffset(end) {
    const block = this.paragraphs.find(p => end > p.start && end <= p.start + p.text.length);
    if (!block) return end;
    const blockEnd = block.start + block.text.length;
    if (block.el.tagName === 'PRE' || /^H[1-6]$/.test(block.el.tagName)) return blockEnd;
    return block.start + sentenceEnd(block.text, end - block.start);
  }
  anchor(h) {
    if (!h.quote) return {};
    let index = this.text.indexOf(h.quote), best = -1, score = -Infinity;
    while (index >= 0) {
      let rank = 0;
      if (h.prefix && this.text.slice(Math.max(0, index - h.prefix.length), index) === h.prefix) rank += 4;
      if (h.suffix && this.text.slice(index + h.quote.length, index + h.quote.length + h.suffix.length) === h.suffix) rank += 4;
      if (this.paragraphs[h.para]?.start <= index && index < this.paragraphs[h.para].start + this.paragraphs[h.para].text.length) rank += 2;
      if (index === h.start) rank += 1;
      if (rank > score) { best = index; score = rank; }
      index = this.text.indexOf(h.quote, index + 1);
    }
    return best < 0 ? {} : { start: best, end: best + h.quote.length };
  }
  endpoint(node, offset) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const run = el?.closest('.source-run');
    if (!run || !this.root.contains(run)) return null;
    const range = document.createRange(); range.selectNodeContents(run);
    try { range.setEnd(node, offset); } catch { return null; }
    return Number(run.dataset.offset) + range.toString().length;
  }
  captureSelection() {
    const selected = window.getSelection();
    if (document.body.classList.contains('auth-blocked') || !selected?.rangeCount || selected.isCollapsed
      || isTyping(document.activeElement) || isTyping(selected.anchorNode) || isTyping(selected.focusNode)) {
      this.closeActions(); return;
    }
    const range = selected.getRangeAt(0);
    const start = this.endpoint(range.startContainer, range.startOffset);
    const end = this.endpoint(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) { this.closeActions(); return; }
    const quote = this.text.slice(start, end);
    if (!quote.trim()) { this.closeActions(); return; }
    this.selection = { start, end, quote, para: this.lines.find(l => l.start <= start && l.end > start)?.para || 0,
      prefix: this.text.slice(Math.max(0, start - 48), start), suffix: this.text.slice(end, end + 48) };
    this.selectionRange = range.cloneRange();
    this.actions.hidden = false;
    this.positionActions();
  }
  positionActions() {
    const range = this.selectionRange;
    if (!range || !this.root.contains(range.startContainer) || !this.root.contains(range.endContainer)
      || document.body.classList.contains('auth-blocked')) { this.closeActions(); return; }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const inset = 8;
    this.actions.style.maxWidth = `${Math.max(0, width - inset * 2)}px`;
    this.actions.style.maxHeight = `${Math.max(0, height - inset * 2)}px`;
    this.actions.style.overflow = 'auto';
    const toolbar = this.actions.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    this.actions.style.left = `${Math.max(left + inset, Math.min(left + width - toolbar.width - inset, rect.left))}px`;
    this.actions.style.top = `${Math.max(top + inset, Math.min(top + height - toolbar.height - inset, rect.top - toolbar.height - inset))}px`;
  }
  highlight() {
    if (!this.selection) return;
    const { quote, prefix, suffix, para, start } = this.selection;
    const existing = this.highlights.find(h => !h.deleted && h.quote === quote && h.prefix === prefix);
    const now = new Date().toISOString();
    const item = existing || { id: uid(), quote, prefix, suffix, para, start, note: '', created_at: now, updated_at: now };
    if (!existing) this.highlights.push(item);
    this.active = item.id; this.selection = null;
    window.getSelection()?.removeAllRanges(); this.closeActions(); this.changed(); this.layout(); this.focusNote(item.id, item.note.length);
  }
  edit(id) { this.active = id; this.renderNotes(); this.focusNote(id, this.highlights.find(h => h.id === id)?.note.length || 0); }
  changed() {
    const deleted = this.highlights.filter(h => h.deleted).map(h => structuredClone(h));
    this.onChange([...this.getHighlights(), ...deleted]);
  }
  caret() {
    const editor = document.activeElement;
    if (!editor?.matches('.note-editor')) return null;
    return { id: editor.dataset.id, offset: editor.selectionStart };
  }
  renderNotes(focus = null) {
    this.lines.forEach(line => line.gap.replaceChildren());
    const placed = this.anchors.filter(a => a.start !== undefined).sort((a, b) => a.start - b.start);
    for (const { h, noteAt } of placed) {
      if (!h.note?.trim() && this.active !== h.id) continue;
      const line = this.lines.find(value => value.end === noteAt) || this.lines.findLast(value => value.start < noteAt);
      if (!line) continue;
      const block = this.noteBlock(h);
      line.gap.append(block);
      const editor = block.querySelector('.note-editor');
      if (editor) fit(editor);
    }
    if (focus) this.focusNote(focus.id, focus.offset);
  }
  noteBlock(h) {
    const block = document.createElement('span'); block.className = 'note-block'; block.dataset.id = h.id;
    if (this.active === h.id) {
      const editor = document.createElement('textarea'); editor.className = 'note-editor';
      editor.rows = 1; editor.value = h.note || ''; editor.dataset.id = h.id;
      editor.placeholder = 'Your note on this passage…';
      editor.setAttribute('aria-label', 'Note on the highlighted passage');
      block.append(editor);
    } else {
      const note = document.createElement('button'); note.type = 'button'; note.className = 'note-text';
      note.dataset.noteAction = 'edit'; note.dataset.id = h.id; note.textContent = h.note;
      note.setAttribute('aria-label', `Edit note: ${h.note}`);
      block.append(note);
    }
    const controls = document.createElement('span'); controls.className = 'note-controls';
    for (const [action, text, label] of [['quote', '↗', 'Send highlighted passage to long notes'], ['delete', '×', 'Delete highlight']]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.noteAction = action;
      button.dataset.id = h.id; button.textContent = text; button.setAttribute('aria-label', label); button.title = label; controls.append(button);
    }
    block.append(controls);
    return block;
  }
  focusNote(id, offset) {
    const editor = [...this.root.querySelectorAll('.note-editor')].find(el => el.dataset.id === id);
    if (!editor) return;
    editor.focus({ preventScroll: true });
    const at = Math.max(0, Math.min(editor.value.length, offset));
    editor.setSelectionRange(at, at);
    editor.scrollIntoView({ block: 'nearest' });
  }
  input(e) {
    const editor = e.target;
    if (!editor.matches?.('.note-editor') || e.isComposing) return;
    const h = this.highlights.find(item => item.id === editor.dataset.id);
    if (!h) return;
    // The note is one text box below its sentence, so typing never rebuilds the article.
    h.note = editor.value; h.updated_at = new Date().toISOString();
    this.changed(); fit(editor);
  }
  editorKey(e) {
    const editor = e.target;
    if (!editor.matches('.note-editor')) return;
    const h = this.highlights.find(item => item.id === editor.dataset.id);
    if (e.key === 'Escape' || (e.key === 'Backspace' && !h?.note)) {
      e.preventDefault(); e.stopPropagation(); this.close(); this.root.closest('main').focus({ preventScroll: true });
    }
  }
  drag(e) {
    const mark = elementTarget(e.target)?.closest('[data-highlight]');
    if (!mark) return;
    const h = this.highlights.find(item => item.id === mark.dataset.highlight);
    e.dataTransfer.setData('application/x-reading-highlight', JSON.stringify({ id: h.id, quote: h.quote }));
    e.dataTransfer.setData('text/plain', h.quote); e.dataTransfer.effectAllowed = 'copy';
    const ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = h.quote.slice(0, 140);
    document.body.append(ghost); e.dataTransfer.setDragImage(ghost, 20, 20);
    setTimeout(() => ghost.remove(), 0); document.body.classList.add('dragging-highlight'); this.closeActions();
  }
  renderWarnings() {
    this.warnings.replaceChildren();
    for (const { h, start } of this.anchors) {
      if (start !== undefined) continue;
      const card = document.createElement('div'); card.className = 'anchor-warning';
      const title = document.createElement('strong'); title.textContent = 'Passage moved or changed';
      const quote = document.createElement('blockquote'); quote.textContent = h.quote;
      const note = document.createElement('p'); note.textContent = h.note;
      card.append(title, quote, note); this.warnings.append(card);
    }
  }
}
