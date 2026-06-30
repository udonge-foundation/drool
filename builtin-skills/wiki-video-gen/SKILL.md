---
name: wiki-video-gen
description: |
  Generate Industry-branded HyperFrames video overviews for repository wikis.
  Use when wiki generation reaches Phase 3.6, or when the user asks for a narrated repository overview video.
user-invocable: true
---

# Wiki video generation

Generate a polished repository overview video from `drool-wiki/` pages and real repository evidence. The output is a Industry-branded MP4 with clear TTS narration, VTT captions, useful architecture visuals, and upload-ready metadata.

When this skill is invoked by the `wiki` skill, it is the authoritative implementation for Phase 3.6. The `wiki` skill should delegate video generation here, then consume this skill's output contract in Phase 4 and Phase 5.

## Output contract

For repository `<repo>`, wiki directory `<wikiDir>`, and slug `<slug>`:

- Working directory: `<repo>/.industry/video/wiki/<slug>/`
- Canonical upload artifact: `<wikiDir>/video/overview.mp4`
- Canonical caption artifact: `<wikiDir>/video/captions.en.vtt`
- Metadata handoff: `<repo>/.industry/video/wiki/<slug>/videoOverview.json`
- Optional local artifacts:
  - `<wikiDir>/video/overview-poster.png`
  - `<repo>/.industry/video/wiki/<slug>/index.html`
  - `<repo>/.industry/video/wiki/<slug>/assets/`

`wiki-upload` must discover both `<wikiDir>/video/overview.mp4` and `<wikiDir>/video/captions.en.vtt`. The MP4 must contain video and audio only. Captions are delivered by the VTT sidecar and enabled by the Industry wiki player.

The metadata file must contain one of these shapes:

```json
{
  "status": "ready",
  "sizeBytes": 12345678,
  "contentType": "video/mp4",
  "generatedAt": "2026-06-02T00:00:00.000Z",
  "durationSeconds": 360,
  "captionTracks": [
    {
      "language": "en",
      "label": "English",
      "sizeBytes": 12345,
      "contentType": "text/vtt"
    }
  ],
  "warnings": []
}
```

```json
{
  "status": "skipped",
  "warnings": ["Video generation skipped via prompt override"]
}
```

```json
{
  "status": "failed",
  "warnings": ["hyperframes doctor failed (exit 1): missing FFmpeg"]
}
```

If a prior video is reused, do not create a new MP4. Write metadata with `status: "ready"`, include the prior run id and diff rationale in `warnings`, and tell the caller to pass `--copy-from-wiki-run-id <priorWikiRunId>` to `drool wiki-upload`.

## Non-negotiables

- Use **HyperFrames**, not Remotion, unless the user explicitly asks otherwise.
- Do not install tools globally.
- Do not modify repository `package.json`, lockfiles, `.github/workflows`, or CI config.
- Keep all temporary tooling under `.industry/video/wiki/<slug>/`.
- Produce `<wikiDir>/video/overview.mp4`; do not switch to slugged upload paths.
- Keep the MP4 under the wiki upload limit. Target `<90 MB`; hard fail or recompress before `100 MB`.
- Anchor all visual styling to the Industry Brand System at `https://industry-brand-guide.vercel.app/`.
- Do not ship a text-only slide deck, repeated centered cards, or generic `INDUSTRY` text branding.
- Do not render visible captions in HyperFrames HTML. Captions must be emitted as WebVTT sidecars, not burned into the MP4.
- Produce `<wikiDir>/video/captions.en.vtt` for every ready video.
- Validate before reporting done.
- Do not upload to Industry cloud, commit, push, or clean generated workspaces unless explicitly asked. The caller handles upload.

## Phase 0: Resolve inputs

Infer inputs in this order:

1. `repoRoot`: the current git repository root.
2. `wikiDir`: explicit user/caller value, otherwise `<repoRoot>/drool-wiki`.
3. `repoUrl`: explicit value, otherwise `git remote get-url origin`.
4. `slug`: explicit value, otherwise a lowercase repo-name slug.
5. `interactive`: whether the current session can ask user questions.
6. Prompt overrides:
   - `skip video` means skip without invoking HyperFrames.
   - `regenerate the video` means force a fresh render even if reuse would be allowed.

If `wikiDir` has no markdown pages and no prior playable remote video exists, skip with `status: "skipped"` and a warning explaining that no source wiki pages were available.

## Phase 1: Incremental reuse decision

Before rendering, check whether a prior wiki run has a playable video.

1. List prior wiki runs:
   ```bash
   drool wiki-read --repo-url <repoUrl> --json
   ```
2. Starting with the most recent, inspect each run:
   ```bash
   drool wiki-read --wiki-run-id <wikiRunId> --json
   ```
3. A run is playable when `videoOverview.status === "ready"` and `playbackUrl` is non-empty.

If no prior playable run exists, proceed to generation without emitting a classification line.

When a prior playable run exists, compute a change summary:

```bash
git rev-list --count --since=<generatedAt> HEAD
git log --since=<generatedAt> --oneline --no-merges -10
git diff --shortstat <first-commit-since>^..HEAD -- . ':!*.lock' ':!package-lock.json' ':!*.generated.*'
```

Classify the diff:

- `major`: 10+ commits, OR 20+ files changed, OR 500+ total changed lines.
- `minor`: below all major thresholds.
- `minor`: local wiki pages are missing/incomplete but a prior playable run exists.

Print:

```text
Phase 3.6: Checking for prior playable video...
Phase 3.6: Found prior video from run <wikiRunId> (generated at <generatedAt>)
Phase 3.6: Changes since prior run: <N> commit(s), <M> file(s) changed, <I> insertion(s), <D> deletion(s)
Phase 3.6: Recent commits: <one-line summaries>
video diff classification: minor
```

For `minor`, reuse the prior video unless the prompt contains `regenerate the video`. Do not invoke `hyperframes render`. Return a `copyFromWikiRunId` handoff for upload and write a warning containing the literal classification, for example:

```text
Video diff classification: minor, changes are below regeneration thresholds (3 commits, 5 files, 120 lines)
```

For `major`, generate a new video and include a warning containing the literal classification.

## Phase 2: Interactive gate

In interactive mode, ask: `Generate video overview?`

- If the user declines, skip and write `status: "skipped"` with warning `User declined video overview generation`.
- If the user accepts, continue.

In non-interactive mode, always attempt generation unless the prompt contains `skip video`.

## Phase 3: Build the story

Use `drool-wiki/` as private research context. The video should describe the **repository**, not the wiki or documentation artifact. Do not say “drool-wiki”, “generated wiki”, “wiki overview”, or “this wiki” unless the repository itself is a documentation product.

Inspect:

- `overview/index.md`
- `overview/architecture.md`
- `overview/getting-started.md`
- `by-the-numbers.md`
- important lens index pages
- source files referenced by those pages
- real screenshots/assets from `<wikiDir>/images/`

Build a 10-14 scene outline. Prefer:

1. repo-specific hook
2. purpose and user value
3. binaries/apps/packages
4. startup or request flow
5. major subsystems
6. UI/API surfaces
7. contributor hotspots
8. recap

For every scene, record the scene goal, visual archetype, evidence paths, on-screen labels, and narration beat before writing `index.html`. At least six scenes must use evidence-grounded visuals instead of title/body copy. A non-trivial repository video must not be only a sequence of dark cards with headlines and paragraphs.

Use real repo facts, source paths, diagrams, metrics, and live screenshots. If a screenshot is not live app evidence, label it honestly or use diagrams/source-grounded cards instead.

## Narration rules

The narration should feel like a guided walkthrough, not a compressed inventory.

- One idea per sentence.
- One concept per scene.
- Keep most spoken sentences under roughly 22 words.
- Do not narrate long lists.
- If a concept has many items, speak the category and show the details visually.
- Use at most 2-3 spoken examples per sentence.
- Add signposts like “First”, “Next”, “The key point is”, and “You can remember this as”.
- Open with a repo-specific hook, not a stock phrase.
- If visuals show a list, narration should explain the pattern or why it matters.
- Never speed up the voice to hit a target duration. Slow down or accept a longer video.

Target 5-8 minutes when the repo needs it. Aim for 5:30-6:30 by default, but clarity wins over strict runtime.

## Brand rules

Apply Industry brand defaults without waiting for restyling prompts. Anchor every visual decision to the Industry Brand System at `https://industry-brand-guide.vercel.app/`. In browsing-capable sessions, fetch or inspect that page before composing. In offline sessions, use the fallback tokens below and write a metadata warning that the live brand guide could not be consulted.

Treat the brand guide as the source of truth. As of the Apr 2026 guide:

- Visual principles: engineered precision, dark-first, typographic hierarchy, and technical credibility.
- Dark-first canvas: `#000000`.
- Primary accent: Industry orange `#EE6018`, accent only.
- Surfaces and borders: `#161413` surface, `#342F2D` border, `#9B8E87` gray, `#948781` footer gray, `#FFFFFF` white, `#F2F0F0` light background.
- Charts: orange gradient `#FF9F2B -> #FF8B00 -> #F35E00`, secondary strokes `#CBC5C2`, 2px max radius, labels inside bars.
- Typography: Geist Light 300 for headlines and body, never bold; Geist Mono Regular 400 for labels, metadata, captions, counters, and code-like text.
- Type scale: H1 `56px+`, H2 `28px`, body `20px`, caption/label `14px`.
- Letter spacing: `-1%` default. No italics. No underlines except links.
- Geometry: 1px borders, 0-6px radius, 4px default card radius, sharp technical cards.
- Diagrams: dark rounded rectangles, 1px borders, 90-degree connectors, orange active flow, mono labels, filled triangle arrows, labels on every connection.
- Approved textures: halftone/stipple, subtle dark grain, rotor/circuit motifs, ASCII art. Do not use glow blobs, neon, synthwave, gradient meshes, emojis, 3D renders, stock photos, or large orange fills.
- Logo rules: use the official white lockup or white rotor on dark surfaces. Never rotate, stretch, recolor, or render the logo in orange.
- Language: say Industry or Drools, not Industry AI in running text. Avoid "AI-powered", "copilot", "assistant", "helper", "magic", and empty superlatives.

Brand assets from the guide should be downloaded into `assets/brand/` when network access is available:

- `https://industry-brand-guide.vercel.app/logos/industry-lockup-white.svg`
- `https://industry-brand-guide.vercel.app/logos/rotor-white.svg`
- `https://industry-brand-guide.vercel.app/images/bg-halftone-rotor.jpg`
- `https://industry-brand-guide.vercel.app/images/bg-ascii.jpg`
- `https://industry-brand-guide.vercel.app/images/elements/halftone-dots.png`
- `https://industry-brand-guide.vercel.app/images/elements/texture-lava-figma.jpg`

The header must use an official logo asset when available, plus a scene counter or concise repo label. If official assets cannot be fetched, use a text label only as a fallback, with correct Geist/Geist Mono treatment and a metadata warning.

## Phase 4: Set up local tooling

Create the workspace before installing anything:

```bash
WORK="<repo>/.industry/video/wiki/<slug>"
mkdir -p "$WORK/assets" "$WORK/assets/brand" "$WORK/assets/fonts" "$WORK/out"
cd "$WORK"
```

Do not modify repo-level manifests. It is acceptable to create a workspace-local `package.json` inside `.industry/video/wiki/<slug>/` when needed.

Prefer the isolated Node runner for HyperFrames:

```bash
npm exec --package=node@22 --package=hyperframes@0.4.44 -- hyperframes doctor
```

If workspace-local dependencies are needed for GSAP, FFmpeg, or browser setup, install them only inside `$WORK`:

```bash
npm init -y
npm install hyperframes@0.4.44 ffmpeg-static ffprobe-static gsap
```

HyperFrames requires Node 22+. If system Node is older, run through temporary Node 24 without installing Node globally:

```bash
PATH="$PWD/node_modules/.bin:$PATH" npx -y -p node@24 node node_modules/hyperframes/dist/cli.js doctor
PATH="$PWD/node_modules/.bin:$PATH" npx -y -p node@24 node node_modules/hyperframes/dist/cli.js browser ensure
```

Use `lint .` and `render .`, not `lint ./index.html` or `render ./index.html`.

When network access is available, download the brand guide assets into the workspace before building `index.html`:

```bash
curl -fsSL https://industry-brand-guide.vercel.app/logos/industry-lockup-white.svg -o assets/brand/industry-lockup-white.svg
curl -fsSL https://industry-brand-guide.vercel.app/logos/rotor-white.svg -o assets/brand/rotor-white.svg
curl -fsSL https://industry-brand-guide.vercel.app/images/bg-halftone-rotor.jpg -o assets/brand/bg-halftone-rotor.jpg
curl -fsSL https://industry-brand-guide.vercel.app/images/bg-ascii.jpg -o assets/brand/bg-ascii.jpg
curl -fsSL https://industry-brand-guide.vercel.app/images/elements/halftone-dots.png -o assets/brand/halftone-dots.png
curl -fsSL https://industry-brand-guide.vercel.app/images/elements/texture-lava-figma.jpg -o assets/brand/texture-lava-figma.jpg
```

If asset download fails, continue with the fallback palette and write a warning in `videoOverview.json`.

## Phase 5: TTS and captions

Default to local TTS, preferably Kokoro, when available. Do not use cloud TTS by default. `edge-tts` is allowed only when the user explicitly approves a remote TTS fallback or the environment has already been provisioned for it.

Write `script.txt` first, then segment the same content into `scenes.json`.

Caption requirements:

- Generate a valid WebVTT file at `assets/captions.en.vtt`, then copy it to `<wikiDir>/video/captions.en.vtt`.
- Do not generate required SRT sidecars, and do not burn captions into the MP4.
- Keep caption chunks short: roughly 5-7 words and generally under 42 characters.
- Prefer word-level timestamps from HyperFrames transcription or Whisper.
- Do not use raw word-boundary text as visible caption text if it drops punctuation.
- Reconstruct visible cue text from the original script while preserving word-level timings.
- Normalize timings so cues are monotonic and non-overlapping.
- Start the VTT file with `WEBVTT` and verify all cue timestamps use `HH:MM:SS.mmm --> HH:MM:SS.mmm`.
- Spot-check at least three caption transitions when possible.

## Phase 6: HyperFrames composition

Create `hyperframes.json`, `meta.json`, and `index.html` in the workspace.

Composition requirements:

- `data-composition-id="main"`
- `data-width="1280"`
- `data-height="720"`
- exact `data-duration` matching the visual timeline
- 1280x720 and 24fps by default
- GSAP timeline for scene reveals/progress bars when useful
- render visuals first; mux narration afterward with FFmpeg, without subtitle filters
- CSS `@font-face` for local fonts
- slim reusable CSS and markup to avoid `file_too_large` lint warnings
- avoid huge inline SVG paths unless necessary

Visual requirements:

- Start from a Industry shell: black canvas, official white lockup or rotor in the header, top hairline, scene counter, concise repo/context label, and bottom progress indicator.
- Build at least five distinct layout archetypes across the video. Use a mix of system maps, request-flow diagrams, module grids, source-path strips, metrics/charts, terminal/code excerpts, screenshot callouts, contributor hotspots, and recap frames.
- Limit repeated single-card layouts to at most two scenes. Never render every scene as one centered surface with only a headline, paragraph, and source line.
- Use repository evidence as visible structure: real package names, source paths, command names, API names, test names, diagrams, measured counts, and screenshots from `<wikiDir>/images/` when available.
- Keep titles and metrics white. Orange is for one focal accent per scene: active connector, small marker, progress, chart fill, or selected node.
- Initialize progress bars empty and animate them over the full timeline. Do not leave a full-width bar visible from frame 0.
- Use CSS variables for the brand palette and scene tokens. Keep reusable components compact instead of duplicating markup.
- Include `@font-face` rules for local Geist/Geist Mono fonts when files are available. If local font files are unavailable, use `font-family: Geist, Inter, system-ui` and `Geist Mono, ui-monospace`, then write a metadata warning.
- Do not include a visible `.captions` container, `.caption` nodes, or subtitle text in `index.html`. Captions belong in `assets/captions.en.vtt` and are shown by the Industry wiki player.
- Do not use generic text branding such as a plain orange `INDUSTRY` word. Use the official lockup/rotor asset, or a fallback mono text label only when assets cannot be fetched.

## Phase 7: Render and mux

Run HyperFrames doctor before rendering. Doctor warnings may be persisted and do not block. Doctor failure skips rendering in non-interactive mode and writes `status: "failed"` metadata.

Render visual-only MP4 first:

```bash
PATH="$PWD/node_modules/.bin:$PATH" npx -y -p node@24 node node_modules/hyperframes/dist/cli.js lint . --verbose
PATH="$PWD/node_modules/.bin:$PATH" npx -y -p node@24 node node_modules/hyperframes/dist/cli.js render . \
  -o out/<slug>-visual.mp4 \
  --fps 24 \
  --quality draft \
  --no-browser-gpu
```

Then mux narration without burning captions:

```bash
./node_modules/.bin/ffmpeg -y \
  -i out/<slug>-visual.mp4 \
  -i assets/narration.mp3 \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ar 48000 \
  -movflags +faststart \
  out/overview.mp4
```

If the first render/mux fails, retry exactly once after fixing the cause. If the retry fails, delete any partial `<wikiDir>/video/overview.mp4`, write `status: "failed"` metadata, and return control to the caller. Overall wiki generation should remain non-fatal.

Create the poster from the visual-only video:

```bash
./node_modules/.bin/ffmpeg -y -ss 00:00:08 -i out/<slug>-visual.mp4 \
  -frames:v 1 -update 1 -vf "scale=1280:720" out/overview-poster.png
```

Copy final artifacts:

```bash
mkdir -p <wikiDir>/video
cp out/overview.mp4 <wikiDir>/video/overview.mp4
cp out/overview-poster.png <wikiDir>/video/overview-poster.png
cp assets/captions.en.vtt <wikiDir>/video/captions.en.vtt
```

Do not embed a `<video>` tag into `overview/index.md` by default. Industry cloud rendering uses `videoOverview` metadata and the uploaded MP4. Only add a markdown/HTML embed when the user explicitly asks for a local-only wiki embed.

## Validation gate

Run applicable validators before reporting done:

```bash
PATH="$PWD/node_modules/.bin:$PATH" npx -y -p node@24 node node_modules/hyperframes/dist/cli.js lint . --verbose
./node_modules/.bin/ffmpeg -v error -i <wikiDir>/video/overview.mp4 -f null -
./node_modules/.bin/ffprobe -v error \
  -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,duration \
  -show_entries format=duration,size \
  -of default=noprint_wrappers=1 \
  <wikiDir>/video/overview.mp4
git -C <repo> status --short -- .github/workflows
```

Also validate:

- MP4 exists and size is `>0`.
- MP4 bytes 4-7 are ASCII `ftyp`.
- exactly one video stream and one audio stream.
- format includes `mp4`.
- size is `<100 MB`, preferably `<90 MB`.
- `<wikiDir>/video/captions.en.vtt` exists, is `>0`, starts with `WEBVTT`, and has monotonic cue timings.
- local wiki asset links are valid if optional sidecars/poster are referenced.
- poster image has no caption line.

Use the image-capable `Read` tool to inspect the poster when possible. If the poster includes captions or an awkward blank frame, regenerate it from a stable visual-only timestamp around 6-10 seconds.

Visual QA gate:

- Inspect `index.html` before rendering. Fail and revise if it contains visible `.caption` elements, a repeated single-card-only scene structure, no brand shell, no official/fallback brand treatment, or no evidence-grounded diagrams/paths/metrics.
- Inspect at least one poster/frame from the visual-only MP4 before muxing. Fail and revise if it looks like a generic text deck, has unstyled subtitle text in the top-left corner, uses orange headlines or large orange fills, lacks a Industry header, or shows a full progress bar at the start.
- For a non-trivial repository with more than 10 wiki pages or more than 10 scenes, a fresh video shorter than 4:30 is usually too compressed. Rebuild with slower narration and richer scene pacing unless the source repo is genuinely small.
- Verify `assets/brand/` contains the downloaded brand guide assets when network access was available. If assets were unavailable, confirm the metadata warning explains the fallback.

## Troubleshooting

- If HyperFrames receives `./index.html`, retry with the project directory `.`.
- If doctor cannot find Chrome, run `hyperframes browser ensure` inside the workspace.
- If Node is too old, use `npx -y -p node@24 node ...`; do not install Node globally.
- If duplicate media discovery appears, remove repeated `<img>` references and use CSS backgrounds or a persistent overlay.
- If lint warns about file size, reduce repeated markup/assets and minify generated HTML.
- If narration feels rushed, lower the TTS rate or let the video run longer.
- If captions are too long or obtrusive, split them into shorter WebVTT cues.
- If subtitles change early or late, rebuild from word-level timestamps or shorter TTS segments.
- If captions lose punctuation, reconstruct cue text from the original script.
- If final duration differs from audio by a fraction of a second, keep the visual duration as container duration but ensure audio is complete.

## Done response

Keep the final response concise:

- MP4 path.
- Duration, resolution, fps, size.
- Whether the video is new or reused.
- Validation results.
- Any warnings that were written to `videoOverview.json`.
