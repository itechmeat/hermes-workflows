# CLAUDE.md

Guidance for agents working in this repository.

## What this is

Hermes Workflows is a dashboard plugin for Hermes Agent. A user draws an automation as a
graph (agent tasks, shell steps, branches, review gates, waits) and it runs on Hermes' own
primitives: Kanban cards, Cron jobs, and Profiles. It is not a second engine - every node
compiles to a native Hermes primitive.

The product is two languages by design:

- **TypeScript core on Bun** - the engine, compiler, schema, and CLI. This is where the logic
  lives (`packages/core`).
- **A thin Python bridge** - so Hermes can load the plugin in-process (`hermes_workflows/`).
  It has no runtime dependencies; it adapts the core to the host and polls the board.

## Commands

Install: `bun install`

Full gate (run this before any commit; CI runs the same):

```bash
bun run validate
```

`validate` chains, in order: `typecheck` -> `lint` -> `test` (core) -> `test:py` (pytest) ->
`dashboard:typecheck` -> `dashboard:test` -> `dashboard:build` -> `dashboard:check`.

Individual steps:

| Need | Command |
| --- | --- |
| TS typecheck | `bun run typecheck` |
| Lint / autofix | `bun run lint` / `bun run lint:fix` (oxlint) |
| Format / check | `bun run fmt` / `bun run fmt:check` (oxfmt) |
| Core tests | `bun test packages/core` (single file: `bun test packages/core/tests/<f>.test.ts`) |
| Python tests | `python3 -m pytest` (single: `python3 -m pytest tests/python/test_<x>.py -k <name>`) |
| Dashboard typecheck/test/build | `bun run dashboard:typecheck` / `dashboard:test` / `dashboard:build` |
| Dashboard bump+rebuild | `bun run dashboard:rebuild` (bump the build number, then build) |
| Dashboard dist drift guard | `bun run dashboard:check` |

The dashboard builds to the committed `dashboard/dist`. After any dashboard change, rebuild
with `bun run dashboard:rebuild` and commit the regenerated `dist` together with the bumped
`apps/dashboard/build-number.json` - `dashboard:check` fails the gate on drift. A build-free
change must still pass `dashboard:typecheck`.

The header shows the plugin version plus a monotonic build counter as `vX.Y.Z-bN` (e.g.
`v0.3.0-b1`). The counter lives in `apps/dashboard/build-number.json` and is baked into the
bundle at build time. It is bumped deliberately by `dashboard:bump` (which `dashboard:rebuild`
runs first), never inside `vite build`: the plain `dashboard:build` must stay deterministic so
the `dashboard:check` drift guard keeps passing when CI rebuilds from the committed counter.
Bump it by one for each committed dashboard build; reset it to 0 on release (the release
rebuild then makes it 1, shown as `-b1`).

CLI entry: `bin/hermes-workflows` (Python bridge) exposes `run`, `status`, `advance-all`,
`review`, `cancel`. The TypeScript engine CLI is `packages/core/src/cli.ts`.

## Architecture

- `packages/core/src/schema/` - the spec model. `nodes.ts` (node types), `load.ts` (parse +
  validate input), `validateWorkflow.ts`, `serialize/serializeWorkflow.ts` (lossless round-trip,
  block scalars for multiline). `workflow.ts` carries top-level config (triggers, notifications).
- `packages/core/src/compiler/compileToHermesPlan.ts` - turns a graph into a `HermesPlan`
  (`kanban_tasks`, `script_steps`, `wait_steps`, `subscribe_cards`, ...).
- `packages/core/src/runtime/` - `advance.ts` is the pure decision function (what to do next,
  no I/O). `db/` is the SQLite `runs.db` (WAL, `busy_timeout` raised for concurrent host +
  CLI writers; per-node columns added via an ALTER migration in `schema.ts`).
- `packages/core/src/memory/` - Open Second Brain memory providers (fail-open, redacting).
- `hermes_workflows/engine.py` - the orchestrator: `_advance_step` polls cards, evaluates
  `wait` nodes, applies node updates. `bridge/` adapts Kanban / Cron / Profiles / notify.
  `executor/` runs node work (kanban, script, composite). `wait.py` evaluates external
  signals (e.g. a merged PR). `gate_reply.py` routes a chat reply into a paused review gate.
  `plugin.py` registers the `/workflow` command and gateway hooks.
- `apps/dashboard/` - React 19 + `@xyflow/react` visual editor and run inspector, built with
  Vite into `dashboard/dist`.

Node types: `agent_task`, `script`, `condition`, `human_review`, `finish`, `wait`. Inter-node
data flows via `input_mapping: { x: "{{nodes.<id>.output}}" }`, substituted at schedule time
and failing loud on a missing output. Runs are single-flight: at most one active run per
workflow.

An `adopt` node's `task_ref: "{{nodes.<id>.output.task_ids}}"` drives the board cards a prior
node RESOLVED. The reliable contract: the resolving node's worker emits the chosen ids in a
structured block in its output - a fenced ```` ```task_ids ```` code block (or a
`<task_ids>…</task_ids>` tag) - which the engine captures into that node's typed `task_ids`
channel, isolated from any stray `t_`-shaped token in its prose. A bare shape-scrape of
free-text output is only a last-resort fallback (it grabs any/wrong id and cannot isolate a
chosen subset). An adopt that resolves zero ids fails the run closed.

## Conventions

- TypeScript: strict, ESM, `.ts` extension imports, Bun runtime. Run `fmt` then `lint` before
  every commit; a green formatter and linter is a precondition for the commit, not cleanup.
- Python: 3.11+, tests in `tests/python`, the bridge stays dependency-free.
- The version appears in `package.json`, `apps/dashboard/package.json`, `pyproject.toml`, and
  `plugin.yaml`. Bump the user-facing ones together on release, and reset
  `apps/dashboard/build-number.json` to 0 in the same release commit (the release rebuild
  takes the header to `vX.Y.Z-b1`).
- Prose style for any docs, comments, and release copy: neutral and measured. No exclamation
  marks. Use a regular hyphen, colon, or a reworded sentence instead of a long (em) dash.
- TDD: write the failing test first, implement to green, commit the atomic unit as a
  conventional commit (`feat(scope):`, `fix(scope):`, `chore:`, `docs:`).

## Release image (diagram)

Every release ships one diagram. It is authored as an SVG, rendered to frames, and delivered
as a looping animated GIF. The SVG source lives under `.releases/` (kept as a release asset
alongside the GIF; note `.releases/` is gitignored, so assets are uploaded to the GitHub
release rather than committed).

### House style

- Format: a terminal-window mockup. `viewBox="0 0 1640 1240"`.
- Window chrome: a rounded outer border, a title bar with three traffic-light dots
  (red `#ff5f56`, yellow `#ffbd2e`, green `#27c93f`) and a centered window title
  `hw - hermes-workflows - vX.Y.Z`.
- Background: a dark scanline pattern over `#0d1117` / `#0f141c`.
- Font: `'Courier New', Courier, monospace` throughout.
- Palette:
  - green `#39d353` - primary accent, the "good" path, success
  - amber `#ffb000` - secondary accent: waits, external signals, decisions
  - text `#e6edf3` (headings), `#9fb0c0` (body inside boxes), `#8b949e` (muted labels, captions)
  - box fill `#11161d`, border `#30363d`, chrome bar `#161b22`
- Boxes: rounded rect (`rx="8"`), thin border (`stroke-width="1.4"`), with a colored left
  accent bar 9px wide. The hero/center box uses a thicker colored border (about `2.4`) instead
  of an accent bar.
- A header block: a small workflow-DAG glyph logo, the `HERMES WORKFLOWS` title, a
  `vX.Y.Z - <TAGLINE>` line, a right-aligned release date, and a one-line subtitle.
- A `$ command` line near the top (green `$`, white command, muted flags).
- A status bar strip near the bottom: four short green items on a `#161b22` bar.
- A footer `$ command` line ending in a blinking block caret, plus a right-aligned repo slug.

### Arrows (this one matters)

- Draw every arrow as an explicit `<line>` plus a `<polygon>` arrowhead.
- Do NOT use SVG `<marker>` elements. Markers scale with `stroke-width` and render as giant
  arrowheads through the SVG-to-raster pipeline. Explicit geometry rasterises identically and
  to scale.
- `stroke-width` about 3; arrowhead polygon base about 18px; color matches the path's meaning
  (green or amber).

### The schema must fit the release

- Design the diagram structure around THIS release's content. Do not reuse a previous
  release's geometry. A lifecycle loop is correct only when the release actually describes a
  repeating cycle; a set of independent capabilities is not a loop, and forcing one produces a
  closing arrow that connects nothing real.
- Lead with the user-facing usefulness: what the user can now do, not which file changed.
- Show a "before -> after" contrast ONLY for a principal change (one behavior fully replaced
  another - e.g. a real card replacing a shadow card). For a purely additive update, show the
  new value with no "was:" line.
- A hub layout (the subject at the center, each win as a satellite reached by one arrow) reads
  well for "a set of related wins around one idea".

### Layout rules (measure, do not eyeball)

- For each text line, compute its width before rendering: in monospace, one character is about
  `0.6 x font-size` px, so a line is about `char_count x 0.6 x font-size` px.
- A box's usable inner width is its width minus the left text inset (text starts about 34px in)
  minus a right margin (about 12px). Every line must fit; shorten the copy that does not.
- Arrow and side labels must fit the gap between boxes. A narrow gap (about 130px between a
  center box and a side box) holds only a short single word at font 16. Center the label in the
  gap and never let it cross into a box.
- Keep footer baselines aligned and place the caret immediately after the last character of the
  command, never mid-word (a mid-word caret is what makes a footer look crooked).

### Build pipeline

1. Author or edit the SVG at `.releases/vX.Y.Z-<slug>-source.svg`.
2. Render to a 2x PNG with the SVG-to-PNG render script (the `baoyu-diagram` skill's
   `scripts/main.ts`, run with bun: `bun <skill>/scripts/main.ts <svg> -o <png>`).
3. View the rendered PNG and inspect every box edge, label/box junction, and arrow gap for
   overflow or overlap. This step is mandatory; a glance at the whole image is not enough.
4. Make two frames for the blink: frame 0 with the caret visible, frame 1 with the caret rect
   `fill="none"`. Render both to PNG.
5. Assemble the GIF with ffmpeg (palettegen then paletteuse), `framerate 2` (about 0.5s per
   frame), `-loop 0`, scaled to 1640 wide:

   ```bash
   ffmpeg -y -framerate 2 -start_number 0 -i frame%d.png \
     -vf "scale=1640:-1:flags=lanczos,palettegen=stats_mode=full" pal.png
   ffmpeg -y -framerate 2 -start_number 0 -i frame%d.png -i pal.png \
     -lavfi "scale=1640:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none" -loop 0 out.gif
   ```

### Final-image acceptance rules

- The deliverable is the animated GIF with a blinking terminal caret, not a static PNG.
- No SVG markers, and no giant arrowheads.
- No text overflows or overlaps any box; side labels stay inside their gaps.
- The footer is straight and the caret sits at the end of the command line.
- The schema reflects the release's actual value; no recycled loop.
- The SVG source ships as a release asset alongside the GIF, and the release body image points
  at the GIF.
- Diagram text is in English, matching the public release notes.
