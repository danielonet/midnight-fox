# Midnight Fox

A Firefox extension that gives every website a dark mode. Sites that already
have a dark mode are left alone; sites that don't get their colour palette
remapped into a dark theme of your choice.

## Features

- **6 dark themes:** Midnight, OLED Black, Dim Grey, Sepia Night, Nord, Solarized Dark
- **Respects native dark mode:** Firefox asks every site for `prefers-color-scheme: dark`.
  Pages that already look dark are detected and left untouched.
- **Palette remapping, not inversion.** Each element's computed colours are
  translated into the theme:
  - white and light backgrounds become the theme's background and surface colours
  - dark text becomes the theme's text colour
  - coloured buttons, links and alerts keep their hue
  - images are never inverted
  - `:hover` and `:focus` colours from the page's stylesheets are remapped too
- **Live updates:** content added later (infinite scroll, single-page apps) is darkened as it appears.
- **Per-site control:** *Auto* / *Always* / *Never*.
- **Adjustable:** background brightness, text contrast, and an optional image dimmer.
- **Keyboard shortcuts:** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> toggles the current
  site; <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> toggles everything.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox (115 or newer).
2. Click **Load Temporary Add-on…** and select `manifest.json` from this folder.
3. If Firefox asks for website access, allow it. You can also allow it from the popup.

To package a build, run `npx web-ext build`. To start a test profile with the
extension loaded, run `npx web-ext run`.

## How it works

| File | Role |
| --- | --- |
| `src/palette.js` | Theme definitions and colour maths (shared code) |
| `src/content.js` | Detects pages that are already dark, remaps colours, watches for changes |
| `src/background.js` | Requests sites' own dark mode, handles shortcuts and the strict-CSP fallback |
| `popup/` | Toolbar popup: theme picker, site mode, sliders |

The content script reads each element's computed `color`, `background-color`,
gradient, border and SVG `fill`/`stroke`. It maps them through the theme and
groups identical results into generated rules such as
`[data-midnight-fox="12"] { color: …!important }`. Each element gets the
matching attribute. Text colour is only set where it differs from the parent,
so the number of rules stays small. When you switch themes, the rules are
regenerated without scanning the page again.

## Tests

```sh
npm test          # runs the content script on test pages in headless Chromium
npm run lint      # web-ext lint
```

## Known limitations

- Colours inside `::before` / `::after` pseudo-elements and cross-origin
  stylesheets' `:hover` rules aren't remapped.
- Text drawn into images or `<canvas>` can't be recoloured. Use **Dim images** to soften bright images.
