import type { McpPermissionMode, WorkspaceRole } from "../types/index.js";
import { McpPermissionError } from "../errors/index.js";

export class McpPermissionService {
  /**
   * Evaluates if a workspace role is authorized to manage MCP server connections and policies.
   * Only OWNER and ADMIN roles may register, modify, or delete server connections and set permissions.
   */
  public static canManageConnections(role: WorkspaceRole): boolean {
    return role === "OWNER" || role === "ADMIN";
  }

  /**
   * Evaluates if a workspace role is authorized to view MCP connections and tool definitions.
   * OWNER, ADMIN, and MEMBER can view. VIEWER can view.
   */
  public static canViewConnections(_role: WorkspaceRole): boolean {
    return true; // All authenticated workspace members can view tools
  }

  /**
   * Asserts that a workspace role is authorized to modify tool permissions.
   */
  public static assertCanConfigurePermissions(role: WorkspaceRole): void {
    if (!this.canManageConnections(role)) {
      throw new McpPermissionError(
        `Insufficient workspace permissions. Only OWNER and ADMIN may configure tool permissions.`,
        "MCP_PERMISSION_DENIED",
        403
      );
    }
  }

  /**
   * Evaluates the default permission mode for newly discovered tools:
   * Defaults strictly to REQUIRE_APPROVAL (deny-by-default execution).
   * Annotations are treated as informational metadata and NEVER grant automatic authorization!
   */
  public static getDefaultPermissionMode(_annotations?: Record<string, unknown>): {
    mode: McpPermissionMode;
    requiresApproval: boolean;
  } {
    // Strictly deny-by-default: requires explicit administrator authorization
    return {
      mode: "REQUIRE_APPROVAL",
      requiresApproval: true,
    };
  }

  /**
   * Checks whether a tool is executable under its configured permission mode and caller role.
   * Note: In Phase 3A, execution is universally disabled.
   */
  public static isExecutableInPhase3A(): boolean {
    return false; // Tool execution belongs strictly to Phase 3B
  }

  /**
   * Universal execution guard for Phase 3A: Model-triggered execution is forbidden.
   */
  public static assertExecutionDisabled(toolName: string): void {
    throw new McpPermissionError(
      `Execution of tool '${toolName}' is disabled in Phase 3A. Tool execution is scheduled for Phase 3B.`,
      "MCP_EXECUTION_DISABLED_PHASE_3A",
      403
    );
  }
}
