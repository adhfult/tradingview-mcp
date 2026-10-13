/**
 * Browser helpers shared by the page's modules. Importing this in Node is harmless: nothing touches `document`
 * until a function is called. getJson is the page's only fetch, and every caller passes a literal /api/ path.
 */

export const $ = (id) => document.getElementById(id);

export async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (res.status === 401) throw new Error('not authorised: open the dashboard URL with ?token=...');
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const errorText = (err) => (err instanceof Error ? err.message : String(err));

/** Replaces a list's children with `rows`, each a function that fills one <li>. */
export function renderList(list, rows) {
  list.replaceChildren(...rows.map((fill) => {
    const li = document.createElement('li');
    fill(li);
    return li;
  }));
}

export function addText(parent, tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  parent.append(el);
  return el;
}

export function setStatus(id, text, kind) {
  const el = $(id);
  el.hidden = text === '';
  el.textContent = text;
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

export const timeText = (seconds) => new Date(seconds * 1000).toLocaleString();
