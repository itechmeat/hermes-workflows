/**
 * Filesystem artifact store for run/node inputs, outputs, and logs. Layout:
 *
 *   <runsDir>/<runId>/{input,output}.json
 *   <runsDir>/<runId>/nodes/<nodeId>/{input,output}.json, logs.txt, artifacts/
 *
 * Reads return null when the artifact does not exist.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export class ArtifactStore {
  constructor(private readonly runsDir: string) {}

  runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  nodeDir(runId: string, nodeId: string): string {
    return join(this.runDir(runId), "nodes", nodeId);
  }

  async writeRunFile(runId: string, name: string, content: string): Promise<string> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await Bun.write(path, content);
    return path;
  }

  async readRunFile(runId: string, name: string): Promise<string | null> {
    return this.readIfExists(join(this.runDir(runId), name));
  }

  async writeNodeFile(
    runId: string,
    nodeId: string,
    name: string,
    content: string,
  ): Promise<string> {
    const dir = this.nodeDir(runId, nodeId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await Bun.write(path, content);
    return path;
  }

  async readNodeFile(runId: string, nodeId: string, name: string): Promise<string | null> {
    return this.readIfExists(join(this.nodeDir(runId, nodeId), name));
  }

  private async readIfExists(path: string): Promise<string | null> {
    const file = Bun.file(path);
    return (await file.exists()) ? file.text() : null;
  }
}
