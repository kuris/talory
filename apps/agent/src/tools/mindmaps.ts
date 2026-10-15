import { z } from "zod";
import { defineTool, quoteTitle, ToolError } from "./registry";

const MAX_NODES_PER_CALL = 60;

// A flat list instead of a nested tree: Cloudflare Workers AI's function-calling backend can't
// handle a self-referential ($ref) JSON schema, so a recursive "children" field silently stops
// the model from ever calling this tool. Each entry names itself and, optionally, its parent by
// a short id the model invents for this call only; the tree is reassembled server-side.
const flatNodeSchema = z.object({
  id: z.string().min(1).max(40).describe("A short local id for this node, invented for this call (e.g. \"b1\"). Not stored."),
  text: z.string().min(1).max(300),
  parent: z.string().max(40).optional().describe("The `id` of this node's parent from this same list. Omit to attach it to the central node."),
});

/** Renders a node and its children as an indented outline for the model to read back. */
function renderOutline(text: string, children: { text: string; children: unknown[] }[] | undefined, depth = 0): string {
  const line = `${"  ".repeat(depth)}- ${text}`;
  const rest = (children ?? []).map((c) => renderOutline(c.text, c.children as never, depth + 1)).join("\n");
  return rest ? `${line}\n${rest}` : line;
}

export const mindmapTools = [
  defineTool({
    name: "create_mindmap",
    description:
      "Create a new mind map with a central topic and a flat list of branch nodes, each optionally pointing at another node in the same list as its parent (omit `parent` to attach directly to the central node). Use this to help the owner brainstorm or structure ideas visually.",
    permission: "write",
    maxCallsPerTurn: 2,
    input: z.object({
      title: z.string().min(1).max(200),
      nodes: z.array(flatNodeSchema).max(MAX_NODES_PER_CALL).optional(),
    }),
    label: (i) => `Creating mind map “${i.title}”`,
    execute: (i, ctx) => {
      const { mindmap, root } = ctx.services.mindmaps.create({ title: i.title });
      const idMap = new Map<string, string>(); // the model's local id -> the real node id
      let pending = (i.nodes ?? []).slice(0, MAX_NODES_PER_CALL);
      let created = 1;
      let progressed = true;
      while (pending.length > 0 && progressed) {
        progressed = false;
        const stillPending: typeof pending = [];
        for (const n of pending) {
          const parentId = n.parent ? idMap.get(n.parent) : root.id;
          if (parentId === undefined) {
            stillPending.push(n);
            continue;
          }
          const node = ctx.services.mindmaps.createNode(mindmap.id, { parent_id: parentId, text: n.text });
          idMap.set(n.id, node.id);
          created++;
          progressed = true;
        }
        pending = stillPending;
      }
      ctx.services.activity.record("mindmap.created", `Agent created mind map “${mindmap.title}” (${created} nodes)`);
      return { created: { id: mindmap.id, title: mindmap.title, node_count: created, ...(pending.length ? { skipped_unresolved_parent: pending.length } : {}) } };
    },
  }),
  defineTool({
    name: "list_mindmaps",
    description: "List the owner's mind maps.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({}),
    label: () => `Checking mind maps`,
    execute: (_i, ctx) => ({
      mindmaps: ctx.services.mindmaps.list().map((m) => ({ id: m.id, title: m.title, updated_at: m.updated_at })),
    }),
  }),
  defineTool({
    name: "read_mindmap",
    description: "Read a mind map's full structure as an indented outline, by id or title.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ mindmap: z.string().min(1).max(200) }),
    label: () => `Reading a mind map`,
    execute: (i, ctx) => {
      const m = ctx.services.mindmaps.resolve(i.mindmap);
      if (!m) throw new ToolError(`Mind map "${i.mindmap}" not found.`);
      const nodes = ctx.services.mindmaps.nodes(m.id);
      const byParent = new Map<string | null, { id: string; text: string; children: unknown[] }[]>();
      for (const n of nodes) {
        const entry = { id: n.id, text: n.text, children: [] as unknown[] };
        if (!byParent.has(n.parent_id)) byParent.set(n.parent_id, []);
        byParent.get(n.parent_id)?.push(entry);
      }
      const attach = (entry: { id: string; children: unknown[] }) => {
        const children = byParent.get(entry.id) ?? [];
        entry.children = children;
        for (const c of children) attach(c as { id: string; children: unknown[] });
      };
      const root = (byParent.get(null) ?? [])[0];
      if (!root) return { id: m.id, title: m.title, outline: `- ${m.title}` };
      attach(root);
      return { id: m.id, title: m.title, outline: renderOutline(root.text, root.children as never) };
    },
  }),
  defineTool({
    name: "add_mindmap_node",
    description: "Add a new branch (node) to an existing mind map, attached under a named parent node (or the central node).",
    permission: "write",
    maxCallsPerTurn: 6,
    input: z.object({
      mindmap: z.string().min(1).max(200),
      parent: z.string().min(1).max(300).optional(),
      text: z.string().min(1).max(300),
    }),
    label: (i) => `Adding “${i.text}” to a mind map`,
    execute: (i, ctx) => {
      const m = ctx.services.mindmaps.resolve(i.mindmap);
      if (!m) throw new ToolError(`Mind map "${i.mindmap}" not found.`);
      const nodes = ctx.services.mindmaps.nodes(m.id);
      const root = nodes.find((n) => n.parent_id === null);
      if (!root) throw new ToolError("This mind map has no central node.");
      const parent = i.parent ? ctx.services.mindmaps.resolveNode(m.id, i.parent) : root;
      if (!parent) throw new ToolError(`No node matching "${i.parent}" in this mind map.`);
      const node = ctx.services.mindmaps.createNode(m.id, { parent_id: parent.id, text: i.text });
      return { created: { id: node.id, text: node.text, under: parent.text } };
    },
  }),
  defineTool({
    name: "delete_mindmap",
    description: "Propose permanently deleting a mind map. The owner must approve it in the app before anything is deleted.",
    permission: "destructive",
    maxCallsPerTurn: 2,
    input: z.object({ mindmap: z.string().min(1).max(200) }),
    label: () => `Proposing to delete a mind map`,
    prepare: (i, ctx) => {
      const m = ctx.services.mindmaps.resolve(i.mindmap);
      if (!m) throw new ToolError(`Mind map "${i.mindmap}" not found.`);
      return { targetId: m.id, summary: `Delete mind map ${quoteTitle(m.title)}` };
    },
    commit: (id, ctx) => {
      const m = ctx.services.mindmaps.get(id);
      if (!m) throw new ToolError("This mind map no longer exists.");
      ctx.services.mindmaps.delete(m.id);
      ctx.services.activity.record("mindmap.deleted", `Deleted mind map “${m.title}” (approved agent action)`);
    },
  }),
];
