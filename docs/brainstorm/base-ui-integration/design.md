# Base UI integration — Hermes-styled component primitives

**Status:** draft
**Author:** Sol Aitken (via feature-release-playbook)
**Audience:** implementation

## Problem statement
The dashboard plugin builds form controls from raw HTML (`<input>`, `<select>`, `<textarea>`,
`<input type=checkbox>`) scattered across `NodeInspector`, `SettingsPage`, and `NewWorkflowModal`.
We want accessible, consistent controls backed by Base UI's unstyled primitives, while keeping the
exact current Hermes dark-theme look. The pattern must be documented in a reusable `DESIGN.md`
because a second plugin will adopt it.

## Scope
- Add the maintained Base UI package `@base-ui/react` (v1.5.0) to the dashboard workspace.
- Per-primitive wrapper components under `ui/components/`, barrel-exported: `Input`, `Textarea`,
  `Select`, `Checkbox`, and a Base-UI-backed `Button`.
- Reuse the existing `hw-*` CSS in `theme.css`; add classes only for the multi-part Select popup
  and the Checkbox box/indicator, styled to match today's look. State styling via data-attributes.
- Migrate the raw controls in `NodeInspector`, `SettingsPage`, `NewWorkflowModal` to the wrappers.
- Write `DESIGN.md` (plugin root) documenting how the wrappers are built and used with Hermes.
- Update the affected component tests (the 3 native `selectOptions` call sites + checkbox toggles).

## Out of scope
- Migrating `Menu` and `Modal` to Base UI `Menu`/`Dialog`. They are custom but functional; they are
  documented in `DESIGN.md` as the next planned migration. Deferred to keep this change focused.
- Base UI `Form`/`Field` validation wiring and `NumberField`/`Slider`/`Toast` adoption.
- Any change to the host Hermes theme tokens.

## Chosen approach
Variant 1 — thin per-primitive wrappers. Each wrapper attaches `hw-*` classes (held in module
constants) to the matching Base UI part and forwards native-ish props, so call sites swap with
near-zero churn. Multi-part components (Select, Checkbox) assemble their parts internally and
expose a flat prop API. Styling stays declarative in `theme.css`.

## Design decisions
- **Package `@base-ui/react`, not `@base-ui-components/react`.** The latter is stale on npm
  (`1.0.0-rc.0`); the maintained name is `@base-ui/react` (`1.5.0`), matching the skill. Pin exact.
- **Button wraps Base UI `Button`.** Base UI ships a `Button` primitive (Field/Form aware); our
  `Button` keeps its `variant`/`size` class map and renders through it, so submit buttons keep
  working and we are consistent with "use Base UI instead of raw HTML".
- **Numbers use `Input type="number"`, not `NumberField`.** KISS: preserves the current plain
  numeric look; `NumberField` adds an increment/decrement widget we do not want here. Documented.
- **`Textarea` is a native `<textarea>` wrapper.** Base UI has no textarea primitive; the wrapper
  exists for call-site consistency and to carry `hw-input`/`hw-textarea--tall`. Documented honestly
  as "no Base UI equivalent" — not a stub.
- **Keep the existing `Field` label wrapper.** Variant 1 does not rewrite labeling. Select (a button
  trigger, not a native control) carries its accessible name via `aria-label`, exactly as the
  current native selects already do.
- **Select API.** A single `Select` takes `items: SelectItem[]` (value + label, optional `group`)
  plus `value`/`onValueChange`/`placeholder`/`aria-label`. Grouped items render Base UI
  `Select.Group` + `GroupLabel` (the model picker needs this). A "current but unknown" value is
  passed in as an item by the call site, preserving today's behavior.
- **Class constants.** Per-part class strings live as module constants in each wrapper (mirroring
  `Button`'s `VARIANT_CLASS`); no inline class literals at call sites.
- **Fail loud.** No silent fallbacks. Controlled components require their value/handler; nothing is
  swallowed.

## File changes
- New: `ui/components/Input.tsx`, `Textarea.tsx`, `Select.tsx`, `Checkbox.tsx`; rewrite `Button.tsx`
  to wrap Base UI. Update `ui/components/index.ts` barrel.
- `ui/theme.css`: add Select-popup and Checkbox part classes; keep `hw-input`/`hw-select`/`hw-btn`.
- Migrate `editor/NodeInspector.tsx`, `pages/SettingsPage.tsx`, `templates/NewWorkflowModal.tsx`.
- `apps/dashboard/package.json`: add `@base-ui/react`.
- New: `DESIGN.md` (plugin root). Update `CHANGELOG.md`, `README.md`.
- Tests: `tests/node-inspector.test.tsx`, `tests/new-workflow-modal.test.tsx`,
  `tests/settings-page.test.tsx`; new `tests/ui-components.test.tsx`.

## Risks and open questions
- **Select is a portaled popup**, not a native `<select>`. Tests must open the trigger and click an
  item (helper provided) instead of `selectOptions`. jsdom has no layout, so the Positioner must
  still mount the popup; verify items are queryable. Mitigation: a `selectOption(label)` test helper.
- **Visual fidelity**: the custom Select must match the native look (height, padding, border, dark
  popup, hover/selected states). Mitigation: drive from the same tokens as `hw-select`.
- **Bundle size**: Base UI adds to the committed `dashboard/dist`. Accepted; it is the design goal.
- **dist guard**: the committed bundle must be rebuilt in the same commit.
