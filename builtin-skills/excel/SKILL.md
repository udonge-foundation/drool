---
name: excel
description: Produce polished Excel spreadsheets (reports, budgets, data exports, any "export to Excel" deliverable). Use whenever the user asks for an Excel file, a spreadsheet, or an .xlsx deliverable.
---

# Authoring Excel spreadsheets

When the user wants an Excel file, author it as a **JSON workbook spec** and
let Industry render it to a real `.xlsx` on the fly. Do **not** generate a
binary `.xlsx`, do **not** write a script, and do **not** add any spreadsheet
library.

The spec is pure data (no scripts, no remote resources), which keeps
generation safe. Industry validates it, shows it inline as a spreadsheet grid
with sheet tabs, and provides a working **Download Excel** button.

## How to produce the workbook

1. Write **one** file whose name ends in `.xlsx.json` — e.g. `budget.xlsx.json`,
   `q3-report.xlsx.json`. The user only ever sees it as an Excel file (e.g.
   `budget.xlsx`); the `.json` is an internal detail.
2. Write the file in the user's current working directory (`$PWD`) using a
   relative path. Do not write it to `/tmp`, `/repo`, a delegated worktree, or
   any path outside the current working directory unless the user explicitly
   asks for that path.
3. The file is a single JSON document matching the schema below.
4. Do **not** also write a `.xlsx` file — the Excel file is generated on
   demand and is not persisted to the workspace.

## What to tell the user

Talk about it as an **Excel file** ("I've created your budget spreadsheet —
open it to preview and download"). Never mention JSON or the spec format.

## Workbook schema (these rules are enforced — stay within them)

The top level is `{ "sheets": [...] }` with 1–20 sheets. Each sheet:

```jsonc
{
  "name": "Budget",          // required; unique, ≤31 chars, no : \ / ? * [ ]
  "rows": [[...], [...]],    // required; array of rows, each an array of cells
  "columns": [{ "width": 18 }, {}], // optional; widths in Excel character units (1–255)
  "merges": ["A1:C1"],       // optional; A1-style ranges, must not overlap
  "freezeRows": 1,           // optional; header rows kept frozen when scrolling
  "conditionalFormats": [...] // optional; live formatting rules, see below
}
```

Each cell is either a plain value (`"text"`, `123.45`, `true`, or `null` for
an empty cell) or an object:

```jsonc
{
  "value": 1250.5, // string | number | boolean (null = empty cell, styling kept)
  "type": "date", // only with a string ISO value ("2026-06-10" or "2026-06-10T14:30", treated as UTC)
  "formula": "SUM(B2:B9)", // Excel formula WITHOUT the leading "=" (do not combine with "value")
  "result": 10040, // precomputed formula result, shown in the preview
  "numFmt": "$#,##0.00", // Excel number format ("0.0%", "#,##0", "$#,##0.00", ...)
  "bold": true,
  "italic": false,
  "color": "#1A1A2E", // font color, #RRGGBB
  "fill": "#EEF2FF", // background fill, #RRGGBB
  "align": "center", // "left" | "center" | "right"
}
```

### Conditional formatting

Each sheet may have a `conditionalFormats` array (≤50 entries, ≤10 rules
each). Every entry targets one A1-style cell or range and lists rules in
priority order — when rules conflict, earlier rules win. Rules stay **live**
in the downloaded file: Excel re-evaluates them as the user edits values.

```jsonc
"conditionalFormats": [
  { "ref": "B2:B13", "rules": [
    // numeric comparison; operator: "equal" | "greaterThan" | "lessThan" | "between"
    // (1 number in "values", or 2 for "between")
    { "type": "cellIs", "operator": "greaterThan", "values": [100], "style": { "fill": "#FFC7CE", "color": "#9C0006", "bold": true } },
    // 2- or 3-color heatmap across the range (min → mid → max)
    { "type": "colorScale", "colors": ["#F8696B", "#FFEB84", "#63BE7B"] },
    // in-cell bar sized to the value, like a mini bar chart
    { "type": "dataBar", "color": "#638EC6" },
    // text matching; operator: "containsText" | "containsBlanks" | "notContainsBlanks"
    // ("text" required for containsText, ≤256 chars, forbidden for the blank operators)
    { "type": "containsText", "operator": "containsText", "text": "OK", "style": { "fill": "#C6EFCE" } },
    // top/bottom N items, or N percent with "percent": true
    { "type": "top10", "rank": 10, "percent": false, "bottom": false, "style": { "bold": true } },
    // above (or below, with "aboveAverage": false) the range's average
    { "type": "aboveAverage", "aboveAverage": true, "style": { "fill": "#FFEB9C" } },
    // any Excel formula (no leading "="); evaluated by Excel in the download,
    // not shown in the inline preview — prefer the typed rules above
    { "type": "expression", "formula": "MOD(ROW(),2)=0", "style": { "fill": "#F2F2F2" } }
  ] }
]
```

`style` accepts `fill`, `color` (both `#RRGGBB`), `bold`, and `italic`.

Prefer conditional formatting over hand-baked static fills whenever the
formatting encodes the **data** — thresholds (`cellIs`), heatmaps
(`colorScale`), in-cell bars (`dataBar`), outliers (`top10`,
`aboveAverage`) — so the workbook updates itself when values change. Use
static `fill`/`bold` on cells only for fixed structure like header rows.

Limits: at most 10,000 rows per sheet, 256 columns per row, and 200,000 cells
total. Charts, pivot tables, and images are **not** supported — present such
analysis as additional sheets of data instead.

## How to design good spreadsheets

- Give every sheet a bold, filled header row and set `"freezeRows": 1`.
- Set `columns` widths so content is readable (text ~12–30, numbers ~10–14).
- Use `numFmt` for money, percentages, and large numbers — never bake
  formatting into strings (write `1250.5` with `"$#,##0.00"`, not `"$1,250.50"`).
- Use formulas for totals and derived values, and always include `result` so
  the preview shows the computed number.
- Use `conditionalFormats` to make key numbers stand out — flag values over
  budget with `cellIs`, heatmap a metric column with `colorScale`, add
  `dataBar` to magnitude columns.
- Split unrelated data across multiple sheets rather than one crowded sheet.

## Minimal example (`budget.xlsx.json`)

```json
{
  "sheets": [
    {
      "name": "Budget",
      "freezeRows": 1,
      "columns": [{ "width": 24 }, { "width": 14 }, { "width": 14 }],
      "rows": [
        [
          { "value": "Item", "bold": true, "fill": "#EEF2FF" },
          {
            "value": "Quantity",
            "bold": true,
            "fill": "#EEF2FF",
            "align": "right"
          },
          { "value": "Cost", "bold": true, "fill": "#EEF2FF", "align": "right" }
        ],
        ["Laptops", 4, { "value": 5196, "numFmt": "$#,##0.00" }],
        ["Monitors", 8, { "value": 2392, "numFmt": "$#,##0.00" }],
        [
          { "value": "Total", "bold": true },
          null,
          {
            "formula": "SUM(C2:C3)",
            "result": 7588,
            "numFmt": "$#,##0.00",
            "bold": true
          }
        ]
      ]
    }
  ]
}
```
