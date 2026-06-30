---
name: word-document
description: Produce polished Word documents (reports, letters, proposals, printable docs, any .docx deliverable). Use whenever the user asks for a Word document or a .docx file.
---

# Authoring Word documents

When the user wants a Word document, author it as a **JSON Word document spec**
and let Industry render it to a real `.docx` on the fly. Do **not** generate a
binary `.docx`, do **not** write a script, and do **not** add any Word document
library.

The spec is pure data (no scripts, no remote resources), which keeps generation
safe. Industry validates it, shows it inline as a Word preview, and provides a
working **Download Word** button.

## How to produce the document

1. Write **one** file whose name ends in `.docx.json` (for example,
   `report.docx.json` or `proposal.docx.json`). The user only ever sees it as a
   Word file (for example, `report.docx`); the `.json` is an internal detail.
2. Write the file in the user's current working directory (`$PWD`) using a
   relative path. Do not write it to `/tmp`, `/repo`, a delegated worktree, or
   any path outside the current working directory unless the user explicitly
   asks for that path.
3. The file is a single JSON document matching the schema below.
4. Do **not** also write a `.docx` file. The Word file is generated on demand
   and is not persisted to the workspace.

## What to tell the user

Talk about it as a **Word document** ("I've created your report, open it to
preview and download"). Never mention JSON or the spec format.

## Document schema

The top level is:

```jsonc
{
  "title": "Quarterly Report",
  "metadata": {
    "title": "Quarterly Report",
    "subject": "Q3 performance",
    "creator": "Industry Drool",
    "description": "Executive report",
    "keywords": "quarterly,report",
  },
  "page": {
    "orientation": "portrait", // "portrait" | "landscape"
    "margins": { "top": 1, "right": 1, "bottom": 1, "left": 1 }, // inches
  },
  "sections": [
    {
      "children": [
        { "type": "heading", "level": 1, "text": "Quarterly Report" },
        { "type": "paragraph", "text": "Executive summary..." },
      ],
    },
  ],
}
```

Each section can override `page` and must contain 1 or more blocks. Supported
blocks are `heading`, `paragraph`, `table`, `image`, and `pageBreak`.

### Page breaks

For multi-page documents, insert explicit page breaks between intended pages.
The browser preview honors manual page breaks, but it does not infer page breaks
from rendered height like Word or Pages does.

```json
{ "type": "pageBreak" }
```

### Paragraphs and headings

Use `text` for simple content or `runs` for rich inline content:

```jsonc
{
  "type": "paragraph",
  "alignment": "left", // "left" | "center" | "right" | "justified"
  "runs": [
    { "text": "Bold lead: ", "bold": true },
    { "text": "supporting text" },
    { "text": "Industry", "hyperlink": "https://example.com", "underline": true },
  ],
}
```

Rich text runs support `text`, `bold`, `italic`, `underline`, `color`
(`#RRGGBB`), `size` (points), `break`, and `hyperlink` (`http`, `https`, or
`mailto`).

Use `heading` levels 1 through 6:

```json
{ "type": "heading", "level": 2, "text": "Findings" }
```

### Lists

Use paragraph `list` for bullets and numbered lists:

```json
{ "type": "paragraph", "text": "First action", "list": { "type": "numbered" } }
{ "type": "paragraph", "text": "Nested bullet", "list": { "type": "bullet", "level": 1 } }
```

### Tables

Tables must be rectangular (every row has the same number of cells).

```jsonc
{
  "type": "table",
  "widthPercent": 100,
  "rows": [
    [
      { "text": "Metric", "shading": "#EEF2FF" },
      { "text": "Value", "shading": "#EEF2FF" },
    ],
    [{ "text": "Revenue" }, { "text": "$1.2M" }],
  ],
}
```

Cells support either `text` or `paragraphs`, plus optional `shading`.

### Images

Images must be embedded base64 data URIs. Never reference remote URLs or local
file paths for images.

```jsonc
{
  "type": "image",
  "data": "data:image/png;base64,...",
  "width": 480,
  "height": 240,
  "altText": "Chart showing revenue growth",
}
```

Supported image types are PNG, JPEG, GIF, and BMP.

## Limits

- Up to 20 sections.
- Up to 1,000 blocks per section.
- Up to 200 runs per paragraph.
- Up to 200 table rows and 20 table columns.
- Up to 10 MB per embedded image.
- Unknown keys are rejected.

## Minimal example (`report.docx.json`)

```json
{
  "title": "Project Update",
  "metadata": { "creator": "Industry Drool" },
  "sections": [
    {
      "children": [
        { "type": "heading", "level": 1, "text": "Project Update" },
        {
          "type": "paragraph",
          "runs": [
            { "text": "Status: ", "bold": true },
            { "text": "On track", "color": "#0F7B0F" }
          ]
        },
        { "type": "heading", "level": 2, "text": "Next steps" },
        {
          "type": "paragraph",
          "text": "Finalize stakeholder review",
          "list": { "type": "numbered" }
        }
      ]
    }
  ]
}
```
