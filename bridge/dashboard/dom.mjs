/**
 * Browser helpers shared by the page's modules. Importing this in Node is harmless: nothing touches `document`
 * until a function is called. getJson is the page's only fetch, and every caller passes a literal /api/ path.
 */

import { sparkPoints } from './pure.mjs';

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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A small line chart as an SVG (built with the DOM, never as markup). `label` is what a screen reader hears. */
export function sparkline(values, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const points = sparkPoints(values, 100, 24);
  if (points !== '') {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', points);
    svg.append(line);
  }
  return svg;
}

/** Downloads a canvas (the chart screenshot) as a PNG file. The blob URL is made here, from our own canvas, and revoked after the click. */
export function saveCanvasPng(canvas, name) {
  canvas.toBlob((blob) => {
    if (blob === null) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
}
export const timeText = (seconds) => new Date(seconds * 1000).toLocaleString();
