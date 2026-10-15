import type { Mindmap, MindmapNode } from "@talorys/shared";
import { type Database, likePattern, newId, now } from "../database";
import { NotFoundError, ValidationError } from "../../api/errors";
import { stripUndefined } from "./tasks";

export class MindmapRepository {
  constructor(private readonly db: Database) {}

  list(): Mindmap[] {
    return this.db.all<Mindmap>(
      `SELECT m.*, COUNT(n.id) AS node_count FROM tal_mindmaps m
       LEFT JOIN tal_mindmap_nodes n ON n.mindmap_id = m.id
       GROUP BY m.id ORDER BY m.updated_at DESC`,
    );
  }

  get(id: string): Mindmap | null {
    return this.db.one<Mindmap>(`SELECT * FROM tal_mindmaps WHERE id = ?`, id);
  }

  require(id: string): Mindmap {
    const m = this.get(id);
    if (!m) throw new NotFoundError("Mind map not found");
    return m;
  }

  /** Looks up a mind map by id or, failing that, by exact (case-insensitive) title. */
  resolve(ref: string): Mindmap | null {
    return this.get(ref) ?? this.db.one<Mindmap>(`SELECT * FROM tal_mindmaps WHERE lower(title) = lower(?)`, ref.trim()) ?? null;
  }

  /** Looks up a node by id or, failing that, by its text (exact match first, then a substring match). */
  resolveNode(mindmapId: string, ref: string): MindmapNode | null {
    const byId = this.getNode(mindmapId, ref);
    if (byId) return byId;
    const trimmed = ref.trim();
    return (
      this.db.one<MindmapNode>(`SELECT * FROM tal_mindmap_nodes WHERE mindmap_id = ? AND lower(text) = lower(?)`, mindmapId, trimmed) ??
      this.db.one<MindmapNode>(`SELECT * FROM tal_mindmap_nodes WHERE mindmap_id = ? AND text LIKE ? ESCAPE '\\' LIMIT 1`, mindmapId, likePattern(trimmed)) ??
      null
    );
  }

  nodes(mindmapId: string): MindmapNode[] {
    this.require(mindmapId);
    return this.db.all<MindmapNode>(`SELECT * FROM tal_mindmap_nodes WHERE mindmap_id = ? ORDER BY order_index`, mindmapId);
  }

  getNode(mindmapId: string, nodeId: string): MindmapNode | null {
    return this.db.one<MindmapNode>(`SELECT * FROM tal_mindmap_nodes WHERE id = ? AND mindmap_id = ?`, nodeId, mindmapId);
  }

  requireNode(mindmapId: string, nodeId: string): MindmapNode {
    const n = this.getNode(mindmapId, nodeId);
    if (!n) throw new NotFoundError("Node not found");
    return n;
  }

  /** Creates a mind map with a single central (root) node, so the canvas is never empty. */
  create(input: { title: string }): { mindmap: Mindmap; root: MindmapNode } {
    const ts = now();
    const title = input.title.trim();
    const mindmap: Mindmap = { id: newId(), title, created_at: ts, updated_at: ts };
    const root: MindmapNode = { id: newId(), mindmap_id: mindmap.id, parent_id: null, text: title, x: 0, y: 0, order_index: 0, created_at: ts, updated_at: ts };
    this.db.transaction(() => {
      this.db.run(`INSERT INTO tal_mindmaps (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`, mindmap.id, mindmap.title, mindmap.created_at, mindmap.updated_at);
      this.db.run(
        `INSERT INTO tal_mindmap_nodes (id, mindmap_id, parent_id, text, x, y, order_index, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        root.id, root.mindmap_id, root.text, root.x, root.y, root.order_index, root.created_at, root.updated_at,
      );
    });
    return { mindmap, root };
  }

  /** Mind maps whose title or any node text matches, newest first. */
  search(q: string, limit = 10): Mindmap[] {
    return this.db.all<Mindmap>(
      `SELECT DISTINCT m.* FROM tal_mindmaps m LEFT JOIN tal_mindmap_nodes n ON n.mindmap_id = m.id
       WHERE m.title LIKE ? ESCAPE '\\' OR n.text LIKE ? ESCAPE '\\' ORDER BY m.updated_at DESC LIMIT ?`,
      likePattern(q), likePattern(q), limit,
    );
  }

  rename(id: string, title: string): Mindmap {
    const existing = this.require(id);
    const next = { ...existing, title: title.trim(), updated_at: now() };
    this.db.run(`UPDATE tal_mindmaps SET title = ?, updated_at = ? WHERE id = ?`, next.title, next.updated_at, id);
    return next;
  }

  delete(id: string): void {
    this.require(id);
    this.db.transaction(() => {
      this.db.run(`DELETE FROM tal_mindmap_nodes WHERE mindmap_id = ?`, id);
      this.db.run(`DELETE FROM tal_mindmaps WHERE id = ?`, id);
    });
  }

  /** True if setting `nodeId`'s parent to `parentId` would create a cycle. */
  wouldCycle(nodeId: string, parentId: string): boolean {
    return this.isSelfOrDescendant(nodeId, parentId);
  }

  /** True if `nodeId` is `ancestorId` itself or lies anywhere under it. */
  private isSelfOrDescendant(ancestorId: string, nodeId: string): boolean {
    let current: string | null = nodeId;
    const seen = new Set<string>();
    while (current) {
      if (current === ancestorId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = this.db.one<{ parent_id: string | null }>(`SELECT parent_id FROM tal_mindmap_nodes WHERE id = ?`, current)?.parent_id ?? null;
    }
    return false;
  }

  /** Adds a child node. Every node but the central one needs a parent within the same mind map. */
  createNode(mindmapId: string, input: { parent_id: string; text: string; x?: number; y?: number }): MindmapNode {
    this.require(mindmapId);
    const parent = this.getNode(mindmapId, input.parent_id);
    if (!parent) throw new ValidationError("Parent node does not exist in this mind map.");
    const siblingCount = this.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_mindmap_nodes WHERE parent_id = ?`, input.parent_id)?.n ?? 0;
    const ts = now();
    const node: MindmapNode = {
      id: newId(),
      mindmap_id: mindmapId,
      parent_id: input.parent_id,
      text: input.text.trim(),
      x: input.x ?? parent.x + 220,
      y: input.y ?? parent.y + siblingCount * 72,
      order_index: siblingCount,
      created_at: ts,
      updated_at: ts,
    };
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO tal_mindmap_nodes (id, mindmap_id, parent_id, text, x, y, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        node.id, node.mindmap_id, node.parent_id, node.text, node.x, node.y, node.order_index, node.created_at, node.updated_at,
      );
      this.db.run(`UPDATE tal_mindmaps SET updated_at = ? WHERE id = ?`, ts, mindmapId);
    });
    return node;
  }

  updateNode(mindmapId: string, nodeId: string, patch: { text?: string; x?: number; y?: number; parent_id?: string }): MindmapNode {
    const existing = this.requireNode(mindmapId, nodeId);
    if (patch.parent_id !== undefined) {
      if (existing.parent_id === null) throw new ValidationError("The central node cannot be moved under another node.");
      if (patch.parent_id === nodeId || this.isSelfOrDescendant(nodeId, patch.parent_id)) {
        throw new ValidationError("A node cannot become its own descendant.");
      }
      if (!this.getNode(mindmapId, patch.parent_id)) throw new ValidationError("Parent node does not exist in this mind map.");
    }
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    this.db.transaction(() => {
      this.db.run(
        `UPDATE tal_mindmap_nodes SET text = ?, x = ?, y = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
        next.text, next.x, next.y, next.parent_id, next.updated_at, nodeId,
      );
      // The central node's text doubles as the mind map's display title.
      if (existing.parent_id === null && patch.text !== undefined) {
        this.db.run(`UPDATE tal_mindmaps SET title = ?, updated_at = ? WHERE id = ?`, next.text, next.updated_at, mindmapId);
      } else {
        this.db.run(`UPDATE tal_mindmaps SET updated_at = ? WHERE id = ?`, next.updated_at, mindmapId);
      }
    });
    return next;
  }

  deleteNode(mindmapId: string, nodeId: string): void {
    const node = this.requireNode(mindmapId, nodeId);
    if (node.parent_id === null) throw new ValidationError("Delete the mind map instead of its central node.");
    this.db.transaction(() => {
      this.db.run(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM tal_mindmap_nodes WHERE id = ?
           UNION ALL
           SELECT n.id FROM tal_mindmap_nodes n JOIN sub ON n.parent_id = sub.id
         )
         DELETE FROM tal_mindmap_nodes WHERE id IN (SELECT id FROM sub)`,
        nodeId,
      );
      this.db.run(`UPDATE tal_mindmaps SET updated_at = ? WHERE id = ?`, now(), mindmapId);
    });
  }
}
