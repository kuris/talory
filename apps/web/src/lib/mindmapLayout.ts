import type { MindmapNode } from "@talorys/shared";

export type MindmapLayoutStyle = "tree" | "radial" | "fishbone" | "free";

export const MINDMAP_LAYOUT_STYLES: { value: MindmapLayoutStyle; label: string }[] = [
  { value: "tree", label: "Tree" },
  { value: "radial", label: "Radial" },
  { value: "fishbone", label: "Fishbone" },
  { value: "free", label: "Free" },
];

type Pos = { x: number; y: number };

function buildChildrenMap(nodes: MindmapNode[]): Map<string, MindmapNode[]> {
  const map = new Map<string, MindmapNode[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    if (!map.has(n.parent_id)) map.set(n.parent_id, []);
    map.get(n.parent_id)!.push(n);
  }
  for (const list of map.values()) list.sort((a, b) => a.order_index - b.order_index);
  return map;
}

/**
 * Computes non-overlapping node positions for every layout style except "free" (which keeps
 * each node's own stored/dragged x,y). All three auto layouts place the central node at (0, 0)
 * so the canvas's "reset view" control keeps recentering correctly.
 */
export function computeMindmapLayout(nodes: MindmapNode[], style: Exclude<MindmapLayoutStyle, "free">): Map<string, Pos> {
  const root = nodes.find((n) => n.parent_id === null);
  if (!root) return new Map();
  const childrenOf = buildChildrenMap(nodes);
  if (style === "tree") return layoutTree(root, childrenOf);
  if (style === "radial") return layoutRadial(root, childrenOf);
  return layoutFishbone(root, childrenOf);
}

// ---- Tree: classic layered layout. Each leaf claims its own y-slot and every ancestor is
// centered over its children's slots, which guarantees sibling subtrees never overlap. ----

const LEVEL_GAP = 240;
const LEAF_GAP = 84;

function layoutTree(root: MindmapNode, childrenOf: Map<string, MindmapNode[]>): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  let nextLeaf = 0;
  const place = (node: MindmapNode, depth: number): number => {
    const kids = childrenOf.get(node.id) ?? [];
    if (!kids.length) {
      const y = nextLeaf++ * LEAF_GAP;
      pos.set(node.id, { x: depth * LEVEL_GAP, y });
      return y;
    }
    const ys = kids.map((k) => place(k, depth + 1));
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    pos.set(node.id, { x: depth * LEVEL_GAP, y });
    return y;
  };
  const rootY = place(root, 0);
  for (const p of pos.values()) p.y -= rootY;
  return pos;
}

function countLeaves(node: MindmapNode, childrenOf: Map<string, MindmapNode[]>): number {
  const kids = childrenOf.get(node.id) ?? [];
  if (!kids.length) return 1;
  return kids.reduce((sum, k) => sum + countLeaves(k, childrenOf), 0);
}

// ---- Radial: depth sets the ring radius; each node's angular slice is split among its
// children in proportion to how many leaves they carry, so dense branches get more room. ----

const RADIUS_STEP = 260;

function layoutRadial(root: MindmapNode, childrenOf: Map<string, MindmapNode[]>): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const place = (node: MindmapNode, depth: number, angleStart: number, angleEnd: number) => {
    const angle = (angleStart + angleEnd) / 2;
    const r = depth * RADIUS_STEP;
    pos.set(node.id, { x: r * Math.cos(angle), y: r * Math.sin(angle) });
    const kids = childrenOf.get(node.id) ?? [];
    if (!kids.length) return;
    const total = kids.reduce((s, k) => s + countLeaves(k, childrenOf), 0);
    let a = angleStart;
    for (const k of kids) {
      const span = ((angleEnd - angleStart) * countLeaves(k, childrenOf)) / total;
      place(k, depth + 1, a, a + span);
      a += span;
    }
  };
  place(root, 0, 0, Math.PI * 2);
  return pos;
}

// ---- Fishbone (Ishikawa): the central node is the "head" at the right end of the spine.
// Each of its children is a main bone laid along the spine, alternating above/below, and that
// bone's own descendants fan out further away from the spine using the same leaf-slot trick
// as the tree layout, rotated 90° so they spread sideways along the bone instead of vertically. ----

const MAIN_GAP = 260;
const BRANCH_LEVEL_GAP = 100;
const BRANCH_SLOT_GAP = 74;

function layoutFishbone(root: MindmapNode, childrenOf: Map<string, MindmapNode[]>): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const mains = childrenOf.get(root.id) ?? [];
  const spineLength = Math.max(mains.length, 1) * MAIN_GAP;
  pos.set(root.id, { x: spineLength, y: 0 });

  mains.forEach((m, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const bx = spineLength - (i + 1) * MAIN_GAP;

    const slots = new Map<string, number>();
    let nextLeafSlot = 0;
    const assignSlot = (node: MindmapNode): number => {
      const kids = childrenOf.get(node.id) ?? [];
      if (!kids.length) {
        const s = nextLeafSlot++;
        slots.set(node.id, s);
        return s;
      }
      const childSlots = kids.map(assignSlot);
      const s = (Math.min(...childSlots) + Math.max(...childSlots)) / 2;
      slots.set(node.id, s);
      return s;
    };
    const rootSlot = assignSlot(m);

    const assignPos = (node: MindmapNode, branchDepth: number) => {
      const s = slots.get(node.id) ?? rootSlot;
      pos.set(node.id, { x: bx + (s - rootSlot) * BRANCH_SLOT_GAP, y: side * BRANCH_LEVEL_GAP * (branchDepth + 1) });
      for (const k of childrenOf.get(node.id) ?? []) assignPos(k, branchDepth + 1);
    };
    assignPos(m, 0);
  });

  return pos;
}
