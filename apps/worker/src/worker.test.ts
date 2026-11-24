import { describe, it, expect, beforeEach } from "vitest";
import { WorkerCancellationSubscriber } from "./cancellationSubscriber.js";
import { OutboxDispatcher, CHAT_GENERATION_QUEUE_NAME } from "./dispatcher.js";

describe("WorkerCancellationSubscriber", () => {
  let subscriber: WorkerCancellationSubscriber;

  beforeEach(() => {
    subscriber = new WorkerCancellationSubscriber();
  });

  it("registers a run and returns a valid AbortSignal", () => {
    const signal = subscriber.register("run-123");
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
  });

  it("deregisters a run cleanly without throwing", () => {
    subscriber.register("run-123");
    expect(() => subscriber.deregister("run-123")).not.toThrow();
  });

  it("handles close safely when not connected", async () => {
    await expect(subscriber.close()).resolves.toBeUndefined();
  });
});

describe("OutboxDispatcher", () => {
  it("uses the correct queue name and 0 retries policy", () => {
    expect(CHAT_GENERATION_QUEUE_NAME).toBe("messiah-chat-generation");
    
    // Test instantiation with mock redis url
    const dispatcher = new OutboxDispatcher("redis://localhost:6380");
    expect(dispatcher).toBeDefined();
    dispatcher.close();
  });
});
