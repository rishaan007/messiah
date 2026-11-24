import { describe, it, expect } from "vitest";
import {
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  isEvasiveNumericHost,
  validateMcpEndpointUrl,
  SsrfSecurityError,
  createSafeLookup,
  createSafeDispatcher,
  safeFetch,
  McpClientFactory,
  McpDiscoveryService,
  McpToolRegistry,
  McpPermissionService,
  McpPermissionError,
  McpConnectionManager,
  McpAuthService,
  McpAuthError,
  canonicalJsonStringify,
  computeHash,
  computeSchemaHash,
  computeArgumentsHash,
  ToolSchemaValidator,
  generateToolAlias,
  parseToolAlias,
  sanitizeSchemaForProviders,
  translateToProviderTool,
  ToolResultSanitizer,
  ToolAuthorizationService,
} from "../index.js";

describe("MESSIAH — Phase 3A & 3A.1: MCP Security & Protocol Hardening Test Suite", () => {
  describe("1. SSRF & Network Security Layer", () => {
    it("correctly identifies private, loopback, link-local, and reserved IPv4 addresses", () => {
      // Loopback
      expect(isPrivateOrReservedIpv4("127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("127.0.1.1")).toBe(true);

      // Private RFC 1918
      expect(isPrivateOrReservedIpv4("10.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("10.254.254.254")).toBe(true);
      expect(isPrivateOrReservedIpv4("172.16.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("172.31.255.255")).toBe(true);
      expect(isPrivateOrReservedIpv4("192.168.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("192.168.1.100")).toBe(true);

      // Carrier-Grade NAT (RFC 6598) & Alibaba metadata
      expect(isPrivateOrReservedIpv4("100.64.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv4("100.100.100.100")).toBe(true);
      expect(isPrivateOrReservedIpv4("100.127.255.255")).toBe(true);

      // Link-Local & AWS/GCP Cloud Metadata
      expect(isPrivateOrReservedIpv4("169.254.169.254")).toBe(true);
      expect(isPrivateOrReservedIpv4("169.254.0.1")).toBe(true);

      // Broadcast & Current Network
      expect(isPrivateOrReservedIpv4("0.0.0.0")).toBe(true);
      expect(isPrivateOrReservedIpv4("255.255.255.255")).toBe(true);

      // Public IPs (must be allowed)
      expect(isPrivateOrReservedIpv4("8.8.8.8")).toBe(false);
      expect(isPrivateOrReservedIpv4("1.1.1.1")).toBe(false);
      expect(isPrivateOrReservedIpv4("93.184.216.34")).toBe(false);
    });

    it("correctly identifies private, loopback, and ULA IPv6 addresses", () => {
      // Loopback & Unspecified
      expect(isPrivateOrReservedIpv6("::1")).toBe(true);
      expect(isPrivateOrReservedIpv6("::")).toBe(true);

      // Unique Local Addresses (ULA: fc00::/7)
      expect(isPrivateOrReservedIpv6("fc00::1")).toBe(true);
      expect(isPrivateOrReservedIpv6("fd00:ec2::254")).toBe(true); // AWS IPv6 metadata

      // Link-Local (fe80::/10)
      expect(isPrivateOrReservedIpv6("fe80::1")).toBe(true);

      // IPv4-mapped IPv6 (dot format & hex format)
      expect(isPrivateOrReservedIpv6("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv6("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIpv6("::ffff:169.254.169.254")).toBe(true);
      expect(isPrivateOrReservedIpv6("::ffff:7f00:1")).toBe(true); // hex 127.0.0.1

      // 6to4 addresses mapping to private IPv4
      expect(isPrivateOrReservedIpv6("2002:7f00:0001::")).toBe(true); // 127.0.0.1
      expect(isPrivateOrReservedIpv6("2002:0a00:0001::")).toBe(true); // 10.0.0.1

      // IPv6 zone identifiers / scope IDs
      expect(isPrivateOrReservedIpv6("fe80::1%eth0")).toBe(true);
      expect(isPrivateOrReservedIpv6("2606:4700::1%eth0")).toBe(true);

      // Public IPv6
      expect(isPrivateOrReservedIpv6("2606:4700:4700::1111")).toBe(false);
    });

    it("detects and rejects evasive numeric, octal, hexadecimal, and dword integer hostnames", () => {
      expect(isEvasiveNumericHost("0177.0.0.1")).toBe(true); // Octal loopback
      expect(isEvasiveNumericHost("0x7f.0.0.1")).toBe(true); // Hexadecimal
      expect(isEvasiveNumericHost("2130706433")).toBe(true); // Dword integer 127.0.0.1
      expect(isEvasiveNumericHost("127.1")).toBe(true); // Short numeric notation
      expect(isEvasiveNumericHost("10.1")).toBe(true); // Short numeric notation
      expect(isEvasiveNumericHost("fe80::1%eth0")).toBe(true); // Zone index
      expect(isEvasiveNumericHost("fe80::1%25eth0")).toBe(true); // Encoded zone index

      // Valid hostnames and standard public IPs
      expect(isEvasiveNumericHost("example.com")).toBe(false);
      expect(isEvasiveNumericHost("api.github.com")).toBe(false);
      expect(isEvasiveNumericHost("8.8.8.8")).toBe(false);
    });

    it("rejects non-HTTP/HTTPS protocols and unsafe ports", async () => {
      await expect(validateMcpEndpointUrl("ftp://example.com/mcp")).rejects.toThrow(
        SsrfSecurityError
      );
      await expect(validateMcpEndpointUrl("file:///etc/passwd")).rejects.toThrow(
        SsrfSecurityError
      );
      await expect(validateMcpEndpointUrl("gopher://example.com/")).rejects.toThrow(
        SsrfSecurityError
      );

      // Restricted system infrastructure ports
      await expect(validateMcpEndpointUrl("https://example.com:22/mcp")).rejects.toThrow(
        "restricted infrastructure port"
      );
      await expect(validateMcpEndpointUrl("https://example.com:25/mcp")).rejects.toThrow(
        "restricted infrastructure port"
      );
      await expect(validateMcpEndpointUrl("https://example.com:445/mcp")).rejects.toThrow(
        "restricted infrastructure port"
      );
    });

    it("enforces explicit production egress-port policy (Port 443 by default)", async () => {
      // In production mode: port 443 is permitted
      const res = await validateMcpEndpointUrl("https://example.com/mcp", {
        enforceProductionEgressPolicy: true,
      });
      expect(res.url.port).toBe(""); // Default 443

      // Port 8080 is blocked in production by default
      await expect(
        validateMcpEndpointUrl("https://example.com:8080/mcp", {
          enforceProductionEgressPolicy: true,
        })
      ).rejects.toThrow("Egress to port 8080 is prohibited by production security policy");

      // Port 8443 is blocked in production by default
      await expect(
        validateMcpEndpointUrl("https://example.com:8443/mcp", {
          enforceProductionEgressPolicy: true,
        })
      ).rejects.toThrow("Egress to port 8443 is prohibited by production security policy");

      // Port 8443 is allowed when explicitly included in allowedPorts
      const allowedRes = await validateMcpEndpointUrl("https://example.com:8443/mcp", {
        enforceProductionEgressPolicy: true,
        allowedPorts: [443, 8443],
      });
      expect(allowedRes.url.port).toBe("8443");
    });

    it("rejects direct IP endpoints that are private or cloud metadata", async () => {
      await expect(
        validateMcpEndpointUrl("http://127.0.0.1:8000/mcp")
      ).rejects.toThrow("Access to private, loopback, or reserved");

      await expect(
        validateMcpEndpointUrl("http://169.254.169.254/latest/meta-data")
      ).rejects.toThrow("Access to private, loopback, or reserved");

      await expect(
        validateMcpEndpointUrl("http://10.0.0.5:3000/mcp")
      ).rejects.toThrow("Access to private, loopback, or reserved");
    });

    it("rejects evasive numeric hostnames in endpoint URLs", async () => {
      await expect(
        validateMcpEndpointUrl("https://0177.0.0.1/mcp")
      ).rejects.toThrow("Evasive, malformed, or unusual IP representation is blocked");

      await expect(
        validateMcpEndpointUrl("https://0x7f.0.0.1/mcp")
      ).rejects.toThrow("Evasive, malformed, or unusual IP representation is blocked");

      await expect(
        validateMcpEndpointUrl("https://2130706433/mcp")
      ).rejects.toThrow("Evasive, malformed, or unusual IP representation is blocked");
    });

    it("enforces HTTPS in production environment", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        await expect(validateMcpEndpointUrl("http://api.example.com/mcp")).rejects.toThrow(
          "Insecure HTTP endpoints are not permitted in production"
        );
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it("safe socket lookup hooks intercept DNS resolution to block private IPs at connection time", () => {
      return new Promise<void>((resolve) => {
        const lookup = createSafeLookup({});
        lookup("127.0.0.1", {}, (err) => {
          expect(err).toBeInstanceOf(Error);
          expect(err?.message).toContain("Access to private, loopback, or reserved");
          resolve();
        });
      });
    });

    it("creates an Undici dispatcher with socket-level DNS verification", () => {
      const dispatcher = createSafeDispatcher();
      expect(dispatcher).toBeDefined();
    });
  });

  describe("2. Discovery Service & Schema Hashing", () => {
    it("computes deterministic SHA-256 schema hashes", () => {
      const tool1 = {
        name: "query_database",
        description: "Executes a read-only query",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      };

      const tool1Identical = {
        name: "query_database",
        description: "Executes a read-only query",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      };

      const tool1Modified = {
        name: "query_database",
        description: "Executes a read-only query with timeout",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            timeout: { type: "number" },
          },
          required: ["query"],
        },
      };

      const hash1 = McpDiscoveryService.computeSchemaHash(tool1);
      const hash1Identical = McpDiscoveryService.computeSchemaHash(tool1Identical);
      const hashModified = McpDiscoveryService.computeSchemaHash(tool1Modified);

      expect(hash1).toBe(hash1Identical);
      expect(hash1).toHaveLength(64); // SHA-256 hex string
      expect(hash1).not.toBe(hashModified);
    });

    it("formats unambiguous namespaced tool identifiers", () => {
      expect(McpDiscoveryService.formatNamespacedName("GitHub Server", "create_issue")).toBe(
        "github_server.create_issue"
      );
      expect(McpDiscoveryService.formatNamespacedName("Postgres-DB_1", "execute_sql")).toBe(
        "postgres-db_1.execute_sql"
      );
      expect(McpDiscoveryService.formatNamespacedName("My @ Server!", "search")).toBe(
        "my___server_.search"
      );
    });
  });

  describe("3. In-Memory Tool Registry", () => {
    it("registers, retrieves, and invalidates tools per workspace and connection", () => {
      const registry = new McpToolRegistry();
      const workspaceId = "ws-123";
      const connectionId = "conn-456";

      const tools = [
        {
          name: "fetch_data",
          namespacedName: "api.fetch_data",
          description: "Fetches remote data",
          inputSchema: { type: "object" },
          schemaHash: "hash123",
        },
      ];

      // Register
      registry.registerTools(workspaceId, connectionId, "api", tools);

      // Retrieve
      const cached = registry.getTools(workspaceId, connectionId);
      expect(cached).toBeDefined();
      expect(cached).toHaveLength(1);
      expect(cached?.[0]?.name).toBe("fetch_data");

      // Cross-workspace isolation
      expect(registry.getTools("ws-other", connectionId)).toBeNull();

      // Invalidate
      registry.invalidateConnection(workspaceId, connectionId);
      expect(registry.getTools(workspaceId, connectionId)).toBeNull();
    });

    it("respects TTL expiration in cache metadata", () => {
      const registry = new McpToolRegistry();
      const workspaceId = "ws-123";
      const connectionId = "conn-ttl";

      // Registered with TTL of 0 seconds (immediately expired)
      registry.registerTools(workspaceId, connectionId, "api", [], { ttl: -1 });

      const cached = registry.getTools(workspaceId, connectionId);
      expect(cached).toBeNull();
    });
  });

  describe("4. Permission Service & Phase 3A Execution Guard", () => {
    it("enforces deny-by-default (REQUIRE_APPROVAL)", () => {
      const defaultPerm = McpPermissionService.getDefaultPermissionMode();
      expect(defaultPerm.mode).toBe("REQUIRE_APPROVAL");
      expect(defaultPerm.requiresApproval).toBe(true);
    });

    it("evaluates role management policies correctly", () => {
      expect(McpPermissionService.canManageConnections("OWNER")).toBe(true);
      expect(McpPermissionService.canManageConnections("ADMIN")).toBe(true);
      expect(McpPermissionService.canManageConnections("MEMBER")).toBe(false);
      expect(McpPermissionService.canManageConnections("VIEWER")).toBe(false);
    });

    it("assertExecutionDisabled strictly throws McpPermissionError in Phase 3A", () => {
      expect(() => {
        McpPermissionService.assertExecutionDisabled("my_server.execute_sql");
      }).toThrow(McpPermissionError);

      try {
        McpPermissionService.assertExecutionDisabled("my_server.execute_sql");
      } catch (err: unknown) {
        expect((err as McpPermissionError).code).toBe("MCP_EXECUTION_DISABLED_PHASE_3A");
      }
    });

    it("isExecutableInPhase3A returns false", () => {
      expect(McpPermissionService.isExecutableInPhase3A()).toBe(false);
    });
  });

  describe("5. MCP 2026-07-28 Wire Compliance & Stateless Client", () => {
    it("omits deprecated capabilities (roots, sampling, logging) by default in client factory", () => {
      const client = McpClientFactory.createClient();
      expect(client).toBeDefined();
      // Client created without roots, sampling, or logging by default
      const opts = (client as any)._options || {};
      expect(opts.capabilities?.roots).toBeUndefined();
      expect(opts.capabilities?.sampling).toBeUndefined();
      expect(opts.capabilities?.logging).toBeUndefined();
    });
  });

  describe("6. OAuth Security & RFC 9207 Issuer Validation", () => {
    it("generates high-entropy PKCE challenge and state", () => {
      const { codeVerifier, codeChallenge } = McpAuthService.generatePkceChallenge();
      expect(codeVerifier).toBeDefined();
      expect(codeVerifier.length).toBeGreaterThan(40);
      expect(codeChallenge).toBeDefined();

      const state = McpAuthService.generateState();
      expect(state).toBeDefined();
      expect(state.length).toBeGreaterThan(30);
    });

    it("builds authorization URL with PKCE S256 parameters", () => {
      const authService = new McpAuthService();
      const { authUrl, state, codeVerifier } = authService.buildAuthorizationUrl({
        authorizationEndpoint: "https://auth.example.com/oauth/authorize",
        clientId: "client-123",
        redirectUri: "https://messiah.app/api/v1/mcp/oauth/callback",
      });

      const parsed = new URL(authUrl);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("client_id")).toBe("client-123");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsed.searchParams.get("state")).toBe(state);
      expect(codeVerifier).toBeDefined();
    });

    it("strictly throws McpAuthError on RFC 9207 issuer mismatch", async () => {
      const authService = new McpAuthService();

      await expect(
        authService.exchangeCode({
          authorizationServerUrl: "https://auth.example.com",
          clientInformation: { client_id: "test", client_secret: "secret" },
          code: "test-code",
          codeVerifier: "test-verifier",
          redirectUri: "https://messiah.app/callback",
          serverMetadata: {
            issuer: "https://auth.example.com",
            authorization_response_iss_parameter_supported: true,
          } as any,
          responseIssuer: "https://evil-attacker.com", // Mismatched issuer!
        })
      ).rejects.toThrow(McpAuthError);
    });
  });

  describe("7. Connection Manager Workspace Isolation", () => {
    it("maintains strict workspace boundaries for sessions", async () => {
      const manager = new McpConnectionManager();

      // Manager should report null for nonexistent sessions
      expect(manager.getSession("ws-1", "conn-1")).toBeUndefined();
      expect(manager.getSession("ws-2", "conn-1")).toBeUndefined();

      // Disconnect nonexistent session is safe no-op
      await expect(manager.disconnect("ws-1", "conn-1")).resolves.not.toThrow();
    });
  });

  describe("8. SafeFetch Transport & Redirect Security", () => {
    it("blocks redirects to cloud metadata and private IP ranges", async () => {
      const http = await import("node:http");
      const server = http.createServer((req, res) => {
        if (req.url === "/redirect-to-metadata") {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as any).port;

      try {
        await expect(
          safeFetch(`http://127.0.0.1:${port}/redirect-to-metadata`, {
            ssrfOptions: { allowLocalhost: true, allowHttp: true },
          })
        ).rejects.toThrow("Access to private, loopback, or reserved IPv4 address is blocked: 169.254.169.254");
      } finally {
        server.close();
      }
    });

    it("strips authorization and cookie headers when redirected to a different origin", async () => {
      const http = await import("node:http");
      let targetReceivedHeaders: any = null;

      const targetServer = http.createServer((req, res) => {
        targetReceivedHeaders = req.headers;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("target ok");
      });

      await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", () => resolve()));
      const targetPort = (targetServer.address() as any).port;

      const originServer = http.createServer((_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/target` });
        res.end();
      });

      await new Promise<void>((resolve) => originServer.listen(0, "127.0.0.1", () => resolve()));
      const originPort = (originServer.address() as any).port;

      try {
        const resp = await safeFetch(`http://127.0.0.1:${originPort}/source`, {
          headers: {
            authorization: "Bearer secret-mcp-key-12345",
            cookie: "session_id=confidential_session",
            "x-custom-tracking": "allowed_header",
          },
          ssrfOptions: { allowLocalhost: true, allowHttp: true },
        });

        expect(resp.status).toBe(200);
        expect(await resp.text()).toBe("target ok");
        expect(targetReceivedHeaders).toBeDefined();
        // Sensitive credentials must be stripped
        expect(targetReceivedHeaders.authorization).toBeUndefined();
        expect(targetReceivedHeaders.cookie).toBeUndefined();
        // Safe custom headers are preserved
        expect(targetReceivedHeaders["x-custom-tracking"]).toBe("allowed_header");
      } finally {
        originServer.close();
        targetServer.close();
      }
    });
  });

  describe("7. MCP Tool Schema Translation, Canonical JSON & Ajv Validation", () => {
    it("canonicalJsonStringify produces deterministic output regardless of key insertion order", () => {
      const obj1 = { b: 2, a: 1, c: { z: 26, y: 25 } };
      const obj2 = { c: { y: 25, z: 26 }, a: 1, b: 2 };

      const json1 = canonicalJsonStringify(obj1);
      const json2 = canonicalJsonStringify(obj2);

      expect(json1).toBe(json2);
      expect(json1).toBe('{"a":1,"b":2,"c":{"y":25,"z":26}}');

      const hash1 = computeHash(obj1);
      const hash2 = computeHash(obj2);
      expect(hash1).toBe(hash2);
    });

    it("computeSchemaHash and computeArgumentsHash generate valid SHA-256 hex digests", () => {
      const schema = {
        type: "object",
        properties: { repo: { type: "string" } },
        required: ["repo"],
      };
      const hash = computeSchemaHash(schema);
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);

      const argsHash = computeArgumentsHash({ repo: "messiah" });
      expect(argsHash).toHaveLength(64);
    });

    it("ToolSchemaValidator validates correct arguments successfully", () => {
      const validator = new ToolSchemaValidator();
      const schema = {
        type: "object",
        properties: {
          city: { type: "string" },
          days: { type: "integer", minimum: 1, maximum: 14 },
        },
        required: ["city"],
      };

      const result = validator.validateArguments(schema, { city: "Tokyo", days: 7 });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("ToolSchemaValidator catches missing required fields and type mismatches", () => {
      const validator = new ToolSchemaValidator();
      const schema = {
        type: "object",
        properties: {
          userId: { type: "string" },
          count: { type: "number" },
        },
        required: ["userId"],
      };

      const missingResult = validator.validateArguments(schema, { count: 5 });
      expect(missingResult.valid).toBe(false);
      expect(missingResult.errors?.[0]).toContain("must have required property 'userId'");

      const typeResult = validator.validateArguments(schema, { userId: 123 });
      expect(typeResult.valid).toBe(false);
      expect(typeResult.errors?.[0]).toContain("must be string");
    });

    it("ToolSchemaValidator rejects payloads exceeding MAX_ARGUMENTS_SIZE_BYTES (64 KB)", () => {
      const validator = new ToolSchemaValidator();
      const schema = { type: "object", properties: { data: { type: "string" } } };
      const largePayload = { data: "A".repeat(65 * 1024) }; // 65 KB

      const result = validator.validateArguments(schema, largePayload);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain("exceeds maximum allowed limit of 65536 bytes");
    });

    it("ToolSchemaValidator rejects schemas containing remote $ref references", () => {
      const validator = new ToolSchemaValidator();
      const maliciousSchema = {
        type: "object",
        properties: {
          profile: {
            $ref: "https://evil.internal.cloud/ssrf-schema",
          },
        },
      };

      const result = validator.validateArguments(maliciousSchema, { profile: {} });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain("contains forbidden remote $ref");
    });

    it("ToolSchemaValidator rejects deeply nested recursive structures exceeding MAX_SCHEMA_DEPTH (10)", () => {
      const validator = new ToolSchemaValidator();
      const schema = { type: "object" };

      // Build a structure with 12 levels of nesting
      let deep: any = { value: "deepest" };
      for (let i = 0; i < 12; i++) {
        deep = { child: deep };
      }

      const result = validator.validateArguments(schema, deep);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain("nesting depth");
    });

    it("ToolSchemaTranslator generates valid alias within 64 character limits", () => {
      const alias = generateToolAlias("github_prod", "get_pull_request");
      expect(alias).toBe("mcp__github_prod__get_pull_request");
      expect(alias.length).toBeLessThanOrEqual(64);

      const parsed = parseToolAlias(alias);
      expect(parsed).toEqual({
        connectionSlug: "github_prod",
        toolName: "get_pull_request",
      });

      // Long name truncation test
      const longSlug = "extremely_long_production_workspace_connection_identifier";
      const longTool = "fetch_super_detailed_complex_enterprise_analytical_report_metrics";
      const truncatedAlias = generateToolAlias(longSlug, longTool);
      expect(truncatedAlias.length).toBeLessThanOrEqual(64);
      expect(truncatedAlias.startsWith("mcp__")).toBe(true);
    });

    it("ToolSchemaTranslator prevents alias collisions using deterministic connectionId suffixes", () => {
      const connId1 = "a81f2345-0000-0000-0000-000000000001";
      const connId2 = "b92c4812-0000-0000-0000-000000000002";

      const alias1 = generateToolAlias("github", "create_issue", connId1);
      const alias2 = generateToolAlias("github", "create_issue", connId2);

      expect(alias1).toBe("mcp__github_a81f23__create_issue");
      expect(alias2).toBe("mcp__github_b92c48__create_issue");
      expect(alias1).not.toBe(alias2);
      expect(alias1.length).toBeLessThanOrEqual(64);
      expect(alias2.length).toBeLessThanOrEqual(64);

      const parsed1 = parseToolAlias(alias1);
      expect(parsed1).toEqual({
        connectionSlug: "github",
        connectionIdSuffix: "a81f23",
        toolName: "create_issue",
      });

      // Collision prevention with long names + connectionId
      const longSlug = "very_long_enterprise_integration_name";
      const longTool = "execute_critical_database_migration_task";
      const scopedLong = generateToolAlias(longSlug, longTool, connId1);
      expect(scopedLong.length).toBeLessThanOrEqual(64);
      expect(scopedLong.includes("a81f23")).toBe(true);
    });

    it("ToolSchemaTranslator sanitizes schemas for LLM provider consumption", () => {
      const rawSchema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "https://example.com/schema.json",
        title: "TestSchema",
        type: "object",
        properties: {
          name: { type: "string" },
        },
      };

      const sanitized = sanitizeSchemaForProviders(rawSchema);
      expect(sanitized.type).toBe("object");
      expect(sanitized.$schema).toBeUndefined();
      expect(sanitized.$id).toBeUndefined();
      expect(sanitized.title).toBeUndefined();
      expect(sanitized.properties).toBeDefined();

      const translated = translateToProviderTool("mcp__test__tool", "Test description", rawSchema);
      expect(translated.name).toBe("mcp__test__tool");
      expect(translated.description).toBe("Test description");
      expect(translated.parameters.type).toBe("object");
    });
  });

  describe("8. Tool Result Sanitizer & Security Filtering", () => {
    const sanitizer = new ToolResultSanitizer();

    it("redacts sensitive Bearer tokens and OpenAI/Anthropic/Gemini keys", () => {
      const rawText = "User token is Bearer secret_token_1234567890abcdef and key is sk-proj-12345678901234567890 and Gemini AIzaSyA12345678901234567890123456789";
      const sanitized = sanitizer.sanitize(rawText);

      expect(sanitized.content).not.toContain("secret_token_1234567890abcdef");
      expect(sanitized.content).toContain("Bearer [REDACTED_TOKEN]");
      expect(sanitized.content).toContain("[REDACTED_CREDENTIAL]");
    });

    it("strips dangerous URI protocols like javascript: and data:text/html", () => {
      const dangerousHtml = "<a href='javascript:alert(1)'>Click me</a> and src='data:text/html;base64,PHNjcmlwdD4='";
      const sanitized = sanitizer.sanitize(dangerousHtml);

      expect(sanitized.content).not.toContain("javascript:");
      expect(sanitized.content).not.toContain("data:text/html");
      expect(sanitized.content).toContain("blocked-scheme:");
    });

    it("enforces 512 KB payload truncation limit with clear warning notice", () => {
      // 600 KB string
      const hugeString = "X".repeat(600 * 1024);
      const sanitized = sanitizer.sanitize(hugeString);

      expect(sanitized.isTruncated).toBe(true);
      expect(sanitized.sanitizedBytes).toBeLessThanOrEqual(512 * 1024);
      expect(sanitized.content).toContain("... [Output truncated at 512KB execution limit]");
    });
  });

  describe("9. Tool Authorization Service Policy Evaluation", () => {
    const authService = new ToolAuthorizationService();

    it("denies tool execution for VIEWER role unconditionally", () => {
      const decision = authService.evaluateToolCall({
        workspaceId: "ws-1",
        userId: "u-1",
        userRole: "VIEWER",
        toolName: "get_weather",
        permissionMode: "EXPLICITLY_AUTHORIZED",
        isReadOnly: true,
        arguments: {},
      });

      expect(decision.status).toBe("DENIED");
      expect(decision.reason).toContain("viewers are not permitted");
    });

    it("denies tool execution when permission mode is DISABLED", () => {
      const decision = authService.evaluateToolCall({
        workspaceId: "ws-1",
        userId: "u-1",
        userRole: "MEMBER",
        toolName: "query_db",
        permissionMode: "DISABLED",
        isReadOnly: true,
        arguments: {},
      });

      expect(decision.status).toBe("DENIED");
      expect(decision.reason).toContain("disabled in this workspace");
    });

    it("requires approval for high-impact actions even under EXPLICITLY_AUTHORIZED", () => {
      const decision = authService.evaluateToolCall({
        workspaceId: "ws-1",
        userId: "u-1",
        userRole: "ADMIN",
        toolName: "delete_user_account",
        permissionMode: "EXPLICITLY_AUTHORIZED",
        isReadOnly: false,
        arguments: { force: true },
      });

      expect(decision.status).toBe("REQUIRE_APPROVAL");
      expect(decision.isHighImpact).toBe(true);
      expect(decision.reason).toContain("High-impact or potentially destructive");
    });

    it("allows execution for verified READ_ONLY tools with low-risk operations", () => {
      const decision = authService.evaluateToolCall({
        workspaceId: "ws-1",
        userId: "u-1",
        userRole: "MEMBER",
        toolName: "search_documents",
        permissionMode: "READ_ONLY",
        isReadOnly: true,
        arguments: { query: "messiah" },
      });

      expect(decision.status).toBe("ALLOWED");
      expect(decision.isHighImpact).toBe(false);
    });

    it("requires approval by default under REQUIRE_APPROVAL mode", () => {
      const decision = authService.evaluateToolCall({
        workspaceId: "ws-1",
        userId: "u-1",
        userRole: "MEMBER",
        toolName: "send_slack_message",
        permissionMode: "REQUIRE_APPROVAL",
        isReadOnly: false,
        arguments: { message: "hello" },
      });

      expect(decision.status).toBe("REQUIRE_APPROVAL");
    });
  });
});
