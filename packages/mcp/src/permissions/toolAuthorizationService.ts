import type { McpPermissionMode, WorkspaceRole } from "@messiah/shared";

export interface ToolAuthContext {
  workspaceId: string;
  threadId?: string;
  userId: string;
  userRole: WorkspaceRole;
  toolName: string;
  permissionMode: McpPermissionMode;
  isReadOnly: boolean;
  arguments: Record<string, unknown>;
  threadEnabledTools?: string[];
}

export interface ToolAuthDecision {
  status: "ALLOWED" | "REQUIRE_APPROVAL" | "DENIED";
  reason?: string;
  isHighImpact: boolean;
}

const HIGH_IMPACT_NAME_PATTERNS = [
  /(delete|destroy|drop|remove|terminate|kill|purge|wipe|truncate|reset)/i,
  /(execute|shell|cmd|command|eval|exec|run_script|bash|terminal|powershell)/i,
  /(write_file|upload_file|create_file|overwrite|chmod|chown)/i,
  /(transfer|pay|charge|refund|invoice|withdraw|purchase|order)/i,
  /(credential|secret|token|password|api_key|auth_token|ssh_key|private_key)/i,
  /(update_role|modify_permission|grant_access|revoke_access)/i,
];

/**
 * Detects whether a tool or its arguments indicate high-impact, destructive,
 * financial, system execution, or credential-altering operations.
 */
export function isHighImpactAction(toolName: string, args: Record<string, unknown>): boolean {
  // Check tool name
  for (const pattern of HIGH_IMPACT_NAME_PATTERNS) {
    if (pattern.test(toolName)) {
      return true;
    }
  }

  // Check argument keys and string values for high-risk flags
  const argsStr = JSON.stringify(args || {}).toLowerCase();
  if (
    argsStr.includes('"delete"') ||
    argsStr.includes('"drop table"') ||
    argsStr.includes('"rm -rf"') ||
    argsStr.includes('"force":true') ||
    argsStr.includes('"destructive":true')
  ) {
    return true;
  }

  return false;
}

export class ToolAuthorizationService {
  /**
   * Evaluates whether a tool call may proceed automatically (ALLOWED),
   * requires explicit human confirmation (REQUIRE_APPROVAL),
   * or must be rejected unconditionally (DENIED).
   */
  public evaluateToolCall(context: ToolAuthContext): ToolAuthDecision {
    const { userRole, toolName, permissionMode, isReadOnly, arguments: args, threadEnabledTools } = context;

    // 1. Role enforcement: VIEWERS can never trigger tool execution
    if (userRole === "VIEWER") {
      return {
        status: "DENIED",
        reason: "Workspace viewers are not permitted to trigger tool executions.",
        isHighImpact: false,
      };
    }

    // 2. Thread-level toggle check (if specified)
    if (threadEnabledTools && !threadEnabledTools.includes(toolName)) {
      return {
        status: "DENIED",
        reason: `Tool '${toolName}' is disabled for this conversation thread.`,
        isHighImpact: false,
      };
    }

    // 3. Permission mode DISABLED is strictly forbidden
    if (permissionMode === "DISABLED") {
      return {
        status: "DENIED",
        reason: `Tool '${toolName}' is disabled in this workspace by administrator policy.`,
        isHighImpact: false,
      };
    }

    // 4. High-impact analysis
    const highImpact = isHighImpactAction(toolName, args);

    // High impact actions ALWAYS require approval regardless of mode
    if (highImpact) {
      return {
        status: "REQUIRE_APPROVAL",
        reason: `High-impact or potentially destructive operation detected for '${toolName}'. Explicit human approval is required.`,
        isHighImpact: true,
      };
    }

    // 5. READ_ONLY mode
    if (permissionMode === "READ_ONLY") {
      if (isReadOnly && !highImpact) {
        return {
          status: "ALLOWED",
          reason: "Tool is verified read-only and operation is low risk.",
          isHighImpact: false,
        };
      }
      return {
        status: "REQUIRE_APPROVAL",
        reason: `Tool '${toolName}' is set to READ_ONLY mode but is not verified as read-only. Human approval required.`,
        isHighImpact: false,
      };
    }

    // 6. EXPLICITLY_AUTHORIZED mode
    if (permissionMode === "EXPLICITLY_AUTHORIZED") {
      return {
        status: "ALLOWED",
        reason: "Tool is explicitly authorized for automated execution by workspace administrator.",
        isHighImpact: false,
      };
    }

    // 7. REQUIRE_APPROVAL (default safe mode)
    return {
      status: "REQUIRE_APPROVAL",
      reason: `Workspace policy requires interactive confirmation before executing '${toolName}'.`,
      isHighImpact: false,
    };
  }
}
