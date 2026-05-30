// Build-time shim aliased to `react`. Re-exports the host dashboard's single
// React 19 instance from `window.__HERMES_PLUGIN_SDK__.React`, so the bundle
// ships no second copy of React and all hooks/context share one instance.
//
// The bundled `react-dom` (for @xyflow/react's `createPortal`) also resolves its
// `react` import here, binding it to the same host React — including the internal
// dispatcher symbol it reads off the React object.

interface HostSdk {
  React: typeof import("react");
}

const sdk = (globalThis as unknown as { window?: { __HERMES_PLUGIN_SDK__?: HostSdk } }).window
  ?.__HERMES_PLUGIN_SDK__;

if (!sdk?.React) {
  throw new Error(
    "Hermes Workflows: window.__HERMES_PLUGIN_SDK__.React is unavailable; the dashboard host must load this plugin.",
  );
}

const React = sdk.React;

export default React;

export const {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React;

// react-dom reads the client dispatcher off the React object by name; re-export
// whichever internal key this React build exposes so the bundled react-dom binds.
const internals = React as unknown as Record<string, unknown>;
export const __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE =
  internals["__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"];
export const __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED =
  internals["__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED"];
