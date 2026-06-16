import { Toast } from "@base-ui/react/toast";

// App-level toast host built on Base UI's Toast parts, so styling and a11y
// wiring (role, keyboard dismiss, focus management) live in one place like the
// other ui/components primitives. Wrap a subtree in <ToastHost> and call
// `useToasts().add(...)` from any descendant to surface a dismissible
// notification. The viewport renders the live toast list.

/** Custom per-toast data. `testId` lets a specific caller tag its toast for a
 *  stable test/query hook without the host knowing about that caller. */
export interface ToastData {
  testId?: string;
}

export function ToastHost({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Toast.Provider>
      {children}
      <ToastList />
    </Toast.Provider>
  );
}

function ToastList(): React.ReactElement {
  const { toasts } = Toast.useToastManager<ToastData>();
  return (
    <Toast.Viewport className="hw-toast-viewport">
      {toasts.map((toast) => (
        <Toast.Root
          key={toast.id}
          toast={toast}
          className={`hw-toast hw-toast--${toast.type ?? "info"}`}
          data-testid={toast.data?.testId}
        >
          <div className="hw-toast__body">
            {toast.title ? <Toast.Title className="hw-toast__title" /> : null}
            <Toast.Description className="hw-toast__description" />
          </div>
          <Toast.Close className="hw-toast__close" aria-label="Dismiss notification">
            ×
          </Toast.Close>
        </Toast.Root>
      ))}
    </Toast.Viewport>
  );
}

/** The toast manager for the nearest <ToastHost>. `add({ title, description,
 *  type, priority, timeout, data })` queues a toast; `timeout: 0` keeps it until
 *  dismissed (right for an error the operator must act on). */
export function useToasts(): ReturnType<typeof Toast.useToastManager<ToastData>> {
  return Toast.useToastManager<ToastData>();
}
