import { describe, expect, it } from "vitest";
import { resolveSafeMobileDeepLink } from "../mobileBridge.js";

describe("MESSIAH Mobile Capacitor Deep-Link Guard", () => {
  it("accepts valid messiah:// approval, chat, swarm, and workflow routes", () => {
    expect(resolveSafeMobileDeepLink("messiah://approvals?kind=MCP_TOOL&id=123")).toBe(
      "/approvals?kind=MCP_TOOL&id=123"
    );
    expect(resolveSafeMobileDeepLink("messiah://swarms/run-1")).toBe("/swarms/run-1");
    expect(resolveSafeMobileDeepLink("messiah://workflows/runs/wf-1")).toBe("/workflows/runs/wf-1");
    expect(resolveSafeMobileDeepLink("/chat/thread-1")).toBe("/chat/thread-1");
  });

  it("blocks open-redirect hosts, javascript URIs, path traversal, and unknown schemes", () => {
    expect(resolveSafeMobileDeepLink("https://evil.example/approvals")).toBeNull();
    expect(resolveSafeMobileDeepLink("javascript:alert(1)")).toBeNull();
    expect(resolveSafeMobileDeepLink("//evil.example/steal")).toBeNull();
    expect(resolveSafeMobileDeepLink("messiah://approvals/../../etc/passwd")).toBeNull();
    expect(resolveSafeMobileDeepLink("messiah://file:///etc/passwd")).toBeNull();
  });

  it("allows configured trusted Universal/App Link origins", () => {
    expect(
      resolveSafeMobileDeepLink("https://app.messiah.dev/approvals?id=abc", ["app.messiah.dev"])
    ).toBe("/approvals?id=abc");
  });
});
