import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@messiah/db";
import {
  CronExpressionEngine,
  SafeExpressionEvaluator,
  WorkflowDagValidator,
  WorkflowExecutionRuntime,
  WorkflowSchedulerEngine,
} from "../index.js";

describe("Phase 6: Workflow Automation Engine, DAG Validator & Durable Scheduler", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let workspaceId = "";
  let userId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        externalId: `ext_wf_${suffix}`,
        email: `wf_${suffix}@test.local`,
        fullName: "Workflow Owner",
      },
    });
    userId = user.id;

    const ws = await prisma.workspace.create({
      data: {
        name: `Workflow Workspace ${suffix}`,
        slug: `wf-ws-${suffix}`,
        ownerId: userId,
        members: { create: [{ userId, role: "OWNER" }] },
      },
    });
    workspaceId = ws.id;
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("parses and computes timezone-aware cron schedules and misfire behavior", () => {
    const valid = CronExpressionEngine.validate("30 9 * * 1-5", "America/New_York");
    expect(valid.valid).toBe(true);
    expect(valid.nextRunAt).toBeInstanceOf(Date);

    const bad = CronExpressionEngine.validate("99 * * * *", "UTC");
    expect(bad.valid).toBe(false);

    const badTz = CronExpressionEngine.validate("0 9 * * *", "Invalid/Zone");
    expect(badTz.valid).toBe(false);

    const due = new Date(Date.now() - 10 * 60 * 1000);
    const misfireSkip = CronExpressionEngine.evaluateMisfire({
      cronExpression: "* * * * *",
      timezone: "UTC",
      dueAt: due,
      now: new Date(),
      misfirePolicy: "SKIP",
    });
    expect(misfireSkip.fireCount).toBe(0);

    const misfireBounded = CronExpressionEngine.evaluateMisfire({
      cronExpression: "* * * * *",
      timezone: "UTC",
      dueAt: due,
      now: new Date(),
      misfirePolicy: "CATCH_UP_BOUNDED",
    });
    expect(misfireBounded.fireCount).toBe(5);
  });

  it("evaluates condition expressions safely and rejects code-execution/prototype attacks", () => {
    const ctx = {
      trigger: { payload: { severity: "high", count: 7 } },
      steps: {
        review: { output: { summary: "Found HIGH priority race condition" } },
      },
    };

    expect(
      SafeExpressionEvaluator.evaluate(
        'steps.review.output.summary contains "high" && trigger.payload.count >= 5',
        ctx
      )
    ).toBe(true);

    expect(
      SafeExpressionEvaluator.evaluate(
        'trigger.payload.severity == "low" || trigger.payload.count < 3',
        ctx
      )
    ).toBe(false);

    const evilCheck = SafeExpressionEvaluator.validateSyntax("process.exit(1)");
    expect(evilCheck.valid).toBe(false);
    expect(SafeExpressionEvaluator.validateSyntax("__proto__.polluted == true").valid).toBe(false);
  });

  it("detects DAG cycles, incoming trigger edges, and arbitrary script transforms", () => {
    const cyclic = WorkflowDagValidator.validate({
      nodes: [
        { id: "trig", type: "manual_trigger", title: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "a", type: "transform", title: "A", position: { x: 100, y: 0 }, config: { template: "ok" } },
        { id: "b", type: "transform", title: "B", position: { x: 200, y: 0 }, config: { template: "ok" } },
      ],
      edges: [
        { id: "e1", source: "trig", target: "a" },
        { id: "e2", source: "a", target: "b" },
        { id: "e3", source: "b", target: "a" },
      ],
    });
    expect(cyclic.valid).toBe(false);
    expect(cyclic.issues.some((i) => i.code === "CYCLE_DETECTED")).toBe(true);

    const unsafeTransform = WorkflowDagValidator.validate({
      nodes: [
        { id: "trig", type: "manual_trigger", title: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "bad",
          type: "transform",
          title: "Evil Script",
          position: { x: 100, y: 0 },
          config: { code: "eval('rm -rf /')" },
        },
      ],
      edges: [{ id: "e1", source: "trig", target: "bad" }],
    });
    expect(unsafeTransform.valid).toBe(false);
    expect(unsafeTransform.issues.some((i) => i.code === "UNSAFE_SCRIPT_DISALLOWED")).toBe(true);
  });

  it("executes conditional branching DAG, pauses on approval gate, resumes cleanly, and stores result in memory", async () => {
    const graph = {
      nodes: [
        { id: "t1", type: "manual_trigger", title: "Start", position: { x: 0, y: 100 }, config: {} },
        {
          id: "c1",
          type: "condition",
          title: "Check Escalation Flag",
          position: { x: 200, y: 100 },
          config: { expression: "trigger.payload.escalate == true" },
        },
        {
          id: "gate1",
          type: "approval_gate",
          title: "Admin Approval",
          position: { x: 400, y: 40 },
          config: {
            title: "Confirm Escalated Action",
            summaryTemplate: "Ticket {{trigger.payload.ticket}} requires approval.",
          },
        },
        {
          id: "skipBranch",
          type: "transform",
          title: "Low Priority Path",
          position: { x: 400, y: 200 },
          config: { mode: "template", template: "Skipped path" },
        },
        {
          id: "m1",
          type: "merge",
          title: "Converge",
          position: { x: 600, y: 100 },
          config: { joinMode: "ANY" },
        },
        {
          id: "store1",
          type: "store_result",
          title: "Persist Outcome",
          position: { x: 800, y: 100 },
          config: {
            saveToMemory: true,
            memoryScope: "WORKSPACE",
            memoryTitleTemplate: "Escalated Decision {{trigger.payload.ticket}}",
            outputTemplate: "Escalation approved for {{trigger.payload.ticket}}",
          },
        },
        {
          id: "end1",
          type: "completion",
          title: "Done",
          position: { x: 1000, y: 100 },
          config: { summaryTemplate: "Stored: {{steps.store1.output.summary}}" },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "c1" },
        { id: "e2", source: "c1", target: "gate1", sourceHandle: "true" },
        { id: "e3", source: "c1", target: "skipBranch", sourceHandle: "false" },
        { id: "e4", source: "gate1", target: "m1" },
        { id: "e5", source: "skipBranch", target: "m1" },
        { id: "e6", source: "m1", target: "store1" },
        { id: "e7", source: "store1", target: "end1" },
      ],
    };

    const wf = await prisma.workflowDefinition.create({
      data: {
        workspaceId,
        name: "Conditional Gate Flow",
        slug: `cond-gate-${suffix}`,
        status: "ACTIVE",
        activeVersionNumber: 1,
        draftGraph: graph as any,
        createdByUserId: userId,
        versions: {
          create: {
            workspaceId,
            versionNumber: 1,
            definitionJson: graph as any,
            graphHash: "test-hash",
            publishedByUserId: userId,
          },
        },
      },
      include: { versions: true },
    });

    const run = await prisma.workflowRun.create({
      data: {
        workflowId: wf.id,
        versionId: wf.versions[0]!.id,
        workspaceId,
        triggeredByUserId: userId,
        triggerType: "MANUAL",
        status: "PENDING",
        triggerPayload: { escalate: true, ticket: "SEC-402" },
      },
    });

    const publishedEvents: string[] = [];
    const runtime = new WorkflowExecutionRuntime({
      decryptProviderSecret: () => "unused",
      publishEvent: async (ev) => {
        publishedEvents.push(ev.type);
      },
    });

    // Pass 1: Runs through condition, skips false branch, pauses at approval_gate!
    await runtime.processJob({ kind: "workflow.execute", runId: run.id, workspaceId, userId });

    const midRun = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { nodeExecutions: true, approvals: true },
    });
    expect(midRun.status).toBe("AWAITING_APPROVAL");
    expect(midRun.nodeExecutions.find((n) => n.nodeId === "skipBranch")?.status).toBe("SKIPPED");
    expect(midRun.nodeExecutions.find((n) => n.nodeId === "gate1")?.status).toBe("AWAITING_APPROVAL");
    expect(midRun.approvals).toHaveLength(1);

    // Approve gate cleanly in DB & resume
    await prisma.workflowApproval.update({
      where: { id: midRun.approvals[0]!.id },
      data: { status: "APPROVED", decidedByUserId: userId, decidedAt: new Date() },
    });

    await runtime.processJob({ kind: "workflow.execute", runId: run.id, workspaceId, userId });

    const finalRun = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { nodeExecutions: true },
    });
    expect(finalRun.status).toBe("COMPLETED");
    expect(finalRun.finalSummary).toContain("SEC-402");
    expect(finalRun.nodeExecutions.find((n) => n.nodeId === "store1")?.status).toBe("COMPLETED");

    // Verify stored memory entry exists with workflow provenance
    const mem = await prisma.memory.findFirst({
      where: { workspaceId, sourceWorkflowRunId: run.id },
    });
    expect(mem).not.toBeNull();
    expect(mem?.content).toContain("SEC-402");
    expect(publishedEvents).toContain("workflow.run.completed");
  });

  it("claims due cron schedules atomically without double-firing across concurrent sweeps", async () => {
    const simpleGraph = {
      nodes: [
        {
          id: "sched",
          type: "schedule_trigger",
          title: "Every Minute",
          position: { x: 0, y: 0 },
          config: { cronExpression: "* * * * *", timezone: "UTC" },
        },
        {
          id: "done",
          type: "completion",
          title: "Complete",
          position: { x: 250, y: 0 },
          config: { summaryTemplate: "Scheduled run complete." },
        },
      ],
      edges: [{ id: "e1", source: "sched", target: "done" }],
    };

    const wf = await prisma.workflowDefinition.create({
      data: {
        workspaceId,
        name: "Cron Sweep Flow",
        slug: `cron-sweep-${suffix}`,
        status: "ACTIVE",
        activeVersionNumber: 1,
        draftGraph: simpleGraph as any,
        createdByUserId: userId,
        versions: {
          create: {
            workspaceId,
            versionNumber: 1,
            definitionJson: simpleGraph as any,
            graphHash: "cron-hash",
            publishedByUserId: userId,
          },
        },
      },
      include: { versions: true },
    });

    const pastDue = new Date(Date.now() - 30_000);
    await prisma.workflowSchedule.create({
      data: {
        workflowId: wf.id,
        workspaceId,
        versionId: wf.versions[0]!.id,
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        misfirePolicy: "FIRE_ONCE",
        concurrencyPolicy: "SKIP_IF_RUNNING",
        nextRunAt: pastDue,
      },
    });

    const scheduler1 = new WorkflowSchedulerEngine();
    const scheduler2 = new WorkflowSchedulerEngine();

    const [res1, res2] = await Promise.all([
      scheduler1.sweepDueSchedules(new Date()),
      scheduler2.sweepDueSchedules(new Date()),
    ]);

    const totalRuns = res1.dispatchedRunIds.length + res2.dispatchedRunIds.length;
    expect(totalRuns).toBe(1);
  });
});
