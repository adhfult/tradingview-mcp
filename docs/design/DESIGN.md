# Dashboard design tokens (phase 7a P2)

One screen. `style.css` defines these as CSS custom properties on `:root`; nothing outside this file may add a colour, font or size. Light is the default; dark applies under `prefers-color-scheme: dark`. No webfonts: the CSP allows `'self'` only, and system fonts cost nothing on the Pi.

## Colour (contrast measured against `--surface`, all 4.5:1 or better)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f4f6f8` | `#0e1115` | page background |
| `--surface` | `#ffffff` | `#171b21` | panels, chart |
| `--border` | `#d5d9de` | `#2c333c` | panel edges, dividers (decorative, no contrast need) |
| `--text` | `#1a1d21` (16.9) | `#e6e9ed` (14.2) | body |
| `--muted` | `#4a525c` (7.9) | `#a3acb7` (7.5) | labels, timestamps |
| `--accent` | `#0b5f8f` (6.9) | `#6bbbe8` (8.1) | links, focus ring, selected stream (the one primary colour) |
| `--up` | `#17703a` (6.1) | `#4cc27a` (7.7) | up alert |
| `--down` | `#b3261e` (6.5) | `#ff7b72` (6.9) | down alert |
| `--note` | `#1f5fbf` (6.1) | `#7da8ff` (7.3) | note marker (P3) |
| `--paper` | `#8a5a00` (5.9) | `#e0b050` (8.6) | paper-trade marker |

Candle bodies reuse `--up` / `--down`; the chart library takes them as options read from the computed style, so there is one source of truth.

## Markers (never colour alone: each has a shape and a glyph)

The chart library only draws four marker shapes (`arrowUp`, `arrowDown`, `circle`, `square`), so the up and down markers are its arrows, not triangles.

- Alert up: green `arrowUp`, text "↑"
- Alert down: red `arrowDown`, text "↓"
- Paper trade: amber `square`, text "P"
- Note (P3): blue `circle`, text = first letter of the kind (N news, O opportunity, R risk); a plain note shows "•" so it is not mistaken for news

## Type

System stacks: `--font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; `--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace` for prices, times and counts (tabular numerals).

Scale (rem, base 16 px): `--text-sm` 0.8125, `--text-md` 1, `--text-lg` 1.25, `--text-xl` 1.5. Line height 1.5 body, 1.25 headings. Weights 400 and 600 only.

## Space and shape

Spacing scale (rem): `--s1` 0.25, `--s2` 0.5, `--s3` 0.75, `--s4` 1, `--s6` 1.5, `--s8` 2. Radius `--radius` 6 px, one value everywhere. No shadows: panels are separated by 1 px `--border` on `--surface`, so dark mode needs no special case.

## Layout and states

- One column below 60rem (360 px works); at 60rem and up the chart takes the left two thirds, alerts and health the right third.
- Every panel has a loading skeleton (same height as the real content), an empty state that says what goes there, and an error state that says what failed and offers a "Retry" button.
- Header badge: "Live" (`--up` dot plus text) or "Reconnecting" (`--paper` dot plus text); a stream whose last bar is older than expected gets a "Stale" text tag.
- Focus: 2 px `--accent` outline, 2 px offset, never removed. `prefers-reduced-motion`: skeleton shimmer and transitions off.
- Footer carries the required TradingView attribution link from the chart library.

## Deliberately not used

Gradients, glow, glassmorphism, shadows, emoji, icon fonts, left-edge coloured stripes, three-card rows. A trading page is data first; hierarchy comes from the type scale and the muted/text pair.
