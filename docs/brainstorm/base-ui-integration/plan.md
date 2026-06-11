# Base UI integration — implementation plan

## Tasks

### Task 1: Add the dependency
- **Files**: `apps/dashboard/package.json` (+ lockfile)
- **Acceptance**: `@base-ui/react` resolves; `bun run dashboard:typecheck` sees its types.
- **Depends on**: none

### Task 2: Button wraps Base UI Button
- **Files**: `ui/components/Button.tsx`
- **Acceptance**: existing Button tests stay green; rendered element is still a `<button>` with the
  same `hw-btn*` classes; `type="submit"`/`form` still work.
- **Depends on**: Task 1

### Task 3: Input + Textarea wrappers
- **Files**: `ui/components/Input.tsx`, `ui/components/Textarea.tsx`, barrel
- **Acceptance**: `Input` renders Base UI `<input>` with `hw-input`; `type="number"` supported;
  `Textarea` renders native `<textarea>` with `hw-input`/optional tall modifier; unit tests pass.
- **Depends on**: Task 1

### Task 4: Checkbox wrapper
- **Files**: `ui/components/Checkbox.tsx`, `theme.css` (box/indicator classes), barrel
- **Acceptance**: renders a `role="checkbox"`; `checked`/`onCheckedChange` controlled; visible
  checkmark when checked; keyboard toggling works; unit test passes.
- **Depends on**: Task 1

### Task 5: Select wrapper
- **Files**: `ui/components/Select.tsx`, `theme.css` (popup/trigger/item classes), barrel
- **Acceptance**: `Select` with flat `items` (+ optional groups) renders a trigger showing the
  selected label and a portaled popup of items; selecting an item fires `onValueChange`; carries an
  `aria-label`; unit test opens the trigger and picks an item.
- **Depends on**: Task 1

### Task 6: Migrate NodeInspector
- **Files**: `editor/NodeInspector.tsx`, `tests/node-inspector.test.tsx`
- **Acceptance**: all text/number/textarea/select/checkbox controls go through the wrappers; the
  grouped model picker and the "current unknown value" preservation still work; tests pass with the
  Select interaction helper.
- **Depends on**: Tasks 3,4,5

### Task 7: Migrate SettingsPage
- **Files**: `pages/SettingsPage.tsx`, `tests/settings-page.test.tsx`
- **Acceptance**: bool→Checkbox, enum→Select, int→Input(number), text→Input; save flow unchanged;
  tests pass.
- **Depends on**: Tasks 3,4,5

### Task 8: Migrate NewWorkflowModal
- **Files**: `templates/NewWorkflowModal.tsx`, `tests/new-workflow-modal.test.tsx`
- **Acceptance**: name/projects/schedule via Input, scope/trigger via Select; submit/validation
  unchanged; tests pass.
- **Depends on**: Tasks 3,5

### Task 9: DESIGN.md + docs
- **Files**: `DESIGN.md` (plugin root), `CHANGELOG.md`, `README.md`
- **Acceptance**: DESIGN.md documents the wrapper pattern, the Hermes styling contract (tokens,
  data-attributes), per-primitive usage, and the deferred Menu/Modal migration; CHANGELOG entry added.
- **Depends on**: Tasks 2-8

### Task 10: QA + bundle
- **Files**: `dashboard/dist` (rebuilt)
- **Acceptance**: `bun run fmt && bun run lint && bun run validate` green; dist rebuilt and committed;
  manual smoke of editor/settings/new-workflow if feasible.
- **Depends on**: all
