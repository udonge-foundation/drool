---
name: pdf-document
description: Produce polished PDF documents (reports, invoices, resumes, letters, flyers, certificates, any "export to PDF" deliverable). Use whenever the user asks for a PDF or a printable document.
---

# Authoring PDF documents

When the user wants a PDF, author it as a structured **document spec** and let
Industry render it to a true vector PDF on the fly. Do **not** generate a binary
`.pdf`, do **not** write HTML, and do **not** add any PDF library or CDN.

The spec is a [pdfmake](https://pdfmake.github.io/docs/) `docDefinition`
serialized as JSON. It is pure data (no scripts, no DOM), which keeps generation
safe. Industry validates it, renders a crisp vector PDF (selectable text, real
pagination), and shows it inline with a working **Download PDF** button on both
web and desktop.

## How to produce the document

1. Write **one** file whose name ends in `.pdf.json` — e.g. `report.pdf.json`,
   `invoice.pdf.json`, `resume.pdf.json`. The user only ever sees it as a PDF
   (e.g. `report.pdf`); the `.json` is an internal detail.
2. Write the file in the user's current working directory (`$PWD`) using a
   relative path. Do not write it to `/tmp`, `/repo`, a delegated worktree, or
   any path outside the current working directory unless the user explicitly
   asks for that path.
3. The file content is a single JSON object: a pdfmake `docDefinition`.
4. Do **not** also write a `.pdf` file — the PDF is generated on demand and is
   not persisted to the workspace.

## What to tell the user

Talk about it as a **PDF** ("I've created your report PDF — open it to preview
and download"). Never mention HTML, JSON, pdfmake, or the spec format.

## Spec rules (these are enforced — stay within them)

- **Top-level keys** (only these): `content` (required), `styles`,
  `defaultStyle`, `pageSize`, `pageOrientation` (`"portrait"` | `"landscape"`),
  `pageMargins`, `header`, `footer`, `info`, `images`, `background`,
  `watermark`, `compress`, `language`. Unknown top-level keys are rejected.
- **Fonts**: only `"Roboto"` is available. Do not set any other `font`. Use
  `bold`/`italics` and `fontSize` for emphasis.
- **Images**: must be base64 `data:` URIs (`data:image/png;base64,…`, or jpeg,
  gif, webp). Remote URLs and file paths will be rejected. Either inline the
  `image` value as a data URI, or declare it once in the top-level `images` map
  and reference it by name. Omit images you cannot embed.
- `header`/`footer` must be static content (objects/strings/arrays), not
  functions — functions cannot appear in JSON anyway.

## Capabilities you can use in `content`

- Text with styling: `{ "text": "Title", "style": "h1" }`, plus `bold`,
  `italics`, `fontSize`, `color`, `alignment`, `margin: [l, t, r, b]`.
- Rich runs: `{ "text": ["plain ", { "text": "bold", "bold": true }] }`.
- Lists: `{ "ul": [...] }` / `{ "ol": [...] }`.
- Columns: `{ "columns": [ {...}, {...} ] }` (use `width` per column).
- Tables: `{ "table": { "headerRows": 1, "widths": ["*", "auto"],
"body": [[...], [...]] }, "layout": "lightHorizontalLines" }`.
- Spacing helpers: `margin`, `{ "text": "", "margin": [0, 8] }`.
- Page control: `pageBreak: "before"` / `"after"` on a node.

## Minimal example (`invoice.pdf.json`)

```json
{
  "pageSize": "A4",
  "pageMargins": [40, 50, 40, 50],
  "defaultStyle": { "font": "Roboto", "fontSize": 11 },
  "styles": {
    "h1": { "fontSize": 22, "bold": true, "margin": [0, 0, 0, 12] },
    "label": { "color": "#666666" }
  },
  "content": [
    { "text": "Invoice", "style": "h1" },
    {
      "columns": [
        { "text": [{ "text": "Billed to\n", "style": "label" }, "Acme Inc."] },
        {
          "text": [{ "text": "Invoice #\n", "style": "label" }, "INV-001"],
          "alignment": "right"
        }
      ],
      "margin": [0, 0, 0, 20]
    },
    {
      "table": {
        "headerRows": 1,
        "widths": ["*", "auto", "auto"],
        "body": [
          [
            { "text": "Description", "bold": true },
            { "text": "Qty", "bold": true },
            { "text": "Amount", "bold": true }
          ],
          ["Consulting", "10", "$1,000.00"],
          ["Support", "1", "$250.00"]
        ]
      },
      "layout": "lightHorizontalLines"
    },
    {
      "text": "Total: $1,250.00",
      "bold": true,
      "alignment": "right",
      "margin": [0, 16, 0, 0]
    }
  ]
}
```
