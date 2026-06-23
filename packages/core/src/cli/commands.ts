/**
 * CLI command handlers. Each returns a JSON-able value; the argv dispatcher in
 * cli.ts prints it. Pure commands (validate/compile-preview/explain) and the
 * persistence/advance commands are all offline — the Python orchestrator wraps
 * `advance` with Kanban I/O via the bridge.
 */

import type { Workflow } from "../schema/workflow.ts";
import type { RunState } from "../schema/run.ts";
import { parseWorkflow } from "../schema/load.ts";
import { validateWorkflow } from "../validation/validateWorkflow.ts";
import type { ValidationResult } from "../validation/validateWorkflow.ts";
import { compileToHermesPlan } from "../compiler/compileToHermesPlan.ts";
import type { HermesPlan } from "../compiler/compileToHermesPlan.ts";
import { resolveMemoryProvider } from "../memory/resolveProvider.ts";
import type { CliRunner } from "../memory/O2BCLIProvider.ts";
import type { WorkflowMemoryEventKind } from "../memory/MemoryProvider.ts";
import { buildRetrospective } from "../memory/retrospective.ts";
import { advance } from "../runtime/advance.ts";
import type { AdvanceResult } from "../runtime/advance.ts";
import { createRunState } from "../runtime/state.ts";
import { cancelRun, retryRun } from "../runtime/runMutations.ts";
import { openRunsDatabase } from "../runtime/db/connection.ts";
import { RunRepository } from "../runtime/db/runRepository.ts";
import type { RunSummary, RunMeta, LatestRun } from "../runtime/db/runRepository.ts";
import { SpecStore, chooseWriteRoot } from "../runtime/specStore.ts";
import type { SpecSummary, SpecDetail, WriteRoots } from "../runtime/specStore.ts";
import { fromObject } from "../schema/load.ts";
import { fillParams, ParamFillError } from "../templates/params.ts";
import type { ParamValue, WorkflowParam } from "../templates/params.ts";
import { specSha } from "../serialize/specSha.ts";
import {
  exportTemplate,
  generationRequest,
  templateCacheKey,
  templateRevision,
  TEMPLATE_FORMAT,
  GENERATOR_VERSION,
} from "../templates/exportTemplate.ts";
import type { GuideHints, GenerationRequest } from "../templates/exportTemplate.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface Explanation {
  id: string;
  name: string;
  trigger: string;
  nodes: { id: string; type: string; title?: string }[];
  edges: number;
}

async function loadWorkflow(specPath: string): Promise<Workflow> {
  return parseWorkflow(await Bun.file(specPath).text()).workflow;
}

function repository(dbPath: string): RunRepository {
  return new RunRepository(openRunsDatabase(dbPath));
}

export function cmdListSpecs(roots: string[]): Promise<SpecSummary[]> {
  return new SpecStore(roots).list();
}

export async function cmdValidate(specPath: string): Promise<ValidationResult> {
  return validateWorkflow(await loadWorkflow(specPath));
}

export async function cmdCompilePreview(specPath: string): Promise<HermesPlan> {
  return compileToHermesPlan(await loadWorkflow(specPath));
}

export async function cmdExplain(specPath: string): Promise<Explanation> {
  const workflow = await loadWorkflow(specPath);
  return {
    id: workflow.id,
    name: workflow.name,
    trigger: workflow.trigger.type,
    nodes: workflow.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.title !== undefined ? { title: n.title } : {}),
    })),
    edges: workflow.edges.length,
  };
}

export async function cmdAdvance(specPath: string, run: RunState): Promise<AdvanceResult> {
  return advance(await loadWorkflow(specPath), run);
}

/**
 * Write one workflow memory event through the provider the spec's
 * `defaults.memory` selects. Fail-open by default, so a `none` provider or an
 * unavailable O2B installation makes this a successful no-op. The `runner` is
 * injectable for tests; production uses the real `o2b` CLI.
 */
export async function cmdMemoryEvent(
  specPath: string,
  kind: WorkflowMemoryEventKind,
  title: string,
  body: string,
  runner?: CliRunner,
): Promise<{ ok: true }> {
  const workflow = await loadWorkflow(specPath);
  const provider = resolveMemoryProvider(workflow.defaults?.memory, runner);
  await provider.writeEvent({ kind, title, body });
  return { ok: true };
}

/** Write the run retrospective markdown through the spec-selected provider. */
export async function cmdMemoryRetro(
  specPath: string,
  markdown: string,
  title?: string,
  runner?: CliRunner,
): Promise<{ ok: true }> {
  const workflow = await loadWorkflow(specPath);
  const provider = resolveMemoryProvider(workflow.defaults?.memory, runner);
  await provider.writeRetrospective({ title: title ?? workflow.name, markdown });
  return { ok: true };
}

/**
 * Build the §22.6 retrospective from a run and write it through the
 * spec-selected provider. The engine calls this (via the CLI) so the markdown
 * builder stays in the core, not duplicated in the Python orchestrator.
 */
export async function cmdMemoryRetroFromRun(
  specPath: string,
  run: RunState,
  title?: string,
  runner?: CliRunner,
): Promise<{ ok: true }> {
  const workflow = await loadWorkflow(specPath);
  const provider = resolveMemoryProvider(workflow.defaults?.memory, runner);
  const built = buildRetrospective(workflow, run);
  await provider.writeRetrospective({ title: title ?? built.title, markdown: built.markdown });
  return { ok: true };
}

/** Wall-clock in epoch seconds (the unit Hermes uses for timestamps). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const TERMINAL_STATUSES: ReadonlySet<RunState["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Timing meta for a save: stamp `started_at` at creation, `finished_at` once a
 *  run is terminal, and clear `finished_at` while it is still in flight (so a
 *  retried run is no longer marked finished). `started_at` is preserved across
 *  meta-less saves by {@link RunRepository.saveRun}. */
function timingMeta(run: RunState, atCreate: boolean): RunMeta {
  const meta: RunMeta = {};
  if (atCreate) meta.started_at = nowSeconds();
  if (TERMINAL_STATUSES.has(run.status)) meta.finished_at = nowSeconds();
  return meta;
}

/**
 * Validate the supplied raw param values (a JSON object, as sent by every
 * instantiation surface) against the workflow's declared params and return the
 * resolved value map. `fillParams` rejects unknown names, enforces required
 * params, and coerces enum/int/bool. Returns undefined when no params were
 * supplied. Throws (failing the run-create loudly) on invalid JSON or values.
 */
function resolveRunParams(
  declared: WorkflowParam[] | undefined,
  paramsJson: string | undefined,
): Record<string, ParamValue> | undefined {
  const declaredParams = declared ?? [];
  // No --params: a non-template workflow is untouched, but a template still
  // validates against an empty value set so a missing REQUIRED param fails at
  // run-create (and declared defaults are applied) rather than leaking through
  // as an unresolved {{params.X}} at schedule time.
  if (paramsJson === undefined || paramsJson.trim() === "") {
    if (declaredParams.length === 0) return undefined;
    return fillParams(declaredParams, {});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(paramsJson);
  } catch (error) {
    throw new ParamFillError(`--params is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ParamFillError("--params must be a JSON object of name=value pairs");
  }
  return fillParams(declaredParams, raw as Record<string, ParamValue>);
}

export async function cmdRunCreate(
  dbPath: string,
  specPath: string,
  runId: string,
  projectId?: string,
  origin?: string,
  input?: string,
  paramsJson?: string,
): Promise<RunState> {
  const workflow = await loadWorkflow(specPath);
  const params = resolveRunParams(workflow.params, paramsJson);
  const run = createRunState(workflow, runId, projectId, origin, input, params, specPath);
  // Single-flight: throws ActiveRunExistsError when the workflow already has
  // an active run (the bridge maps the error name to HTTP 409).
  repository(dbPath).createRun(run, timingMeta(run, true));
  return run;
}

export function cmdRunLoad(dbPath: string, runId: string): RunState | null {
  return repository(dbPath).loadRun(runId);
}

export function cmdRunSave(dbPath: string, run: RunState): void {
  repository(dbPath).saveRun(run, timingMeta(run, false));
}

export function cmdRunList(dbPath: string, activeOnly: boolean): RunState[] {
  const repo = repository(dbPath);
  return activeOnly ? repo.listActiveRuns() : repo.listAllRuns();
}

/** Flat run summaries for the dashboard Runs page (see {@link RunSummary}).
 * `workflowId` narrows to one workflow's runs — the editor-attach lookup. */
export function cmdRunListSummary(
  dbPath: string,
  activeOnly: boolean,
  workflowId?: string,
): RunSummary[] {
  return repository(dbPath).listRunSummaries(activeOnly, workflowId);
}

/** Map each workflow id to its most recent run (for the Templates page). */
export function cmdRunLatest(dbPath: string): Record<string, LatestRun> {
  return repository(dbPath).latestRunByWorkflow();
}

/** Load one spec (graph + ui + path) for the editor. */
export function cmdSpecGet(roots: string[], id: string): Promise<SpecDetail | null> {
  return new SpecStore(roots).getById(id);
}

/**
 * Validate and persist a spec the editor edited. `spec` is a full workflow
 * object (workflow fields plus an optional `ui` block), parsed and validated
 * here; an invalid graph rejects and writes nothing.
 */
export async function cmdSpecSave(
  roots: string[],
  spec: unknown,
  writeRoots: WriteRoots,
): Promise<SpecDetail> {
  const { workflow, ui } = fromObject(spec);
  const store = new SpecStore(roots);
  const path = await store.saveWorkflow(workflow, ui, chooseWriteRoot(workflow.scope, writeRoots));
  return ui === undefined ? { workflow, path } : { workflow, ui, path };
}

/** Like {@link cmdSpecSave} but refuses to overwrite an existing id. */
export async function cmdSpecCreate(
  roots: string[],
  spec: unknown,
  writeRoots: WriteRoots,
): Promise<SpecDetail> {
  const { workflow, ui } = fromObject(spec);
  const store = new SpecStore(roots);
  const path = await store.createWorkflow(
    workflow,
    ui,
    chooseWriteRoot(workflow.scope, writeRoots),
  );
  return ui === undefined ? { workflow, path } : { workflow, ui, path };
}

export async function cmdSpecDelete(roots: string[], id: string): Promise<{ deleted: boolean }> {
  return { deleted: await new SpecStore(roots).deleteSpec(id) };
}

/** Sidecar persisted next to the two template artifacts: the composite cache
 * key (regenerate iff it changes) plus the version block for quick inspection. */
interface TemplateCacheMeta {
  cache_key: string;
  revision: string;
  human_version: string;
  spec_sha: string;
  template_format: number;
  generator_version: number;
}

export interface TemplateExportResult {
  id: string;
  /** True when the on-disk bundle already matched the composite cache key, so
   * nothing was regenerated (and the orchestrator must skip the AI call). */
  cached: boolean;
  revision: string;
  human_version: string;
  spec_sha: string;
  cache_key: string;
  files: { yaml: string; md: string; meta: string };
  /** Only on a `probe` of a stale/absent bundle: the node-purpose description
   * the AI hint generator consumes. Absent when cached. */
  generation_request?: GenerationRequest;
}

export interface ExportTemplateCmdOptions {
  outDir: string;
  generatedAt: string;
  /** Report cache status (+ a generation_request on a miss) without writing. */
  probe?: boolean;
  /** Path to a JSON {@link GuideHints} produced by the AI generator. */
  hintsFile?: string;
  model?: string | null;
  generatorVersion?: number;
}

/**
 * Export a workflow "as a template": write `<id>.template.yaml` +
 * `<id>.template.md` to `outDir`, with a sidecar `<id>.template.meta.json`
 * carrying the composite cache key. The composite is
 * `(workflow_id, spec_sha, template_format, generator_version)`; a repeat export
 * whose composite matches the sidecar is served from cache (no rewrite, and the
 * orchestrator skips the AI call). A `probe` reports cache status only — and, on
 * a miss, the {@link GenerationRequest} the AI hint generator needs — without
 * touching disk. The deterministic de-binding runs with no model; AI hints
 * arrive via `hintsFile` and are optional (fail-open).
 */
export async function cmdExportTemplate(
  roots: string[],
  id: string,
  opts: ExportTemplateCmdOptions,
): Promise<TemplateExportResult> {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`workflow id '${id}' must match ${String(SAFE_ID_PATTERN)}`);
  }
  const detail = await new SpecStore(roots).getById(id);
  if (!detail) throw new NotFoundError(`workflow '${id}' not found`);
  const workflow = detail.workflow;

  const generatorVersion = opts.generatorVersion ?? GENERATOR_VERSION;
  const model = opts.model ?? null;
  const sha = specSha(workflow);
  const cacheKey = templateCacheKey(workflow.id, sha, TEMPLATE_FORMAT, generatorVersion, model);
  const revision = templateRevision(cacheKey);
  const humanVersion = `fmt${TEMPLATE_FORMAT}·wf${workflow.version}·r${revision.slice(0, 4)}`;

  const yamlPath = join(opts.outDir, `${id}.template.yaml`);
  const mdPath = join(opts.outDir, `${id}.template.md`);
  const metaPath = join(opts.outDir, `${id}.template.meta.json`);

  const cached = await cacheHit(metaPath, yamlPath, mdPath, cacheKey);

  const base: TemplateExportResult = {
    id,
    cached,
    revision,
    human_version: humanVersion,
    spec_sha: sha,
    cache_key: cacheKey,
    files: { yaml: yamlPath, md: mdPath, meta: metaPath },
  };

  if (opts.probe) {
    return cached ? base : { ...base, generation_request: generationRequest(workflow) };
  }
  if (cached) return base;

  let hints: GuideHints | undefined;
  if (opts.hintsFile !== undefined) {
    hints = JSON.parse(await Bun.file(opts.hintsFile).text()) as GuideHints;
  }

  const bundle = exportTemplate(workflow, {
    generatedAt: opts.generatedAt,
    model,
    ...(hints !== undefined ? { hints } : {}),
    generatorVersion,
  });

  await mkdir(opts.outDir, { recursive: true });
  const meta: TemplateCacheMeta = {
    cache_key: cacheKey,
    revision,
    human_version: humanVersion,
    spec_sha: sha,
    template_format: TEMPLATE_FORMAT,
    generator_version: generatorVersion,
  };
  await Promise.all([
    Bun.write(yamlPath, bundle.templateYaml),
    Bun.write(mdPath, bundle.guideMarkdown),
  ]);
  await Bun.write(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return base;
}

async function cacheHit(
  metaPath: string,
  yamlPath: string,
  mdPath: string,
  cacheKey: string,
): Promise<boolean> {
  try {
    const meta = JSON.parse(await Bun.file(metaPath).text()) as TemplateCacheMeta;
    if (meta.cache_key !== cacheKey) return false;
    return (await Bun.file(yamlPath).exists()) && (await Bun.file(mdPath).exists());
  } catch {
    return false; // no sidecar / unreadable → regenerate
  }
}

/** Thrown when a run (or other addressable resource) does not exist. Its name
 * lets the Python bridge map it to a 404. */
export class NotFoundError extends Error {
  override name = "NotFoundError";
}

function loadRunOrThrow(repo: RunRepository, runId: string): RunState {
  const run = repo.loadRun(runId);
  if (!run) throw new NotFoundError(`run '${runId}' not found`);
  return run;
}

export function cmdRunCancel(dbPath: string, runId: string): RunState {
  const repo = repository(dbPath);
  const cancelled = cancelRun(loadRunOrThrow(repo, runId));
  repo.saveRun(cancelled, timingMeta(cancelled, false)); // terminal → stamps finished_at
  return cancelled;
}

export function cmdRunRetry(dbPath: string, runId: string, node?: string): RunState {
  const repo = repository(dbPath);
  const retried = retryRun(loadRunOrThrow(repo, runId), node !== undefined ? { node } : {});
  // Retry revives the run — the same single-flight guard as create, excluding
  // the run itself; back in flight → timingMeta clears finished_at.
  repo.reviveRun(retried, timingMeta(retried, false));
  return retried;
}
