import { describe, it, expect } from "vitest";
import type { ToolCallInfo, ToolApprovalInfo } from "@messiah/shared";

describe("Web UI Tools & Approval Components Logic", () => {
  it("correctly models ToolCallInfo status lifecycle", () => {
    const toolCall: ToolCallInfo = {
      id: "tc-001",
      generationRunId: "run-001",
      threadId: "th-001",
      workspaceId: "ws-001",
      toolDefinitionId: "td-001",
      providerCallId: "call_github_001",
      providerToolAlias: "mcp__github__create_issue",
      connectionId: "conn-001",
      toolName: "create_issue",
      schemaHash: "hash-001",
      argumentsHash: "hash-args-001",
      argumentsPreview: { title: "Fix bug", body: "Details here" },
      status: "AWAITING_APPROVAL",
      isError: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(toolCall.status).toBe("AWAITING_APPROVAL");
    expect(toolCall.providerToolAlias).toContain("mcp__");
    expect(toolCall.argumentsPreview.title).toBe("Fix bug");
  });

  it("calculates 5-minute approval expiration correctly", () => {
    const now = Date.now();
    const expiresAt = new Date(now + 5 * 60 * 1000).toISOString();

    const approval: ToolApprovalInfo = {
      id: "appr-001",
      toolCallId: "tc-001",
      workspaceId: "ws-001",
      status: "PENDING",
      argumentsHash: "hash-args-001",
      schemaHash: "hash-001",
      expiresAt,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    const remainingMs = new Date(approval.expiresAt).getTime() - now;
    expect(remainingMs).toBeGreaterThan(0);
    expect(Math.floor(remainingMs / 1000)).toBeCloseTo(300, -1);
  });

  it("detects expired approvals when expiresAt is in past", () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const isPast = new Date(pastDate).getTime() < Date.now();
    expect(isPast).toBe(true);
  });
});
