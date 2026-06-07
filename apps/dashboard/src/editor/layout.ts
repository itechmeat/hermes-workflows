/**
 * Dependency-free auto-layout for the workflow graph.
 *
 * A longest-path layered layout: each node's rank is its longest forward
 * distance from an entry node, so edges flow left-to-right. Router loop-edges
 * (edges back to an already-seen node) are treated as back-edges and do not
 * affect ranking, which keeps cyclic graphs finite. Fully disconnected nodes
 * (no edges at all) trail the connected ranks. Within a rank, nodes keep their
 * input order so the result is stable.
 *
 * Pure and React-free: returns a map of node id to `{x, y}`. The caller writes
 * the positions into the xyflow nodes and the persisted `ui.xyflow` block.
 */

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface Point {
  x: number;
  y: number;
}

/** Horizontal gap between ranks and vertical gap between rows within a rank. */
const RANK_GAP = 220;
const ROW_GAP = 110;

export function layout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Record<string, Point> {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const order = new Map(ids.map((id, i) => [id, i] as const));

  // Adjacency over edges that connect two known nodes.
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    out.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  const connected = new Set<string>();
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    connected.add(e.source);
    connected.add(e.target);
  }

  // Entry nodes: connected nodes with no incoming edge. If a graph is a pure
  // cycle (every connected node has an in-edge), seed from the first connected
  // node in input order so ranking still has a starting point.
  const entries = ids.filter((id) => connected.has(id) && (indeg.get(id) ?? 0) === 0);
  if (entries.length === 0) {
    const firstConnected = ids.find((id) => connected.has(id));
    if (firstConnected !== undefined) entries.push(firstConnected);
  }

  // Longest-path rank via DFS, skipping edges that point at a node already on
  // the current path (back-edges) so cycles do not recurse forever.
  const rank = new Map<string, number>();
  const onPath = new Set<string>();
  const visit = (id: string, depth: number): void => {
    rank.set(id, Math.max(rank.get(id) ?? 0, depth));
    onPath.add(id);
    for (const next of out.get(id) ?? []) {
      if (onPath.has(next)) continue; // back-edge: ignore for ranking
      visit(next, (rank.get(id) ?? 0) + 1);
    }
    onPath.delete(id);
  };
  for (const entry of entries) visit(entry, 0);

  const maxConnectedRank = rank.size > 0 ? Math.max(...rank.values()) : -1;

  // Disconnected nodes (no edges at all) trail the connected ranks.
  const trailingRank = maxConnectedRank + 1;
  for (const id of ids) {
    if (!connected.has(id)) rank.set(id, trailingRank);
  }

  // Group by rank, ordered within a rank by input order, then assign points.
  const byRank = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(id);
  }
  const positions: Record<string, Point> = {};
  for (const [r, rankIds] of byRank) {
    rankIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    rankIds.forEach((id, row) => {
      positions[id] = { x: r * RANK_GAP, y: row * ROW_GAP };
    });
  }
  return positions;
}
