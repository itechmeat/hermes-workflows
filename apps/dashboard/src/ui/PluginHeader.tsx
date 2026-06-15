import { createContext, useContext } from "react";
import { Button } from "./components";
import { O2BStatus } from "./O2BStatus";

// The plugin's single top bar. The host renders its own page banner above us
// (which we can't populate — the page-header API is internal), so rather than
// stack a second ad-hoc header we keep ONE plugin bar: a left slot for the
// current context (workflow / run name), a centre slot for view actions, and a
// right slot with the section nav + the Open Second Brain indicator.
//
// The left and centre are portal hosts: views (editor, run inspector) render
// their title/actions into them via `useHeaderSlots`, so there is exactly one
// bar regardless of the active view. Outside the provider (component tests),
// `useHeaderSlots` returns null and those views fall back to an inline toolbar.

export interface HeaderSlots {
  leftHost: HTMLElement | null;
  actionsHost: HTMLElement | null;
}

const HeaderSlotsContext = createContext<HeaderSlots | null>(null);
export const HeaderSlotsProvider = HeaderSlotsContext.Provider;

export function useHeaderSlots(): HeaderSlots | null {
  return useContext(HeaderSlotsContext);
}

export interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

export interface PluginHeaderProps {
  nav: NavItem[];
  activeKey: string;
  onNavigate: (key: string) => void;
  o2bConnected: boolean | null;
  o2bInstalled: boolean | null;
  /** Host reverse-proxy prefix for the indicator's link. */
  o2bBasePath: string;
  /** Callback refs for the left (title) and actions portal hosts. */
  leftRef: (el: HTMLElement | null) => void;
  actionsRef: (el: HTMLElement | null) => void;
}

export function PluginHeader({
  nav,
  activeKey,
  onNavigate,
  o2bConnected,
  o2bInstalled,
  o2bBasePath,
  leftRef,
  actionsRef,
}: PluginHeaderProps): React.ReactElement {
  return (
    <header className="hw-pluginbar">
      <span
        className="hw-pluginbar__brand"
        title={`Hermes Workflows v${__PLUGIN_VERSION__}-b${__PLUGIN_BUILD__}`}
      >
        <span className="hw-pluginbar__brand-name">Workflows</span>
        <span className="hw-pluginbar__version">
          v{__PLUGIN_VERSION__}-b{__PLUGIN_BUILD__}
        </span>
      </span>
      <div className="hw-pluginbar__left" ref={leftRef} />
      <div className="hw-pluginbar__actions" ref={actionsRef} />
      <div className="hw-pluginbar__right">
        <nav className="hw-pluginbar__nav" aria-label="Workflows sections">
          {nav.map((item) => {
            const active = item.key === activeKey;
            return (
              <Button
                key={item.key}
                size="sm"
                variant={active ? "primary" : "default"}
                aria-label={item.label}
                title={item.label}
                aria-current={active ? "page" : undefined}
                onClick={() => onNavigate(item.key)}
              >
                {item.icon}
              </Button>
            );
          })}
        </nav>
        <O2BStatus connected={o2bConnected} installed={o2bInstalled} basePath={o2bBasePath} />
      </div>
    </header>
  );
}
