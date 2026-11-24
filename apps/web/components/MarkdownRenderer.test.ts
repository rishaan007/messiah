import { describe, it, expect } from "vitest";
import { isSafeUrl, sanitizeRawHtml } from "./MarkdownRenderer";

describe("MarkdownRenderer Security & Hardening Suite", () => {
  describe("1. URL Protocol Validation & Safe Schemes", () => {
    it("should allow safe standard https:// URLs", () => {
      expect(isSafeUrl("https://messiah.ai")).toBe(true);
      expect(isSafeUrl("https://example.com/api/v1/test?param=123")).toBe(true);
    });

    it("should allow safe http:// URLs", () => {
      expect(isSafeUrl("http://localhost:3000/dashboard")).toBe(true);
      expect(isSafeUrl("http://example.org")).toBe(true);
    });

    it("should allow safe mailto: URLs", () => {
      expect(isSafeUrl("mailto:security@messiah.ai")).toBe(true);
    });

    it("should allow safe relative and anchor paths", () => {
      expect(isSafeUrl("/settings/integrations")).toBe(true);
      expect(isSafeUrl("#section-architecture")).toBe(true);
    });

    it("SECURITY: should strictly reject javascript: URLs", () => {
      expect(isSafeUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeUrl("JAVASCRIPT:alert(document.cookie)")).toBe(false);
      expect(isSafeUrl("  javascript:void(0)  ")).toBe(false);
    });

    it("SECURITY: should strictly reject data: URLs", () => {
      expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
      expect(isSafeUrl("DATA:text/javascript,evil()")).toBe(false);
    });

    it("SECURITY: should strictly reject vbscript: and file: URLs", () => {
      expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
      expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    });

    it("should reject empty or invalid inputs", () => {
      expect(isSafeUrl("")).toBe(false);
      expect(isSafeUrl("    ")).toBe(false);
      // @ts-expect-error test non-string
      expect(isSafeUrl(null)).toBe(false);
    });
  });

  describe("2. Raw HTML Sanitization & Tag Escaping", () => {
    it("should escape script tags into inert text entities", () => {
      const raw = 'Hello <script>alert("XSS")</script> World';
      const sanitized = sanitizeRawHtml(raw);
      expect(sanitized).toBe('Hello &lt;script&gt;alert("XSS")&lt;/script&gt; World');
      expect(sanitized).not.toContain("<script>");
    });

    it("should escape iframe, object, and img injection tags", () => {
      const raw = 'Click here <iframe src="http://evil.com"></iframe> or <img src="x" onerror="alert(1)">';
      const sanitized = sanitizeRawHtml(raw);
      expect(sanitized).toContain("&lt;iframe");
      expect(sanitized).toContain("&lt;img");
      expect(sanitized).not.toContain("<iframe");
      expect(sanitized).not.toContain("<img");
    });

    it("should leave normal text and safe characters untouched", () => {
      const raw = "Messiah is a universal AI agent workspace with 100% test coverage.";
      expect(sanitizeRawHtml(raw)).toBe(raw);
    });
  });
});
