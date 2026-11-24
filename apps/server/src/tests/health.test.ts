import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";

describe("Messiah Backend Probes & Core API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const testEnv = loadAndValidateEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
    });
    app = await buildApp({ env: testEnv, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health/live should report process liveness with 200 status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("alive");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.version).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  it("GET /health/ready should check database and redis availability", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    // Should return 200 (healthy) when containers are running
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json();
    expect(body).toHaveProperty("status");
    expect(body.checks).toHaveProperty("database");
    expect(body.checks).toHaveProperty("redis");
    expect(body.checks.database).toHaveProperty("status");
    expect(body.checks.redis).toHaveProperty("status");
    // Ensure no secrets are leaked
    expect(JSON.stringify(body)).not.toContain("password");
    expect(JSON.stringify(body)).not.toContain("postgresql://");
    expect(JSON.stringify(body)).not.toContain("redis://");
  });

  it("GET /api/v1/system should return system identity and metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/system",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("MESSIAH");
    expect(body.data.tagline).toBe(
      "One intelligence layer. Every agent. Every device.",
    );
  });

  it("GET /unknown-route should return structured 404 JSON error response", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/unknown-route-for-testing",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.meta).toHaveProperty("timestamp");
  });
});

describe("Environment Validation", () => {
  it("should throw an error when required configuration is missing", () => {
    expect(() => {
      loadAndValidateEnv({
        DATABASE_URL: "",
      });
    }).toThrow(/Invalid server environment configuration/);
  });
});
