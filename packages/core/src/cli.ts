#!/usr/bin/env bun
/**
 * Hermes Workflows core CLI: a thin JSON-in/JSON-out surface over the engine.
 * Invoked by the Python orchestrator (via cli_bridge) for pure decisions and
 * run-state persistence. Prints one JSON document to stdout; errors go to
 * stderr with a non-zero exit.
 */

import type { RunState } from "./schema/run.ts";
import {
  cmdValidate,
  cmdCompilePreview,
  cmdExplain,
  cmdAdvance,
  cmdMemoryEvent,
  cmdMemoryRetro,
  cmdMemoryRetroFromRun,
  cmdRunCreate,
  cmdRunLoad,
  cmdRunSave,
  cmdRunList,
  cmdRunListSummary,
  cmdRunLatest,
  cmdListSpecs,
  cmdSpecGet,
  cmdSpecSave,
  cmdSpecCreate,
  cmdSpecDelete,
  cmdRunCancel,
  cmdRunRetry,
  cmdExportTemplate,
} from "./cli/commands.ts";
import type { WriteRoots } from "./runtime/specStore.ts";

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

// Flags that always consume the following token as their value, even when that
// value itself begins with `--` (e.g. operator `--input "--urgent ..."`). Without
// this, a value starting with `--` is mistaken for the next flag and dropped.
const VALUE_FLAGS = new Set([
  "body",
  "db",
  "generated-at",
  "generator-version",
  "global-root",
  "hints-file",
  "id",
  "input",
  "kind",
  "markdown-file",
  "model",
  "node",
  "origin",
  "out-dir",
  "params",
  "project",
  "project-root",
  "roots",
  "run-file",
  "spec-file",
  "templates-root",
  "title",
  "workflow",
]);

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && !VALUE_FLAGS.has(key))) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      flags._.push(token);
    }
  }
  return flags;
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

async function readRunFile(path: string): Promise<RunState> {
  return JSON.parse(await Bun.file(path).text()) as RunState;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

function rootsOf(flags: Flags): string[] {
  return (str(flags, "roots") ?? "").split(",").filter((r) => r.length > 0);
}

function writeRootsOf(flags: Flags): WriteRoots {
  const global = required(str(flags, "global-root"), "--global-root");
  const roots: WriteRoots = { global };
  const templates = str(flags, "templates-root");
  if (templates !== undefined) roots.templates = templates;
  const project = str(flags, "project-root");
  if (project !== undefined) roots.project = project;
  return roots;
}

async function dispatch(command: string | undefined, flags: Flags): Promise<unknown> {
  const spec = flags._[0];
  const db = str(flags, "db"); // optional here; commands that need it pass it through required()

  switch (command) {
    case "list-specs": {
      const roots = (str(flags, "roots") ?? "").split(",").filter((r) => r.length > 0);
      return cmdListSpecs(roots);
    }
    case "validate":
      return cmdValidate(requireSpec(spec));
    case "compile-preview":
      return cmdCompilePreview(requireSpec(spec));
    case "explain":
      return cmdExplain(requireSpec(spec));
    case "advance":
      return cmdAdvance(
        requireSpec(spec),
        await readRunFile(required(str(flags, "run-file"), "--run-file")),
      );
    case "memory-event":
      return cmdMemoryEvent(
        requireSpec(spec),
        required(str(flags, "kind"), "--kind") as never,
        str(flags, "title") ?? "",
        str(flags, "body") ?? "",
      );
    case "memory-retro": {
      // Build the markdown from a run file (the engine's path, keeping the
      // builder in one place) or take pre-built markdown from --markdown-file.
      const runFile = str(flags, "run-file");
      if (runFile !== undefined) {
        return cmdMemoryRetroFromRun(
          requireSpec(spec),
          await readRunFile(runFile),
          str(flags, "title"),
        );
      }
      return cmdMemoryRetro(
        requireSpec(spec),
        await Bun.file(required(str(flags, "markdown-file"), "--markdown-file")).text(),
        str(flags, "title"),
      );
    }
    case "run-create":
      return cmdRunCreate(
        required(db, "--db"),
        requireSpec(spec),
        required(str(flags, "id"), "--id"),
        str(flags, "project"),
        str(flags, "origin"),
        str(flags, "input"),
        str(flags, "params"),
      );
    case "run-load":
      return cmdRunLoad(required(db, "--db"), required(str(flags, "id"), "--id"));
    case "run-save":
      cmdRunSave(
        required(db, "--db"),
        await readRunFile(required(str(flags, "run-file"), "--run-file")),
      );
      return { ok: true };
    case "run-list":
      return cmdRunList(required(db, "--db"), flags["active"] === true);
    case "run-list-summary":
      return cmdRunListSummary(
        required(db, "--db"),
        flags["active"] === true,
        str(flags, "workflow"),
      );
    case "run-latest":
      return cmdRunLatest(required(db, "--db"));
    case "spec-get":
      return cmdSpecGet(rootsOf(flags), required(str(flags, "id"), "--id"));
    case "spec-save":
      return cmdSpecSave(
        rootsOf(flags),
        await readJsonFile(required(str(flags, "spec-file"), "--spec-file")),
        writeRootsOf(flags),
      );
    case "spec-create":
      return cmdSpecCreate(
        rootsOf(flags),
        await readJsonFile(required(str(flags, "spec-file"), "--spec-file")),
        writeRootsOf(flags),
      );
    case "spec-delete":
      return cmdSpecDelete(rootsOf(flags), required(str(flags, "id"), "--id"));
    case "run-cancel":
      return cmdRunCancel(required(db, "--db"), required(str(flags, "id"), "--id"));
    case "run-retry":
      return cmdRunRetry(
        required(db, "--db"),
        required(str(flags, "id"), "--id"),
        str(flags, "node"),
      );
    case "export-template": {
      const gv = str(flags, "generator-version");
      const generatorVersion = gv === undefined ? undefined : Number(gv);
      if (
        generatorVersion !== undefined &&
        (!Number.isInteger(generatorVersion) || generatorVersion <= 0)
      ) {
        throw new Error("--generator-version must be a positive integer");
      }
      return cmdExportTemplate(rootsOf(flags), required(str(flags, "id"), "--id"), {
        outDir: required(str(flags, "out-dir"), "--out-dir"),
        generatedAt: required(str(flags, "generated-at"), "--generated-at"),
        probe: flags["probe"] === true,
        ...(str(flags, "hints-file") !== undefined ? { hintsFile: str(flags, "hints-file") } : {}),
        ...(str(flags, "model") !== undefined ? { model: str(flags, "model") } : {}),
        ...(generatorVersion !== undefined ? { generatorVersion } : {}),
      });
    }
    default:
      throw new Error(`unknown command: ${command ?? "(none)"}`);
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing required argument ${name}`);
  return value;
}

function requireSpec(spec: string | undefined): string {
  return required(spec, "<spec path>");
}

async function main(): Promise<number> {
  const [command, ...rest] = Bun.argv.slice(2);
  try {
    const result = await dispatch(command, parseFlags(rest));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    // Structured so the Python bridge can map the error kind to an HTTP status
    // (e.g. NotFoundError -> 404, SpecValidationError -> 400). The message stays
    // human-readable for non-parsing callers. When the error carries structured
    // sub-errors (a SpecValidationError's code+message list), pass them through
    // as `details` so a surfacing UI can render each one.
    const e = err as Error & { errors?: { code?: string; message?: string }[] };
    const details = Array.isArray(e.errors)
      ? e.errors.map((d) => ({ code: d.code, message: d.message }))
      : undefined;
    process.stderr.write(
      `${JSON.stringify({ error: { name: e.name, message: e.message, ...(details ? { details } : {}) } })}\n`,
    );
    return 1;
  }
}

process.exit(await main());
