---
name: powerpoint
description: Produce polished PowerPoint presentations (decks, slide shows, pitch decks, any "export to PowerPoint" deliverable). Use whenever the user asks for a PowerPoint, a slide deck, or a presentation.
---

# Authoring PowerPoint presentations

When the user wants a PowerPoint, author it as a set of **HTML/CSS slides** and
let Industry render it to a real `.pptx` on the fly. Do **not** generate a binary
`.pptx`, do **not** write a script, and do **not** add any presentation library
or CDN.

Each slide is a `<section class="slide">` frame of plain HTML styled with inline
CSS. It is pure content (no scripts, no remote resources), which keeps generation
safe. Industry validates it, renders each slide, and shows it inline with a
working **Download PowerPoint** button (download is available on the desktop app).

## How to produce the deck

1. Write **one** file whose name ends in `.pptx.html` — e.g. `deck.pptx.html`,
   `pitch.pptx.html`, `quarterly-review.pptx.html`. The user only ever sees it
   as a PowerPoint (e.g. `deck.pptx`); the `.html` is an internal detail.
2. Write the file in the user's current working directory (`$PWD`) using a
   relative path. Do not write it to `/tmp`, `/repo`, a delegated worktree, or
   any path outside the current working directory unless the user explicitly
   asks for that path.
3. The file is a single HTML document containing one `<section class="slide">`
   per slide, plus a `<style>` block for shared styling.
4. Do **not** also write a `.pptx` file — the PowerPoint is generated on demand
   and is not persisted to the workspace.

## What to tell the user

Talk about it as a **PowerPoint** ("I've created your pitch deck — open it to
preview and download"). Never mention HTML, CSS, or the slide markup format.

## Slide rules (these are enforced — stay within them)

- Each slide is a `<section class="slide">…</section>`. The deck must contain at
  least one such section; sections without `class="slide"` are ignored.
- Design every slide for a **16:9 frame of 720×405pt (960×540px)**. The frame
  size is fixed for you — do not override the `.slide` width/height; lay your
  content out within it.
- **No scripts, event handlers, or remote resources.** `<script>`, `on*`
  handlers, remote `src`/`href`, CSS `@import`, and non-`data:` `url(...)` are
  all stripped. Anything fetched from the network is removed.
- **Images** must be embedded as base64 `data:` URIs
  (`data:image/png;base64,…`, or jpeg, gif, webp). Remote URLs and file paths
  will be removed. Omit images you cannot embed.
- **Fonts**: use web-safe families (e.g. Arial, Helvetica, Georgia,
  "Times New Roman", system-ui) or embed a font as a `data:` URI. Do not link to
  Google Fonts or any remote stylesheet.

## How to design good slides

- Use inline CSS in the `<style>` block; class names and absolute positioning
  within `.slide` work well for precise layouts.
- Keep one idea per slide: a title, a few bullets, and supporting visuals.
- Use generous font sizes (titles ~40px, body ~24px) so slides read well.
- Use background color, accent bars, and spacing for visual hierarchy.

## Minimal example (`deck.pptx.html`)

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      .slide {
        font-family: Arial, Helvetica, sans-serif;
        color: #1a1a1a;
        padding: 56px 64px;
        background: #ffffff;
      }
      .slide h1 {
        font-size: 44px;
        margin: 0 0 24px;
      }
      .slide.title {
        background: #0b5cff;
        color: #ffffff;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .slide ul {
        font-size: 24px;
        line-height: 1.6;
      }
      .accent {
        color: #0b5cff;
      }
    </style>
  </head>
  <body>
    <section class="slide title">
      <h1>Quarterly Review</h1>
      <p style="font-size: 24px; opacity: 0.85">Q3 2026 · Product</p>
    </section>
    <section class="slide">
      <h1>Highlights</h1>
      <ul>
        <li>Revenue up <span class="accent">32%</span> quarter over quarter</li>
        <li>Shipped 4 major features ahead of schedule</li>
        <li>NPS improved from 41 to 58</li>
      </ul>
    </section>
    <section class="slide">
      <h1>What's next</h1>
      <ul>
        <li>Expand to two new markets</li>
        <li>Launch the self-serve onboarding flow</li>
      </ul>
    </section>
  </body>
</html>
```
