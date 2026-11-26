import { describe, it, expect } from "vitest";
import { getNodeVisualMeta } from "./WorkflowCanvas";
import {
  STARTER_WORKFLOW_TEMPLATES,
  WORKFLOW_NODE_TYPES,
  type WorkflowNodeType,
} from "@messiah/shared";

describe("Phase 6: Visual Workflow Canvas & Starter Templates UI Contracts", () => {
  it("provides distinct visual metadata for every supported workflow node type", () => {
    for (const nodeType of WORKFLOW_NODE_TYPES) {
      const meta = getNodeVisualMeta(nodeType as WorkflowNodeType);
      expect(meta.icon).toBeDefined();
      expect(meta.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.category.length).toBeGreaterThan(0);
      expect(meta.badge.length).toBeGreaterThan(0);
    }
  });

  it("ensures all starter workflow templates contain valid triggers, nodes, and connected edges", () => {
    expect(STARTER_WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const tpl of STARTER_WORKFLOW_TEMPLATES) {
      const nodeIds = new Set(tpl.graph.nodes.map((n) => n.id));
      expect(tpl.graph.nodes.some((n) => n.type.endsWith("_trigger"))).toBe(true);
      for (const edge of tpl.graph.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
    }
  });
});
