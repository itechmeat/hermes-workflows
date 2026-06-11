import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "../icons";

// Dropdown select. Backed by Base UI's `Select` — a portaled, keyboard-driven
// listbox (NOT a native <select>), styled as the Hermes control + dark popup.
// Exposes a flat API: `items` (value + display label, with an optional `group`)
// plus controlled `value`/`onValueChange`. The trigger shows the selected
// item's label (Base UI maps it from `items`). As the trigger is a button, its
// accessible name comes from `aria-label`, exactly as the old native selects did.

export interface SelectItem {
  value: string;
  /** Text shown for the item and, when selected, in the trigger. */
  label: string;
  /** Items sharing a group render under one heading, in first-seen order. */
  group?: string;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  items: SelectItem[];
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

// Per-part class names kept as constants (mirrors Button's VARIANT_CLASS) so call
// sites never restate them and DESIGN.md can point at one source of truth.
const TRIGGER_CLASS = "hw-select hw-select-trigger";
const VALUE_CLASS = "hw-select-value";
const ICON_CLASS = "hw-select-icon";
const POSITIONER_CLASS = "hw-select-positioner";
const POPUP_CLASS = "hw-select-popup";
const LIST_CLASS = "hw-select-list";
const ITEM_CLASS = "hw-select-item";
const ITEM_INDICATOR_CLASS = "hw-select-item-indicator";
const ITEM_TEXT_CLASS = "hw-select-item-text";
const GROUP_LABEL_CLASS = "hw-select-group-label";

interface ItemGroup {
  name: string | undefined;
  items: SelectItem[];
}

/** Bucket items by `group`, preserving first-seen order for both groups and the
 *  ungrouped lead bucket. */
function groupItems(items: SelectItem[]): ItemGroup[] {
  const groups: ItemGroup[] = [];
  const byName = new Map<string | undefined, ItemGroup>();
  for (const item of items) {
    let bucket = byName.get(item.group);
    if (bucket === undefined) {
      bucket = { name: item.group, items: [] };
      byName.set(item.group, bucket);
      groups.push(bucket);
    }
    bucket.items.push(item);
  }
  return groups;
}

function renderItem(item: SelectItem): React.ReactElement {
  return (
    <BaseSelect.Item key={item.value} value={item.value} className={ITEM_CLASS}>
      <BaseSelect.ItemIndicator className={ITEM_INDICATOR_CLASS}>
        <CheckIcon />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className={ITEM_TEXT_CLASS}>{item.label}</BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}

export function Select({
  value,
  onValueChange,
  items,
  placeholder,
  disabled,
  "aria-label": ariaLabel,
}: SelectProps): React.ReactElement {
  const groups = groupItems(items);
  return (
    <BaseSelect.Root
      items={items}
      value={value}
      // Base UI yields `null` when the selection is cleared; our controlled API
      // uses the empty string as the "no value" sentinel (the `(default)` item).
      onValueChange={(next) => onValueChange(next ?? "")}
    >
      <BaseSelect.Trigger className={TRIGGER_CLASS} aria-label={ariaLabel} disabled={disabled}>
        <BaseSelect.Value className={VALUE_CLASS} placeholder={placeholder} />
        <BaseSelect.Icon className={ICON_CLASS}>
          <ChevronDownIcon />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className={POSITIONER_CLASS} sideOffset={4}>
          <BaseSelect.Popup className={POPUP_CLASS}>
            <BaseSelect.List className={LIST_CLASS}>
              {groups.map((bucket) =>
                bucket.name === undefined ? (
                  bucket.items.map(renderItem)
                ) : (
                  <BaseSelect.Group key={bucket.name}>
                    <BaseSelect.GroupLabel className={GROUP_LABEL_CLASS}>
                      {bucket.name}
                    </BaseSelect.GroupLabel>
                    {bucket.items.map(renderItem)}
                  </BaseSelect.Group>
                ),
              )}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
