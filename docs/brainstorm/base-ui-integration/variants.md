# Base UI integration — variant audit

Consultant: Claude Code (`claude -p`), prompt in `cli-output/prompt.md`, raw output in
`cli-output/claude.md`. Three variants were produced; the consultant recommended Variant 1.

## Variant 1: Thin per-primitive wrappers (drop-in, one-to-one)
Each Base UI primitive gets its own wrapper file under `ui/components/` (`Input`, `Select`,
`Checkbox`, `Textarea`, `Button`), attaching the existing `hw-*` classes via module-level
constants and re-exported from the barrel. Prop shapes mirror the native elements they replace
so call sites swap mechanically. State styling (`data-[checked]`, `data-[highlighted]`,
`data-[popup-open]`) lives in `theme.css`.
- Complexity: medium · Risk: low

## Variant 2: Centralized class-mapping adapter/factory
A single module owns canonical part→class mappings; a factory applies them so each wrapper is a
near-empty consumer. Strongest DRY, but adds an abstraction that fights the established
"components only attach class names" convention and leaks per-primitive special cases
(Select popup, Number increment) — KISS tension, worse debuggability.
- Complexity: large · Risk: medium

## Variant 3: Field-centric composite integration
Expand `Field` to own Label/Control/Error and render the control via a `type` prop. Best
leverages Base UI's Field accessibility, but is the largest refactor (every call site rewritten),
risks a god-component (SOLID), and conflates primitive adoption with a call-site redesign.
- Complexity: large · Risk: high

## Decision: Variant 1 (agree with consultant)
It fits the repo conventions exactly (one primitive per file; class-name maps as module constants,
mirroring `Button`'s `VARIANT_CLASS`; styling confined to `theme.css`), so the visual result stays
identical with the fewest moving parts — KISS over the speculative DRY of Variant 2. It decouples
primitive adoption from a `Field` rewrite (Variant 3), keeping the Select/Checkbox test updates
isolated and mechanical. The per-file wrappers give `DESIGN.md` a clean, copyable per-primitive
pattern for the next plugin; shared class constants are extracted only where repetition is real
(the Select popup parts), not imposed up front.
