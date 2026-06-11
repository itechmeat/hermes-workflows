### Variant 1: Thin per-primitive wrappers (drop-in, one-to-one)
- **Approach**: Each Base UI primitive gets its own wrapper file under `ui/components/` (`Input`, `Select`, `Checkbox`, `NumberField`, `Textarea`), each attaching the existing `hw-*` classes via a module-level class-name constant and re-exported from the barrel. Wrapper prop shapes mirror the native elements they replace so call sites in `NodeInspector`, `SettingsPage`, and `NewWorkflowModal` swap with near-zero churn. State styling (`data-[checked]`, `data-[highlighted]`, `data-[popup-open]`) lives entirely in `theme.css`.
- **Trade-offs**:
  - Pro: Directly mirrors existing conventions (one primitive per file, class maps as constants like `Button`'s `VARIANT_CLASS`).
  - Pro: Lowest migration risk; each call site changes mechanically and independently.
  - Pro: Styling stays purely declarative class attachment; no new abstraction to learn.
  - Con: Some repetition across wrappers (each restates its part→class wiring).
  - Con: Select/Checkbox multi-part popups still need per-component part wiring (Trigger, Positioner, Popup, Item), so wrappers aren't truly uniform.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Centralized class-mapping adapter/factory
- **Approach**: A single shared module defines the canonical Hermes part→class mappings (e.g. `HW_CLASSES.select.popup`), and a small factory/helper applies them to Base UI parts so each primitive wrapper is a near-empty consumer of the central map. DRY is maximized: all class strings and part wiring live in one authoritative place that `DESIGN.md` documents as the reuse contract for the second plugin.
- **Trade-offs**:
  - Pro: Strongest DRY; class literals defined once, ideal as the portable artifact for the next plugin.
  - Pro: A single place to audit visual fidelity against `theme.css`.
  - Con: Adds an abstraction layer that fights the established "components only attach class names" convention; risks over-engineering (KISS tension).
  - Con: Base UI parts differ enough per primitive (Number has increment/decrement, Select has popup/positioner) that a generic factory leaks special cases, eroding the DRY payoff.
  - Con: Harder to trace a class from call site through the factory — worse debuggability.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Field-centric composite integration
- **Approach**: Lean into Base UI's `Field`/`Form` grouping by expanding the existing `Field` component to own Label/Control/Error wiring and render the correct control via a `type`/`control` prop (or slot composition). Fewer standalone primitives are exported; call sites declare fields declaratively rather than assembling label + input + error by hand.
- **Trade-offs**:
  - Pro: Best leverages Base UI's accessibility wiring (label association, validation/error messaging) for free.
  - Pro: Reduces boilerplate at call sites that currently hand-wire labels and validation.
  - Con: Largest refactor — every call site in all three screens must be rewritten to the field model, not a mechanical swap.
  - Con: A `type`-switch control risks a god-component that violates SOLID and accumulates per-field special cases.
  - Con: Highest test churn; couples primitive adoption to a call-site redesign, conflating two concerns.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: It fits the established conventions exactly (one primitive per file, class-name maps as module constants, styling confined to `theme.css`) so the visual result stays identical with the least moving parts, satisfying KISS over the speculative DRY of Variant 2. It decouples primitive adoption from call-site redesign, keeping the Select/Checkbox test updates isolated and mechanical rather than entangled with a `Field` rewrite as in Variant 3. The per-file wrappers also give `DESIGN.md` a clean, copyable per-primitive pattern for the second plugin, with shared class constants extracted only where repetition is real rather than imposed up front.
