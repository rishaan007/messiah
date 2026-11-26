import crypto from "node:crypto";
import {
  SWARM_CONSTANTS,
  SwarmPlanPayloadSchema,
  type SwarmExecutionPlan,
  type SwarmPlanTaskSpec,
} from "@messiah/shared";

export class SwarmDagError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PLAN_SCHEMA"
      | "EMPTY_PLAN"
      | "MAX_TASKS_EXCEEDED"
      | "DUPLICATE_TASK_KEY"
      | "UNKNOWN_DEPENDENCY"
      | "SELF_DEPENDENCY"
      | "INVALID_AGENT_ASSIGNMENT"
      | "CYCLE_DETECTED"
      | "DUPLICATE_TASK_FINGERPRINT",
    message: string
  ) {
    super(message);
    this.name = "SwarmDagError";
  }
}

export interface ValidatedPlanTask extends SwarmPlanTaskSpec {
  fingerprint: string;
  waveIndex: number;
}

export interface ValidatedSwarmPlan {
  goalSummary: string;
  planHash: string;
  tasks: ValidatedPlanTask[];
  topologicalOrder: string[];
  waves: string[][];
}

/**
 * Validates and compiles a Supervisor-generated execution plan into an acyclic DAG.
 * Prevents cycles, dangling references, unauthorized agent assignments, and infinite
 * identical task-replan loops via deterministic task fingerprinting.
 */
export class SwarmDagValidator {
  public static computeTaskFingerprint(task: SwarmPlanTaskSpec): string {
    const normalized = {
      assignedAgentId: task.assignedAgentId,
      title: task.title.trim().toLowerCase().replace(/\s+/g, " "),
      instructions: task.instructions.trim().toLowerCase().replace(/\s+/g, " "),
      dependsOnKeys: [...new Set(task.dependsOnKeys)].sort(),
    };
    return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  }

  public static computePlanHash(goalSummary: string, tasks: SwarmPlanTaskSpec[]): string {
    const canonical = {
      goalSummary: goalSummary.trim(),
      tasks: [...tasks]
        .sort((a, b) => a.taskKey.localeCompare(b.taskKey))
        .map((t) => ({
          taskKey: t.taskKey,
          assignedAgentId: t.assignedAgentId,
          dependsOnKeys: [...t.dependsOnKeys].sort(),
          inputTaskKeys: [...t.inputTaskKeys].sort(),
          instructions: t.instructions.trim(),
        })),
    };
    return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  public static validateAndNormalize(
    rawPlan: unknown,
    options: {
      allowedAgentIds: Set<string>;
      existingFingerprints?: Set<string>;
      maxTasks?: number;
    }
  ): ValidatedSwarmPlan {
    const parsed = SwarmPlanPayloadSchema.safeParse(rawPlan);
    if (!parsed.success) {
      throw new SwarmDagError(
        "INVALID_PLAN_SCHEMA",
        `Swarm execution plan failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
    }

    const { goalSummary, tasks } = parsed.data;
    const maxTasks = options.maxTasks ?? SWARM_CONSTANTS.MAX_TASKS_PER_RUN;
    if (tasks.length === 0) {
      throw new SwarmDagError("EMPTY_PLAN", "Swarm plan must contain at least one task.");
    }
    if (tasks.length > maxTasks) {
      throw new SwarmDagError(
        "MAX_TASKS_EXCEEDED",
        `Swarm plan exceeds maximum allowed tasks (${tasks.length} > ${maxTasks}).`
      );
    }

    const byKey = new Map<string, SwarmPlanTaskSpec>();
    for (const task of tasks) {
      if (byKey.has(task.taskKey)) {
        throw new SwarmDagError("DUPLICATE_TASK_KEY", `Duplicate taskKey '${task.taskKey}' in swarm plan.`);
      }
      if (!options.allowedAgentIds.has(task.assignedAgentId)) {
        throw new SwarmDagError(
          "INVALID_AGENT_ASSIGNMENT",
          `Task '${task.taskKey}' assigns agent '${task.assignedAgentId}', which is not enabled for this swarm run.`
        );
      }

      // Ensure inputTaskKeys are automatically included in dependencies so producers always complete first
      const mergedDeps = Array.from(new Set([...(task.dependsOnKeys || []), ...(task.inputTaskKeys || [])]));
      const mergedInputs = Array.from(new Set(task.inputTaskKeys || []));

      byKey.set(task.taskKey, {
        ...task,
        dependsOnKeys: mergedDeps,
        inputTaskKeys: mergedInputs,
      });
    }

    // Validate references & fingerprints
    const fingerprintsSeen = new Set<string>(options.existingFingerprints || []);
    const fingerprintsByKey = new Map<string, string>();

    for (const task of byKey.values()) {
      for (const depKey of task.dependsOnKeys) {
        if (depKey === task.taskKey) {
          throw new SwarmDagError("SELF_DEPENDENCY", `Task '${task.taskKey}' cannot depend on itself.`);
        }
        if (!byKey.has(depKey)) {
          throw new SwarmDagError(
            "UNKNOWN_DEPENDENCY",
            `Task '${task.taskKey}' references unknown dependency '${depKey}'.`
          );
        }
      }

      const fp = this.computeTaskFingerprint(task);
      if (fingerprintsSeen.has(fp)) {
        throw new SwarmDagError(
          "DUPLICATE_TASK_FINGERPRINT",
          `Detected repeated identical task delegation for '${task.taskKey}' (loop guard triggered).`
        );
      }
      fingerprintsSeen.add(fp);
      fingerprintsByKey.set(task.taskKey, fp);
    }

    // Kahn's topological sort + wave assignment
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const key of byKey.keys()) {
      inDegree.set(key, 0);
      dependents.set(key, []);
    }

    for (const task of byKey.values()) {
      inDegree.set(task.taskKey, task.dependsOnKeys.length);
      for (const depKey of task.dependsOnKeys) {
        dependents.get(depKey)!.push(task.taskKey);
      }
    }

    const waveByKey = new Map<string, number>();
    const waves: string[][] = [];
    const topologicalOrder: string[] = [];

    let currentWave = Array.from(byKey.keys()).filter((k) => (inDegree.get(k) || 0) === 0);
    let waveIdx = 0;

    while (currentWave.length > 0) {
      currentWave.sort((a, b) => a.localeCompare(b));
      waves.push(currentWave);
      const nextWaveSet = new Set<string>();

      for (const key of currentWave) {
        topologicalOrder.push(key);
        waveByKey.set(key, waveIdx);
        for (const childKey of dependents.get(key) || []) {
          const nextDeg = (inDegree.get(childKey) || 0) - 1;
          inDegree.set(childKey, nextDeg);
          if (nextDeg === 0) {
            nextWaveSet.add(childKey);
          }
        }
      }

      currentWave = Array.from(nextWaveSet);
      waveIdx++;
    }

    if (topologicalOrder.length !== byKey.size) {
      throw new SwarmDagError(
        "CYCLE_DETECTED",
        "Swarm task graph contains a cyclic dependency and cannot be executed."
      );
    }

    const normalizedTasks: ValidatedPlanTask[] = topologicalOrder.map((key) => {
      const task = byKey.get(key)!;
      return {
        ...task,
        fingerprint: fingerprintsByKey.get(key)!,
        waveIndex: waveByKey.get(key) ?? 0,
      };
    });

    return {
      goalSummary: goalSummary.trim(),
      planHash: this.computePlanHash(goalSummary, normalizedTasks),
      tasks: normalizedTasks,
      topologicalOrder,
      waves,
    };
  }

  public static toStoredPlanJson(validated: ValidatedSwarmPlan): SwarmExecutionPlan {
    return {
      goalSummary: validated.goalSummary,
      planHash: validated.planHash,
      tasks: validated.tasks.map(({ fingerprint: _fp, waveIndex: _wi, ...spec }) => spec),
    };
  }
}
