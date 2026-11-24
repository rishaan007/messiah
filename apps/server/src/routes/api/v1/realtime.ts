import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "ws";
import { RealtimeTicketRequestSchema, WebSocketClientFrameSchema } from "@messiah/shared";
import { prisma } from "@messiah/db";
import {
  ticketService,
  threadService,
  messageService,
  generationService,
  streamPublisher,
} from "../../../services/chat/index.js";

export const realtimeRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/v1/realtime/ticket
   * Issues a cryptographically secure, short-lived (30s) single-use connection ticket.
   * Requires JWT authentication. Plaintext ticket is NEVER logged or placed in URL query params.
   */
  fastify.post<{ Body: unknown }>(
    "/realtime/ticket",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = RealtimeTicketRequestSchema.safeParse(request.body || {});
      const workspaceId = parseResult.success ? parseResult.data.workspaceId : undefined;

      const ticketInfo = await ticketService.createTicket(request.user.id, workspaceId, 30);

      return reply.code(201).send({
        success: true,
        data: ticketInfo,
        meta: { timestamp: new Date().toISOString() },
      });
    }
  );

  /**
   * WebSocket /api/v1/realtime
   * Realtime streaming gateway multiplexed across threads and devices.
   */
  fastify.get(
    "/realtime",
    { websocket: true },
    (socket: WebSocket, req) => {
      // 1. Origin Header Validation
      const origin = req.headers.origin;
      const isProd = process.env.NODE_ENV === "production";

      if (isProd) {
        // In production: origin header is mandatory and must match MESSIAH_ALLOWED_ORIGINS (or CORS_ORIGIN)
        if (!origin) {
          socket.close(4403, "Forbidden: Missing Origin");
          setTimeout(() => { if (socket.readyState !== socket.CLOSED) socket.terminate(); }, 50);
          return;
        }
        const allowedOrigins = (process.env.MESSIAH_ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);

        const normalizedOrigin = origin.trim().toLowerCase();
        const isAllowed = allowedOrigins.includes(normalizedOrigin);
        if (!isAllowed) {
          socket.close(4403, "Forbidden: Invalid Origin");
          setTimeout(() => { if (socket.readyState !== socket.CLOSED) socket.terminate(); }, 50);
          return;
        }
      } else {
        // In development/test: Allow local origins and omit checks for non-browser tooling
        const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
        const isAllowedOrigin =
          !origin ||
          origin === allowedOrigin ||
          origin.startsWith("http://localhost:") ||
          origin.startsWith("http://127.0.0.1:");

        if (!isAllowedOrigin) {
          socket.close(4403, "Forbidden Origin");
          setTimeout(() => { if (socket.readyState !== socket.CLOSED) socket.terminate(); }, 50);
          return;
        }
      }

      let authenticatedUserId: string | null = null;
      const threadUnsubscribers = new Map<string, () => void>();

      // Safe send helper
      const sendFrame = (event: string, data?: unknown, error?: { code: string; message: string }, threadId?: string) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              event,
              data,
              error,
              threadId,
              timestamp: new Date().toISOString(),
            })
          );
        }
      };

      // 2. Auth Timeout Guard: Client must authenticate within 10 seconds of connection
      const authTimeout = setTimeout(() => {
        if (!authenticatedUserId) {
          sendFrame("auth.failed", undefined, {
            code: "AUTH_TIMEOUT",
            message: "Authentication frame timed out",
          });
          socket.close(4408, "Auth Timeout");
        }
      }, 10000);

      // 3. Message Frame Dispatcher
      socket.on("message", async (rawMessage) => {
        try {
          const rawString = typeof rawMessage === "string" ? rawMessage : rawMessage.toString();
          const parsedJson = JSON.parse(rawString);
          const validated = WebSocketClientFrameSchema.safeParse(parsedJson);

          if (!validated.success) {
            sendFrame("error", undefined, {
              code: "INVALID_FRAME",
              message: validated.error.errors[0]?.message || "Malformed client frame",
            });
            return;
          }

          const { action, ticket, threadId } = validated.data;

          // A. Handle "auth" action
          if (action === "auth") {
            if (authenticatedUserId) {
              sendFrame("auth.success", { userId: authenticatedUserId, message: "Already authenticated" });
              return;
            }

            if (!ticket) {
              sendFrame("auth.failed", undefined, {
                code: "MISSING_TICKET",
                message: "Connection ticket is required",
              });
              socket.close(4401, "Missing Ticket");
              return;
            }

            // Atomically consume single-use ticket
            const payload = await ticketService.consumeTicket(ticket);
            if (!payload) {
              sendFrame("auth.failed", undefined, {
                code: "INVALID_TICKET",
                message: "Ticket is invalid, expired, or has already been used",
              });
              socket.close(4401, "Invalid Ticket");
              return;
            }

            clearTimeout(authTimeout);
            authenticatedUserId = payload.userId;

            sendFrame("auth.success", {
              userId: authenticatedUserId,
              workspaceId: payload.workspaceId,
            });
            return;
          }

          // B. Handle "ping" action
          if (action === "ping") {
            sendFrame("pong");
            return;
          }

          // Guard: All subsequent actions require completed authentication
          if (!authenticatedUserId) {
            sendFrame("error", undefined, {
              code: "UNAUTHENTICATED",
              message: "Must authenticate before issuing operations",
            });
            return;
          }

          // C. Handle "thread.subscribe" action
          if (action === "thread.subscribe") {
            if (!threadId) {
              sendFrame("error", undefined, {
                code: "MISSING_THREAD_ID",
                message: "threadId is required for subscription",
              });
              return;
            }

            // Verify thread access and workspace membership
            try {
              await threadService.verifyThreadAccess(authenticatedUserId, threadId);
            } catch {
              sendFrame(
                "error",
                undefined,
                {
                  code: "FORBIDDEN",
                  message: "Unauthorized thread subscription",
                },
                threadId
              );
              return;
            }

            // Clean up existing subscription for this thread if present
            if (threadUnsubscribers.has(threadId)) {
              threadUnsubscribers.get(threadId)!();
              threadUnsubscribers.delete(threadId);
            }

            // Attach listener to stream publisher
            const unsubscribeLocal = streamPublisher.onThreadEvent(threadId, (event) => {
              sendFrame(event.type, event.payload, undefined, threadId);
            });

            threadUnsubscribers.set(threadId, unsubscribeLocal);

            // Fetch and emit thread snapshot for state reconciliation
            const [threadMessages, activeRun] = await Promise.all([
              messageService.listMessages(authenticatedUserId, threadId, { limit: 50 }),
              prisma.generationRun.findFirst({
                where: { threadId, status: { in: ["PENDING", "STREAMING"] } },
                orderBy: { createdAt: "desc" },
              }),
            ]);

            sendFrame(
              "thread.snapshot",
              {
                thread: await threadService.getThread(authenticatedUserId, threadId),
                messages: threadMessages.messages,
                activeRun: activeRun ? generationService.formatRun(activeRun) : null,
              },
              undefined,
              threadId
            );
            return;
          }

          // D. Handle "thread.unsubscribe" action
          if (action === "thread.unsubscribe") {
            if (threadId && threadUnsubscribers.has(threadId)) {
              threadUnsubscribers.get(threadId)!();
              threadUnsubscribers.delete(threadId);
            }
            return;
          }
        } catch (err: unknown) {
          sendFrame("error", undefined, {
            code: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : "Internal WebSocket processing error",
          });
        }
      });

      // 4. Clean up subscriptions on disconnect
      socket.on("close", () => {
        clearTimeout(authTimeout);
        for (const unsub of threadUnsubscribers.values()) {
          unsub();
        }
        threadUnsubscribers.clear();
      });

      socket.on("error", (err) => {
        req.log.warn({ err }, "[RealtimeWebSocket] Socket error encountered");
      });
    }
  );
};
