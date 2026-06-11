You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Integrate Base UI (@base-ui-components/react) into a React dashboard plugin and use its accessible, unstyled primitives instead of raw HTML form controls — especially input, select, checkbox, number, textarea. The components MUST keep the existing visual design (a dark "Hermes" theme already implemented via plain CSS classes like `hw-input`, `hw-select`, `hw-btn`, `hw-checkbox` in a single `theme.css`). The styling must look exactly as it does today.

The plugin already has a small in-house component layer (`Button`, `Field`, `Menu`, `Modal`, `Badge`, `PageHeader`) under `apps/dashboard/src/ui/components/`, plus many raw `<input>/<select>/<textarea>/<input type=checkbox>` elements scattered across `NodeInspector`, `SettingsPage`, and `NewWorkflowModal`.

A `DESIGN.md` must document how the Base-UI-backed components are built and styled against Hermes, because the same document and approach will be reused for a second plugin later and continuously updated.

Constraints:
- Keep the exact current Hermes look; reuse the existing `theme.css` CSS-class approach (no Tailwind, no CSS-in-JS).
- SOLID, KISS, DRY. Extract repeated literals/class strings into constants. No dead fallbacks, no stubs; surface errors explicitly.
- Base UI has no Button primitive (button stays a styled native element).
- Base UI's Select/Checkbox are custom popups/widgets (not native `<select>`/`<input type=checkbox>`), so existing tests that use native select semantics will need updating.
- The component layer is consumed via a single barrel (`ui/components/index.ts`).
- React 19, Vite, Vitest + Testing Library, bun workspace.

# Project context

hermes-workflows — a Hermes dashboard plugin. TypeScript, React 19, Vite build to a committed `dashboard/dist` bundle. Styling is a single hand-written `theme.css` using CSS custom properties from the host Hermes theme (`--color-foreground`, `--color-primary`, `--radius-md`, etc.).

Conventions:
- One primitive per file under `ui/components/`, re-exported from `index.ts`.
- Class-name maps as module constants (see existing `Button` `VARIANT_CLASS`).
- Styling stays in `theme.css`; components only attach class names.
- Data-attribute-driven state styling is acceptable (Base UI exposes `data-[checked]`, `data-[highlighted]`, `data-[popup-open]`, etc.).

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
