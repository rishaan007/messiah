import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDesktopDeepLink, validateExternalDesktopUrl } from "./index.js";

describe("MESSIAH Tauri 2 Desktop Security & Configuration", () => {
  it("validates deep-link routes strictly and blocks traversal/open-redirect attacks", () => {
    expect(validateDesktopDeepLink("messiah://approvals?kind=MCP_TOOL&id=abc")).toBe(
      "/approvals?kind=MCP_TOOL&id=abc"
    );
    expect(validateDesktopDeepLink("messiah://chat/t-1")).toBe("/chat/t-1");
    expect(validateDesktopDeepLink("https://attacker.tld/approvals")).toBeNull();
    expect(validateDesktopDeepLink("messiah://../../etc/passwd")).toBeNull();
    expect(validateDesktopDeepLink("messiah://evil\\..\\path")).toBeNull();
    expect(validateDesktopDeepLink("messiah://arbitrary-unlisted-path")).toBeNull();
  });

  it("permits only HTTPS or loopback HTTP when opening external URLs", () => {
    expect(validateExternalDesktopUrl("https://messiah.dev/docs")).toBe(true);
    expect(validateExternalDesktopUrl("http://localhost:3000")).toBe(true);
    expect(validateExternalDesktopUrl("file:///etc/passwd")).toBe(false);
    expect(validateExternalDesktopUrl("javascript:alert(1)")).toBe(false);
  });

  it("enforces least-privilege capabilities, strict CSP, and signed updater config", () => {
    const capPath = path.resolve(process.cwd(), "src-tauri/capabilities/default.json");
    const confPath = path.resolve(process.cwd(), "src-tauri/tauri.conf.json");

    const cap = JSON.parse(fs.readFileSync(capPath, "utf-8")) as {
      windows: string[];
      remote: { urls: string[] };
      permissions: string[];
    };
    const conf = JSON.parse(fs.readFileSync(confPath, "utf-8")) as {
      app: { security: { csp: string; capabilities: string[] } };
      plugins: { updater?: { pubkey?: string; endpoints?: string[] } };
    };

    expect(cap.remote.urls.every((u) => u.includes("localhost") || u.includes("127.0.0.1"))).toBe(true);
    expect(cap.permissions).not.toContain("shell:allow-execute");
    expect(conf.app.security.csp).toContain("object-src 'none'");
    expect(conf.app.security.csp).toContain("frame-ancestors 'none'");
    expect(typeof conf.plugins.updater?.pubkey).toBe("string");
    expect(conf.plugins.updater?.endpoints?.every((e) => e.startsWith("https://"))).toBe(true);
  });
});
