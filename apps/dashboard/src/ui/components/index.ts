// Shared UI primitives for the dashboard. Import from this barrel so call sites
// depend on the component layer, not individual files.
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { Badge, type BadgeProps } from "./Badge";
export { Field, type FieldProps } from "./Field";
export { Input, type InputProps } from "./Input";
export { Textarea, type TextareaProps } from "./Textarea";
export { Checkbox, type CheckboxProps } from "./Checkbox";
export { Switch, type SwitchProps } from "./Switch";
export { Select, type SelectProps, type SelectItem } from "./Select";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { BackendUnavailable, type BackendUnavailableProps } from "./BackendUnavailable";
export { Modal, type ModalProps } from "./Modal";
export { Menu, type MenuProps, type MenuItem } from "./Menu";
export { ToastHost, useToasts, type ToastData } from "./Toast";
