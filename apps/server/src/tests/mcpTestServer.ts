import http, { IncomingMessage, ServerResponse } from "node:http";

export interface McpTestServerOptions {
  port?: number;
}

export class McpTestServer {
  private server: http.Server | null = null;
  public port: number = 0;
  public records: Map<string, any> = new Map();
  public callCounts: {
    read_record: number;
    create_record: number;
    modify_record: number;
    error_op: number;
    timeout_op: number;
    sever_op: number;
  } = {
    read_record: 0,
    create_record: 0,
    modify_record: 0,
    error_op: 0,
    timeout_op: 0,
    sever_op: 0,
  };

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.records.clear();
    this.records.set("rec_1", { id: "rec_1", title: "Existing Record", payload: "Initial data" });
    this.callCounts = {
      read_record: 0,
      create_record: 0,
      modify_record: 0,
      error_op: 0,
      timeout_op: 0,
      sever_op: 0,
    };
  }

  public async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (typeof addr === "object" && addr !== null) {
          this.port = addr.port;
          resolve(`http://127.0.0.1:${this.port}/mcp`);
        } else {
          resolve("http://127.0.0.1:0/mcp");
        }
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "messiah-reliability-test-server", version: "1.0.0" },
            capabilities: { tools: {} },
          },
        })
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const { method, id, params } = payload;

        if (method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: params?.protocolVersion || "2025-11-25",
                serverInfo: { name: "messiah-reliability-test-server", version: "1.0.0" },
                capabilities: { tools: {} },
              },
            })
          );
          return;
        }

        if (method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                tools: [
                  {
                    name: "read_record",
                    description: "Reads a record by ID without mutating state (read-only)",
                    inputSchema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                      required: ["id"],
                    },
                    annotations: { readOnly: true },
                  },
                  {
                    name: "create_record",
                    description: "Creates a new record with side-effects (mutating)",
                    inputSchema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        title: { type: "string" },
                        payload: { type: "string" },
                      },
                      required: ["id", "title"],
                    },
                    annotations: { readOnly: false },
                  },
                  {
                    name: "modify_record",
                    description: "Updates an existing record (mutating)",
                    inputSchema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        updates: { type: "object" },
                      },
                      required: ["id", "updates"],
                    },
                    annotations: { readOnly: false },
                  },
                  {
                    name: "error_op",
                    description: "Simulates an application-level tool failure",
                    inputSchema: {
                      type: "object",
                      properties: { reason: { type: "string" } },
                    },
                  },
                  {
                    name: "timeout_op",
                    description: "Simulates delayed execution exceeding client timeout",
                    inputSchema: {
                      type: "object",
                      properties: { delayMs: { type: "number" } },
                    },
                  },
                  {
                    name: "sever_op",
                    description: "Simulates sudden socket connection severing",
                    inputSchema: { type: "object" },
                  },
                ],
              },
            })
          );
          return;
        }

        if (method === "tools/call") {
          const toolName = params?.name;
          const args = params?.arguments || {};

          if (toolName === "read_record") {
            this.callCounts.read_record++;
            const rec = this.records.get(args.id);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: rec ? JSON.stringify(rec) : JSON.stringify({ error: "Record not found" }),
                    },
                  ],
                  isError: !rec,
                },
              })
            );
            return;
          }

          if (toolName === "create_record") {
            this.callCounts.create_record++;
            this.records.set(args.id, {
              id: args.id,
              title: args.title,
              payload: args.payload || "",
              createdAt: new Date().toISOString(),
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        status: "created",
                        record: this.records.get(args.id),
                      }),
                    },
                  ],
                },
              })
            );
            return;
          }

          if (toolName === "modify_record") {
            this.callCounts.modify_record++;
            const existing = this.records.get(args.id) || {};
            const updated = { ...existing, ...args.updates, updatedAt: new Date().toISOString() };
            this.records.set(args.id, updated);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ status: "updated", record: updated }),
                    },
                  ],
                },
              })
            );
            return;
          }

          if (toolName === "error_op") {
            this.callCounts.error_op++;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `ApplicationError: ${args.reason || "Database constraint failure"}`,
                    },
                  ],
                },
              })
            );
            return;
          }

          if (toolName === "timeout_op") {
            this.callCounts.timeout_op++;
            const delay = args.delayMs || 5000;
            // Delay response longer than the test timeout
            setTimeout(() => {
              if (!res.writableEnded) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: "Belated response" }] },
                  })
                );
              }
            }, delay);
            return;
          }

          if (toolName === "sever_op") {
            this.callCounts.sever_op++;
            // Destroy socket immediately to simulate severed TCP connection / ECONNRESET
            req.socket.destroy();
            return;
          }

          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Tool not found: ${toolName}` },
            })
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }
}
