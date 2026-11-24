import { libraryFields } from './model.js';

const slots = ['long', 'short', 'archive'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() !== '';
const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

/** Edition filenames follow the device calendar, not the UTC date. */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Keep valid sections of a read-only edition; warn once for the whole validation. */
export function parseEdition(input, library, date = localDate(), warn = console.warn) {
  let invalid = false;
  const warning = () => warn('Reading edition contains invalid or unavailable data; affected sections were skipped.');
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { warning(); return null; }
  }
  if (!object(input) || !dateKey(date) || (input.date !== undefined && input.date !== date)) {
    warning();
    return null;
  }
  const known = new Set((library || []).map(item => item.slug));
  const hasSlug = slug => typeof slug === 'string' && known.has(slug);
  const why = value => text(value) && value.trim().length <= 120;
  const edition = { date, generated_at: '', bot: 'Reading bot', picks: [], margin: null, arrivals: [] };
  if (input.generated_at != null && input.generated_at !== '') {
    if (typeof input.generated_at === 'string' && Number.isFinite(Date.parse(input.generated_at))) edition.generated_at = input.generated_at;
    else invalid = true;
  }
  if (input.bot != null) {
    if (text(input.bot)) edition.bot = input.bot.trim();
    else if (input.bot !== '') invalid = true;
  }
  const picked = new Set();
  const occupied = new Set();
  if (!Array.isArray(input.picks)) invalid = true;
  else for (const pick of input.picks) {
    if (!object(pick) || !slots.includes(pick.slot) || !hasSlug(pick.slug) || !why(pick.why) ||
        picked.has(pick.slug) || occupied.has(pick.slot)) { invalid = true; continue; }
    picked.add(pick.slug);
    occupied.add(pick.slot);
    edition.picks.push({ slot: pick.slot, slug: pick.slug, why: pick.why.trim() });
  }
  edition.picks.sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
  if (input.margin != null) {
    const margin = input.margin;
    if (object(margin) && hasSlug(margin.slug) && text(margin.highlight_id) && why(margin.why)) {
      edition.margin = { slug: margin.slug, highlight_id: margin.highlight_id, why: margin.why.trim() };
    } else invalid = true;
  }
  if (input.arrivals != null) {
    if (!Array.isArray(input.arrivals)) invalid = true;
    else {
      const arrived = new Set();
      for (const slug of input.arrivals) {
        if (!hasSlug(slug) || arrived.has(slug)) { invalid = true; continue; }
        arrived.add(slug);
        edition.arrivals.push(slug);
      }
    }
  }
  if (invalid) warning();
  return edition;
}

export function editionMinutes(edition, items) {
  const bySlug = new Map(items.map(item => [item.slug, item]));
  return (edition?.picks || []).reduce((total, pick) => {
    const item = bySlug.get(pick.slug);
    return total + (item ? libraryFields(item).read_minutes : 0);
  }, 0);
}

export function editionDone(edition, items) {
  if (!edition?.picks.length) return false;
  const bySlug = new Map(items.map(item => [item.slug, item]));
  return edition.picks.every(pick => ['finished', 'let_go'].includes(bySlug.get(pick.slug)?.progress));
}

export function findMargin(edition, notes) {
  if (!edition?.margin || !Array.isArray(notes?.highlights)) return null;
  const highlight = notes.highlights.find(value => value?.id === edition.margin.highlight_id && !value.deleted);
  if (!highlight) return null;
  const deleted = notes.deleted_highlights?.[highlight.id];
  return deleted && !(Date.parse(deleted) < Date.parse(highlight.updated_at || highlight.created_at)) ? null : highlight;
}

/** Only the agreement field changes; saveNotes owns persistence timestamps. */
export function setStillAgree(notes, highlightId, date = localDate()) {
  if (!dateKey(date)) throw new Error('Still agree needs a local calendar date.');
  return { ...notes, highlights: (notes?.highlights || []).map(highlight => highlight.id === highlightId
    ? { ...highlight, still_agree_at: date } : highlight) };
}

/** Undo owns only this agreement, never a concurrent note, anchor or deletion. */
export function undoStillAgree(current, before, after, highlightId) {
  const original = before?.highlights?.find(highlight => highlight.id === highlightId);
  const applied = after?.highlights?.find(highlight => highlight.id === highlightId);
  if (!original || !applied) return current;
  return { ...current, highlights: (current?.highlights || []).map(highlight => {
    if (highlight.id !== highlightId || highlight.still_agree_at !== applied.still_agree_at) return highlight;
    const restored = { ...highlight };
    if (original.still_agree_at === undefined) delete restored.still_agree_at;
    else restored.still_agree_at = original.still_agree_at;
    return restored;
  }) };
}
