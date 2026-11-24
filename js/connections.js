const SLUG = /^[a-z\d][a-z\d_-]*$/i;

function uniqueLinks(links = []) {
  const seen = new Set();
  return links.filter(link => {
    if (!link || typeof link.slug !== 'string' || !SLUG.test(link.slug) || seen.has(link.slug)) return false;
    seen.add(link.slug);
    return true;
  });
}

function memberships(notes) {
  return {
    links: uniqueLinks(Array.isArray(notes?.links) ? notes.links : []),
    hidden_links: [...new Set((Array.isArray(notes?.hidden_links) ? notes.hidden_links : []).filter(slug => typeof slug === 'string' && SLUG.test(slug)))],
  };
}

// The caller resolves a Keep target against the live library before deciding.
export function connectionDecision(notes, action, link) {
  const slug = typeof link === 'string' ? link : link?.slug;
  const next = { ...notes, ...memberships(notes) };
  if (typeof slug !== 'string' || !SLUG.test(slug)) return next;
  if (action === 'keep') {
    if (!next.links.some(value => value.slug === slug)) next.links.push({ slug, title: link?.title || slug });
    next.hidden_links = next.hidden_links.filter(value => value !== slug);
  } else if (action === 'unkeep') {
    next.links = next.links.filter(value => value.slug !== slug);
  } else if (action === 'hide') {
    if (!next.hidden_links.includes(slug)) next.hidden_links.push(slug);
  } else if (action === 'show') {
    next.hidden_links = next.hidden_links.filter(value => value !== slug);
  }
  return next;
}

function sameLink(a, b) {
  if (!a || !b) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

// Undo owns only this slug. A newer change to either target membership or its
// saved link data supersedes the action; other links and all note content survive.
export function undoConnection(current, before, after, slug) {
  const next = { ...current, ...memberships(current) };
  const previous = memberships(before);
  const applied = memberships(after);
  const currentLink = next.links.find(link => link.slug === slug);
  const afterLink = applied.links.find(link => link.slug === slug);
  if (!sameLink(currentLink, afterLink) || next.hidden_links.includes(slug) !== applied.hidden_links.includes(slug)) return next;
  const beforeLink = previous.links.find(link => link.slug === slug);
  if (!sameLink(beforeLink, afterLink)) {
    next.links = next.links.filter(link => link.slug !== slug);
    if (beforeLink) next.links.splice(Math.min(previous.links.indexOf(beforeLink), next.links.length), 0, beforeLink);
  }
  if (previous.hidden_links.includes(slug) !== applied.hidden_links.includes(slug)) {
    next.hidden_links = next.hidden_links.filter(value => value !== slug);
    if (previous.hidden_links.includes(slug)) next.hidden_links.splice(Math.min(previous.hidden_links.indexOf(slug), next.hidden_links.length), 0, slug);
  }
  return next;
}
