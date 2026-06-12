# Dashboard UI design — Base UI primitives, dressed as Hermes

This document is the contract for how the dashboard plugin builds its UI controls
on top of [Base UI](https://base-ui.com/) (`@base-ui/react`) while keeping the
host **Hermes** look. It is written to be reused: a second plugin can adopt the
same pattern by copying this file and the `ui/components/` layer, then pointing
the class names at its own theme. Keep it updated as the component set grows.

## Principles

1. **One primitive per file** under `apps/dashboard/src/ui/components/`, each
   re-exported from the `index.ts` barrel. Call sites import from the barrel, not
   from Base UI directly — so the Base UI dependency stays behind one seam.
2. **Behavior + accessibility from Base UI; all visuals from our CSS.** Base UI
   ships unstyled, accessible primitives. We attach Hermes class names; the look
   lives entirely in `ui/theme.css`, driven by the host theme tokens
   (`--color-foreground`, `--color-primary`, `--color-border`, `--radius-md`, …).
   No Tailwind, no CSS-in-JS, no inline styles.
3. **Class names are constants, not call-site literals.** Each wrapper holds its
   part→class mapping as a module constant (mirroring `Button`'s `VARIANT_CLASS`).
   Call sites never spell `hw-…` strings.
4. **State styling via Base UI data-attributes**, not extra class toggling:
   `[data-checked]`, `[data-highlighted]`, `[data-popup-open]`, `[data-disabled]`,
   `[data-placeholder]`, etc.
5. **No dead fallbacks, no stubs.** Controlled components require their
   `value`/handler. A control that cannot be backed by a Base UI primitive
   (textarea) is a documented native element, not a fake "Base UI" shim.

## The package

- Use **`@base-ui/react`** (the maintained package, currently `1.5.0`), **not**
  `@base-ui-components/react` — the latter is stale on npm (`1.0.0-rc.0`).
- Subpath imports: `@base-ui/react/input`, `/select`, `/checkbox`, `/button`,
  `/field`, …
- It is a normal dashboard dependency and ships in the committed
  `dashboard/dist` bundle.

## The component layer

| Wrapper    | Base UI part            | Notes |
| ---------- | ----------------------- | ----- |
| `Button`   | `Button`                | Base UI **does** have a Button (renders native `<button>`, Field/Form-aware). Keeps the `variant`/`size` class map. |
| `Input`    | `Input`                 | Native `<input>`. `type="number"` is used directly for numeric fields — we do **not** use `NumberField` (its spinner widget is not the Hermes look). |
| `Textarea` | — (native `<textarea>`) | Base UI has no textarea primitive. The wrapper is a native element carrying `hw-input`; it exists for call-site consistency, documented as having no Base UI equivalent. |
| `Checkbox` | `Checkbox`              | A `role="checkbox"` widget (a `<span>`, not a native input). Use for multi-select option lists — the node inspector's review options, and its **Skills** multi-select (a checkbox per host `/api/skills` entry, with any current-but-uncatalogued skill still shown and checked). There is no bespoke multi-select control; compose from this primitive. |
| `Switch`   | `Switch`                | A `role="switch"` square track + sliding square thumb (**no** border-radius — the host Hermes toggle has square corners), for a single on/off setting (the settings page uses it for `bool` fields). The switch sits first in its row, the label after. |
| `Select`   | `Select`                | A portaled, keyboard-driven listbox (**not** a native `<select>`). |

### Styling contract

- Inputs/Textareas reuse `.hw-input`. The Button reuses `.hw-btn*`.
- The Select **trigger** reuses `.hw-input`'s sibling `.hw-select` look plus
  `.hw-select-trigger` for the trigger layout (value left, chevron right). The
  popup is a separate dark surface: `.hw-select-positioner` /
  `.hw-select-popup` / `.hw-select-list` / `.hw-select-item` /
  `.hw-select-group-label`, with `[data-highlighted]` for the active row.
- The Checkbox is `.hw-checkbox-box` + `.hw-checkbox-indicator`, with
  `[data-checked]` flipping the fill. An inline-text checkbox is wrapped in the
  `.hw-checkbox` row.
- The Switch is `.hw-switch` (track) + `.hw-switch-thumb`, with `[data-checked]`
  switching the track colour and sliding the thumb; the inline row is
  `.hw-switch-row`. It is square (no border-radius) and coloured from
  `--color-midground`/`--background` (with `color-mix` opacities) to match the
  host Hermes toggle exactly: 20×36 track, 14px thumb, thumb travels 2px→16px.
- **Overlays portal to `<body>`.** The Select popup sets `z-index: 60` so it
  renders above the modal overlay (`z-index: 50`) when a select is used inside a
  dialog.

### Labeling (important, and non-obvious)

Native inputs accept the visible label via `<Field htmlFor>` + `id`. The Base UI
**Select** and **Checkbox** manage their own element ids, so an external
`<label htmlFor>` cannot target them. For those controls:

- with visible inline text, the `Checkbox` wires `aria-labelledby` to its own
  text span (single, reliable accessible name);
- otherwise pass an explicit **`aria-label`** (e.g. when a `Field` renders the
  visible label above the control). This is exactly what the node inspector and
  settings page do.

Never give a control *both* inline text and an `aria-label` — that yields two
accessible names and breaks `getByLabelText`/`getByRole({name})`.

## Select API

`Select` exposes a flat API instead of Base UI's multi-part anatomy:

```tsx
<Select
  aria-label="Model"
  value={value}                       // "" is the empty/"(default)" sentinel
  items={[
    { value: "", label: "(default)" },
    { value: "gpt-4o@openai", label: "gpt-4o", group: "OpenAI" },
  ]}
  onValueChange={(next) => …}         // Base UI's `null` (cleared) maps to ""
/>
```

- `items` carry both the `value` and the display `label`; the trigger shows the
  selected item's label (Base UI maps it from `items`).
- `group` buckets items under a heading, in first-seen order; ungrouped items
  render first. The model picker uses this for provider groups.
- A value the host no longer offers (e.g. a legacy model) is preserved by the
  call site adding it as an explicit item — the component does not invent items.

## Testing Base UI in jsdom

Base UI's portaled popups touch browser APIs jsdom lacks. `tests/setup.ts` stubs
them (test-env shims, not product fallbacks): `ResizeObserver`, `matchMedia`,
`PointerEvent`, and `Element.prototype.{scrollIntoView,hasPointerCapture,
setPointerCapture,releasePointerCapture}`.

Interaction patterns:

- **Select** is a combobox, not a native `<select>` — do not use
  `selectOptions`. Open it and click the option:
  ```ts
  await userEvent.click(screen.getByRole("combobox", { name: "Profile" }));
  await userEvent.click(await screen.findByRole("option", { name: "qa-engineer" }));
  ```
- **Checkbox** / **Switch** are queried by `getByRole("checkbox", { name })` /
  `getByRole("switch", { name })` and toggled with a click — not `getByLabelText`,
  which double-matches the inline-text label wrapper.

## Deferred (next migrations)

- `Menu` and `Modal` are still in-house (custom popover / dialog with manual
  Escape/outside-click wiring). They work and are out of scope here; the planned
  follow-up is to back them with Base UI `Menu` and `Dialog` for focus-trap and
  a11y wiring, documented here when done.
- Not yet adopted: Base UI `Form`/`Field` validation surfacing, `NumberField`,
  `Slider`, `Toast`.
