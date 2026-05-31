/**
 * Decorator that redacts every write payload before delegating. Redaction is a
 * security invariant, so it is applied unconditionally — independent of whether
 * the provider is also wrapped fail-open. (FailOpenMemoryProvider also redacts
 * as defense in depth; redacting already-redacted text is a no-op.)
 */

import type {
  WorkflowMemoryProvider,
  WorkflowContext,
  WorkflowContextRequest,
  WorkflowMemoryEvent,
  WorkflowRetrospective,
} from "./MemoryProvider.ts";
import { redactSecrets } from "./redact.ts";

export class RedactingMemoryProvider implements WorkflowMemoryProvider {
  constructor(private readonly inner: WorkflowMemoryProvider) {}

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  readContext(request: WorkflowContextRequest): Promise<WorkflowContext> {
    return this.inner.readContext(request);
  }

  writeEvent(event: WorkflowMemoryEvent): Promise<void> {
    return this.inner.writeEvent({
      kind: event.kind,
      title: redactSecrets(event.title),
      body: redactSecrets(event.body),
    });
  }

  writeRetrospective(retrospective: WorkflowRetrospective): Promise<void> {
    return this.inner.writeRetrospective({
      title: redactSecrets(retrospective.title),
      markdown: redactSecrets(retrospective.markdown),
    });
  }
}
