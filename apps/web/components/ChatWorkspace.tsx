"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MessageSquare,
  Send,
  Square,
  Plus,
  Search,
  Trash2,
  Edit2,
  Check,
  X,
  Sparkles,
  Bot,
  User,
  Sliders,
  AlertCircle,
  RefreshCw,
  ShieldAlert,
  Laptop2,
  Database,
} from "lucide-react";
import { Button, cn } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { createClient } from "@/lib/supabase/client";
import { ToolApprovalCard } from "./tools/ToolApprovalCard";
import { ToolActivityTimeline } from "./tools/ToolActivityTimeline";
import { ThreadToolSelector } from "./tools/ThreadToolSelector";
import type {
  ThreadInfo,
  MessageInfo,
  GenerationRunInfo,
  WorkspaceInfo,
  ProviderConnectionInfo,
  ModelInfo,
  ToolCallInfo,
  ToolApprovalInfo,
  BridgeDeviceInfo,
  AgentDefinitionInfo,
  AgentRunInfo,
} from "@messiah/shared";

interface ChatWorkspaceProps {
  initialThreadId?: string;
}

export function ChatWorkspace({ initialThreadId }: ChatWorkspaceProps) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab] = useState("chat");

  // Workspaces & Auth
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);

  // Threads
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(initialThreadId || null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoadingThreads, setIsLoadingThreads] = useState(true);

  // Thread edit/delete modals
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);

  // Messages & Generation
  const [messages, setMessages] = useState<MessageInfo[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeRun, setActiveRun] = useState<GenerationRunInfo | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);

  // Providers & Models
  const [connections, setConnections] = useState<ProviderConnectionInfo[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  // Advanced Drawer
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState<number>(0.7);

  // MCP Tools & Approvals State
  const [threadToolCalls, setThreadToolCalls] = useState<ToolCallInfo[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalInfo[]>([]);

  // Local Agent Bridge Target State
  const [pairedDevices, setPairedDevices] = useState<BridgeDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  // Multi-Agent Swarm Mode State
  const [executionMode, setExecutionMode] = useState<"single" | "swarm">("single");
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentDefinitionInfo[]>([]);
  const [selectedSupervisorId, setSelectedSupervisorId] = useState<string>("");
  const [selectedWorkerIds, setSelectedWorkerIds] = useState<string[]>([]);
  const [activeSwarmRun, setActiveSwarmRun] = useState<AgentRunInfo | null>(null);

  // WebSocket State
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/api/v1/realtime";

  const [savedMemoryMsgIds, setSavedMemoryMsgIds] = useState<Set<string>>(new Set());

  const handleSaveMessageToMemory = async (msg: MessageInfo) => {
    if (!authToken || !activeWorkspace || !msg.content?.trim()) return;
    try {
      const res = await fetch(`${apiUrl}/api/v1/memories`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          scope: "PERSONAL",
          sourceType: "CONVERSATION_SUMMARY",
          sourceThreadId: currentThreadId || undefined,
          sourceMessageId: msg.id,
          title: `Saved Chat Insight (${msg.modelId || selectedModelId || "Messiah"})`,
          content: msg.content.slice(0, 12000),
          tags: ["chat", "saved"],
          importance: 0.7,
        }),
      });
      if (res.ok) {
        setSavedMemoryMsgIds((prev) => new Set(prev).add(msg.id));
      }
    } catch {}
  };

  // Auto-scroll to bottom
  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent]);

  // 1. Initial Authentication & Load Workspaces
  useEffect(() => {
    const initAuth = async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) {
          router.push("/login");
          return;
        }

        setAuthToken(session.access_token);

        // Fetch user workspaces
        const res = await fetch(`${apiUrl}/api/v1/workspaces`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (res.ok) {
          const body = await res.json();
          const wsList = body.data || [];
          if (wsList.length > 0 && !activeWorkspace) {
            setActiveWorkspace(wsList[0]);
          }
        }
      } catch (err) {
        console.error("Failed to initialize session/workspaces:", err);
      }
    };

    initAuth();
  }, [apiUrl, router, activeWorkspace]);

  // 2. Load Provider Connections for Active Workspace
  useEffect(() => {
    if (!authToken || !activeWorkspace) return;

    const loadConnections = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/v1/provider-connections?workspaceId=${activeWorkspace.id}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });

        if (res.ok) {
          const body = await res.json();
          const connList: ProviderConnectionInfo[] = body.data || [];
          setConnections(connList);

          if (connList.length > 0) {
            // Select first active connection if none selected
            const defaultConn = connList.find((c) => c.status === "ACTIVE") || connList[0];
            if (defaultConn) {
              setSelectedConnectionId(defaultConn.id);
            }
          }
        }
      } catch (err) {
        console.error("Failed to load provider connections:", err);
      }
    };

    loadConnections();

    // Load paired bridge devices for target execution
    fetch(`${apiUrl}/api/v1/devices?workspaceId=${activeWorkspace.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body?.success) {
          setPairedDevices(body.data || []);
        }
      })
      .catch((err) => console.error("Failed to load paired bridge devices:", err));

    // Load workspace agents for optional Multi-Agent Swarm orchestration directly from Chat
    fetch(`${apiUrl}/api/v1/agents?workspaceId=${activeWorkspace.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body?.success) {
          const list: AgentDefinitionInfo[] = body.data || [];
          setWorkspaceAgents(list);
          const sup = list.find((a) => a.canSupervise && a.status === "ACTIVE");
          if (sup) setSelectedSupervisorId((prev) => prev || sup.id);
          const workers = list
            .filter((a) => !a.canSupervise && a.status === "ACTIVE" && a.modelId)
            .slice(0, 3)
            .map((a) => a.id);
          if (workers.length > 0) setSelectedWorkerIds((prev) => (prev.length ? prev : workers));
        }
      })
      .catch((err) => console.error("Failed to load workspace agents:", err));
  }, [authToken, activeWorkspace, apiUrl]);

  // 3. Load Models for Selected Connection
  useEffect(() => {
    if (!authToken || !selectedConnectionId) return;

    const selectedConn = connections.find((c) => c.id === selectedConnectionId);
    if (!selectedConn) return;

    const loadModels = async () => {
      setIsLoadingModels(true);
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/providers/${selectedConn.provider}/models?workspaceId=${selectedConn.workspaceId}`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );

        if (res.ok) {
          const body = await res.json();
          const modelList: ModelInfo[] = body.data || [];
          setModels(modelList);

          const firstModel = modelList[0];
          if (firstModel) {
            setSelectedModelId(firstModel.id);
          }
        }
      } catch (err) {
        console.error("Failed to load models:", err);
      } finally {
        setIsLoadingModels(false);
      }
    };

    loadModels();
  }, [authToken, selectedConnectionId, connections, apiUrl]);

  // 4. Load Conversation Threads for Active Workspace
  const loadThreads = useCallback(async () => {
    if (!authToken || !activeWorkspace) return;

    setIsLoadingThreads(true);
    try {
      const res = await fetch(`${apiUrl}/api/v1/threads?workspaceId=${activeWorkspace.id}&limit=50`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (res.ok) {
        const body = await res.json();
        const threadList: ThreadInfo[] = body.data || [];
        setThreads(threadList);

        // If no thread currently selected, select first or keep null
        const firstThread = threadList[0];
        if (!currentThreadId && firstThread) {
          setCurrentThreadId(firstThread.id);
        }
      }
    } catch (err) {
      console.error("Failed to load threads:", err);
    } finally {
      setIsLoadingThreads(false);
    }
  }, [authToken, activeWorkspace, apiUrl, currentThreadId]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // 5. Load Messages when currentThreadId changes
  useEffect(() => {
    if (!authToken || !currentThreadId) {
      setMessages([]);
      return;
    }

    const loadMessages = async () => {
      setIsLoadingMessages(true);
      try {
        const res = await fetch(`${apiUrl}/api/v1/threads/${currentThreadId}/messages?limit=100`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });

        if (res.ok) {
          const body = await res.json();
          setMessages(body.data || []);
        }
      } catch (err) {
        console.error("Failed to load messages:", err);
      } finally {
        setIsLoadingMessages(false);
      }
    };

    loadMessages();
  }, [authToken, currentThreadId, apiUrl]);

  // 5b. Load Thread Tool Calls and Pending Approvals
  const loadThreadToolCalls = useCallback(async () => {
    if (!authToken || !currentThreadId) {
      setThreadToolCalls([]);
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/api/v1/threads/${currentThreadId}/tool-calls`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const body = await res.json();
        setThreadToolCalls(body.data || []);
      }
    } catch (err) {
      console.error("Failed to load thread tool calls:", err);
    }
  }, [authToken, currentThreadId, apiUrl]);

  const loadPendingApprovals = useCallback(async () => {
    if (!authToken || !activeWorkspace) {
      setPendingApprovals([]);
      return;
    }
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/tool-approvals?workspaceId=${activeWorkspace.id}&status=PENDING`,
        {
          headers: { Authorization: `Bearer ${authToken}` },
        }
      );
      if (res.ok) {
        const body = await res.json();
        setPendingApprovals(body.data || []);
      }
    } catch (err) {
      console.error("Failed to load pending approvals:", err);
    }
  }, [authToken, activeWorkspace, apiUrl]);

  useEffect(() => {
    loadThreadToolCalls();
  }, [loadThreadToolCalls]);

  useEffect(() => {
    loadPendingApprovals();
  }, [loadPendingApprovals]);

  const handleApproveTool = async (approvalId: string) => {
    if (!authToken || !activeWorkspace) return;
    try {
      const res = await fetch(`${apiUrl}/api/v1/tool-approvals/${approvalId}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPendingApprovals((prev) =>
          prev.map((a) => (a.id === approvalId ? { ...a, status: "APPROVED" as const } : a))
        );
        await loadThreadToolCalls();
      } else {
        throw new Error(data?.error?.message || "Failed to approve tool call.");
      }
    } catch (err) {
      console.error("Failed to approve tool call:", err);
      throw err;
    }
  };

  const handleDenyTool = async (approvalId: string, reason?: string) => {
    if (!authToken || !activeWorkspace) return;
    try {
      const res = await fetch(`${apiUrl}/api/v1/tool-approvals/${approvalId}/deny`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPendingApprovals((prev) =>
          prev.map((a) =>
            a.id === approvalId
              ? { ...a, status: "DENIED" as const, rejectionReason: reason || null }
              : a
          )
        );
        await loadThreadToolCalls();
      } else {
        throw new Error(data?.error?.message || "Failed to deny tool call.");
      }
    } catch (err) {
      console.error("Failed to deny tool call:", err);
      throw err;
    }
  };

  // 6. Realtime WebSocket Connection & Thread Channel Subscription
  useEffect(() => {
    if (!authToken || !currentThreadId) return;

    let ws: WebSocket | null = null;
    let isSubscribed = false;

    const connectWebSocket = async () => {
      try {
        // Request single-use 30s ticket
        const ticketRes = await fetch(`${apiUrl}/api/v1/realtime/ticket`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspaceId: activeWorkspace?.id }),
        });

        if (!ticketRes.ok) return;
        const ticketData = await ticketRes.json();
        const ticket = ticketData.data?.ticket;
        if (!ticket) return;

        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          // Send auth frame
          ws?.send(JSON.stringify({ action: "auth", ticket }));
        };

        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(event.data);

            if (frame.event === "auth.success") {
              setWsConnected(true);
              // Subscribe to the active thread
              ws?.send(JSON.stringify({ action: "thread.subscribe", threadId: currentThreadId }));
              isSubscribed = true;
            }

            if (frame.event === "thread.snapshot") {
              if (frame.data?.messages) {
                setMessages(frame.data.messages);
              }
              if (frame.data?.activeRun) {
                setActiveRun(frame.data.activeRun);
                setIsStreaming(true);
              }
            }

            if (frame.event === "run.started") {
              setIsStreaming(true);
              setStreamingMessageId(frame.messageId);
              setStreamingContent("");
            }

            if (frame.event === "message.delta") {
              const delta = frame.data?.delta || "";
              setStreamingContent((prev) => prev + delta);
              setIsStreaming(true);
            }

            if (frame.event === "usage.updated") {
              setActiveRun((prev) =>
                prev
                  ? {
                      ...prev,
                      inputTokens: frame.data?.inputTokens ?? prev.inputTokens,
                      outputTokens: frame.data?.outputTokens ?? prev.outputTokens,
                      cachedInputTokens: frame.data?.cachedTokens ?? prev.cachedInputTokens,
                    }
                  : null
              );
            }

            if (frame.event === "run.completed") {
              setIsStreaming(false);
              setStreamingContent("");
              setStreamingMessageId(null);
              // Re-fetch messages and tool calls to get persisted completed state
              fetch(`${apiUrl}/api/v1/threads/${currentThreadId}/messages?limit=100`, {
                headers: { Authorization: `Bearer ${authToken}` },
              })
                .then((r) => r.json())
                .then((b) => setMessages(b.data || []));
              loadThreadToolCalls();
              loadPendingApprovals();
            }

            if (frame.event === "run.cancelled" || frame.event === "run.failed") {
              setIsStreaming(false);
              setStreamingContent("");
              setStreamingMessageId(null);
              // Re-fetch messages and tool calls
              fetch(`${apiUrl}/api/v1/threads/${currentThreadId}/messages?limit=100`, {
                headers: { Authorization: `Bearer ${authToken}` },
              })
                .then((r) => r.json())
                .then((b) => setMessages(b.data || []));
              loadThreadToolCalls();
              loadPendingApprovals();
            }

            if (frame.event === "tool.approval_requested") {
              setIsStreaming(false);
              const approval = frame.payload?.toolApproval;
              const toolCall = frame.payload?.toolCall;
              if (approval) {
                setPendingApprovals((prev) => {
                  const filtered = prev.filter((a) => a.id !== approval.id);
                  return [...filtered, { ...approval, toolCall }];
                });
              }
              if (toolCall) {
                setThreadToolCalls((prev) => {
                  const exists = prev.some((t) => t.id === toolCall.id);
                  if (exists) {
                    return prev.map((t) => (t.id === toolCall.id ? { ...t, ...toolCall } : t));
                  }
                  return [...prev, toolCall];
                });
              }
            }

            if (frame.event === "tool.call_started") {
              const payload = frame.payload;
              if (payload?.toolCallId) {
                setThreadToolCalls((prev) => {
                  const exists = prev.some((t) => t.id === payload.toolCallId);
                  if (exists) {
                    return prev.map((t) =>
                      t.id === payload.toolCallId ? { ...t, status: "EXECUTING" as const } : t
                    );
                  }
                  return [
                    ...prev,
                    {
                      id: payload.toolCallId,
                      generationRunId: frame.runId,
                      threadId: frame.threadId,
                      workspaceId: activeWorkspace?.id || "",
                      toolDefinitionId: "",
                      providerCallId: payload.providerCallId,
                      providerToolAlias: payload.providerToolAlias,
                      connectionId: "",
                      toolName: payload.toolName,
                      schemaHash: "",
                      argumentsHash: "",
                      argumentsPreview: payload.argumentsPreview || {},
                      status: "EXECUTING" as const,
                      isError: false,
                      createdAt: frame.timestamp,
                      updatedAt: frame.timestamp,
                    },
                  ];
                });
              }
            }

            if (frame.event === "tool.call_completed") {
              const payload = frame.payload;
              if (payload?.toolCallId) {
                setThreadToolCalls((prev) =>
                  prev.map((t) =>
                    t.id === payload.toolCallId
                      ? {
                          ...t,
                          status: (payload.status || (payload.isError ? "FAILED" : "SUCCEEDED")) as any,
                          durationMs: payload.durationMs,
                          isError: payload.isError ?? false,
                          errorMessage: payload.isError ? payload.outputPreview : null,
                          result: payload.outputPreview,
                        }
                      : t
                  )
                );
              }
            }

            if (frame.event === "tool.approval_decided") {
              const payload = frame.payload;
              if (payload?.toolApprovalId) {
                setPendingApprovals((prev) =>
                  prev.map((a) =>
                    a.id === payload.toolApprovalId
                      ? { ...a, status: payload.status }
                      : a
                  )
                );
              }
              loadThreadToolCalls();
            }
          } catch (e) {
            console.error("Error parsing WebSocket frame:", e);
          }
        };

        ws.onclose = () => {
          setWsConnected(false);
        };

        ws.onerror = () => {
          setWsConnected(false);
        };

        // Ping heartbeat every 25s
        pingIntervalRef.current = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "ping" }));
          }
        }, 25000);
      } catch (err) {
        console.error("Failed to establish realtime connection:", err);
      }
    };

    connectWebSocket();

    return () => {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      if (ws) {
        if (isSubscribed && currentThreadId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "thread.unsubscribe", threadId: currentThreadId }));
        }
        ws.close();
      }
      wsRef.current = null;
      setWsConnected(false);
    };
  }, [authToken, currentThreadId, apiUrl, wsUrl, activeWorkspace]);

  // 7. Create New Thread
  const handleCreateNewThread = async () => {
    if (!authToken || !activeWorkspace) return;

    try {
      const res = await fetch(`${apiUrl}/api/v1/threads`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          title: "New Conversation",
          preferredProviderConnectionId: selectedConnectionId || undefined,
          preferredModelId: selectedModelId || undefined,
        }),
      });

      if (res.ok) {
        const body = await res.json();
        const newThread: ThreadInfo = body.data;
        setThreads((prev) => [newThread, ...prev]);
        setCurrentThreadId(newThread.id);
        setMessages([]);
        setStreamingContent("");
      }
    } catch (err) {
      console.error("Failed to create thread:", err);
    }
  };

  // 8. Rename Thread
  const handleSaveRename = async () => {
    if (!authToken || !editingThreadId || !editingTitle.trim()) return;

    try {
      const res = await fetch(`${apiUrl}/api/v1/threads/${editingThreadId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: editingTitle.trim() }),
      });

      if (res.ok) {
        const body = await res.json();
        setThreads((prev) =>
          prev.map((t) => (t.id === editingThreadId ? { ...t, title: body.data.title } : t))
        );
        setEditingThreadId(null);
        setEditingTitle("");
      }
    } catch (err) {
      console.error("Failed to rename thread:", err);
    }
  };

  // 9. Delete Thread
  const handleDeleteThread = async (threadId: string) => {
    if (!authToken) return;

    try {
      const res = await fetch(`${apiUrl}/api/v1/threads/${threadId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (res.ok) {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        if (currentThreadId === threadId) {
          const remaining = threads.filter((t) => t.id !== threadId);
          const nextThread = remaining[0];
          setCurrentThreadId(nextThread ? nextThread.id : null);
        }
        setDeletingThreadId(null);
      }
    } catch (err) {
      console.error("Failed to delete thread:", err);
    }
  };

  // 10. Send Message
  const handleSendMessage = async () => {
    if (!inputText.trim() || isSending || isStreaming || !authToken) return;

    let targetThreadId = currentThreadId;

    // Auto-create thread if none exists
    if (!targetThreadId && activeWorkspace) {
      try {
        const createRes = await fetch(`${apiUrl}/api/v1/threads`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId: activeWorkspace.id,
            title: inputText.trim().slice(0, 48),
            preferredProviderConnectionId: selectedConnectionId || undefined,
            preferredModelId: selectedModelId || undefined,
          }),
        });

        if (createRes.ok) {
          const createBody = await createRes.json();
          targetThreadId = createBody.data.id;
          setCurrentThreadId(targetThreadId);
          setThreads((prev) => [createBody.data, ...prev]);
        } else {
          return;
        }
      } catch (e) {
        console.error("Failed to auto-create thread:", e);
        return;
      }
    }

    if (!targetThreadId) return;

    // Dispatch Multi-Agent Swarm run linked to this chat thread
    if (executionMode === "swarm") {
      if (!activeWorkspace || !selectedSupervisorId || selectedWorkerIds.length === 0) return;
      const objectiveText = inputText.trim();
      setInputText("");
      setIsSending(true);
      try {
        const res = await fetch(`${apiUrl}/api/v1/swarms`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workspaceId: activeWorkspace.id,
            supervisorAgentId: selectedSupervisorId,
            workerAgentIds: selectedWorkerIds,
            objective: objectiveText,
            threadId: targetThreadId,
            targetBridgeDeviceId: selectedDeviceId || undefined,
          }),
        });
        if (res.ok) {
          const body = await res.json();
          setActiveSwarmRun(body.data as AgentRunInfo);
          // Refresh messages to immediately show queued swarm user + assistant placeholder messages
          const msgRes = await fetch(`${apiUrl}/api/v1/threads/${targetThreadId}/messages?limit=100`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (msgRes.ok) {
            setMessages((await msgRes.json()).data || []);
          }
        }
      } catch (err) {
        console.error("Failed launching swarm from chat:", err);
      } finally {
        setIsSending(false);
      }
      return;
    }

    if (!selectedConnectionId || !selectedModelId) return;

    const messageContent = inputText.trim();
    setInputText("");
    setIsSending(true);

    const idempotencyKey = `idem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const selectedDevice = pairedDevices.find((d) => d.id === selectedDeviceId);
    const effectiveSystemPrompt = selectedDevice
      ? [
          systemPrompt.trim(),
          `[Target Workstation Context: ${selectedDevice.displayName} (ID: ${selectedDevice.id}, Platform: ${selectedDevice.platform}-${selectedDevice.architecture}). Authorized local bridge execution is active.]`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : systemPrompt.trim() || undefined;

    try {
      const res = await fetch(`${apiUrl}/api/v1/threads/${targetThreadId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: messageContent,
          providerConnectionId: selectedConnectionId,
          modelId: selectedModelId,
          idempotencyKey,
          temperature: temperature,
          systemPrompt: effectiveSystemPrompt,
        }),
      });

      if (res.ok) {
        const body = await res.json();
        const { userMessage, assistantMessage, run } = body.data;

        setMessages((prev) => [...prev, userMessage, assistantMessage]);
        setActiveRun(run);
        setIsStreaming(true);
        setStreamingMessageId(assistantMessage.id);
        setStreamingContent("");
      }
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setIsSending(false);
    }
  };

  // 11. Stop / Cancel Generation
  const handleStopGeneration = async () => {
    if (!authToken || !activeRun?.id) return;

    try {
      await fetch(`${apiUrl}/api/v1/generation-runs/${activeRun.id}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "User cancelled generation" }),
      });

      setIsStreaming(false);
      setStreamingContent("");
      setStreamingMessageId(null);
    } catch (err) {
      console.error("Failed to cancel generation run:", err);
    }
  };

  // Filter threads by search query
  const filteredThreads = threads.filter((t) =>
    t.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen w-full flex-col bg-[#07090E] text-[#F0F4FC] overflow-hidden">
      {/* Top Header */}
      <Header
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        activeWorkspace={activeWorkspace}
        onWorkspaceChange={(ws) => setActiveWorkspace(ws)}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Monorepo Main Sidebar */}
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeTab={activeTab}
          onSelectTab={() => {}}
        />

        {/* =========================================================================
            UNIVERSAL CHAT WORKSPACE (PANELS: THREADS LIST + CONVERSATION CANVAS)
           ========================================================================= */}
        <div className="flex flex-1 overflow-hidden">
          {/* Thread Navigation Sidebar */}
          <div className="hidden lg:flex w-72 flex-col border-r border-[#1E2536] bg-[#0A0D14]">
            {/* Thread Actions & Search */}
            <div className="p-3 border-b border-[#1E2536] space-y-2">
              <Button
                onClick={handleCreateNewThread}
                className="w-full flex items-center justify-center gap-2 bg-[#00FFA3] text-black hover:bg-[#00FFA3]/90 font-medium text-xs h-9"
              >
                <Plus className="w-4 h-4" />
                <span>New Conversation</span>
              </Button>

              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[#64748B]" />
                <input
                  type="text"
                  placeholder="Search threads..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 rounded-md border border-[#1E2536] bg-[#121620] text-xs text-[#F0F4FC] placeholder-[#64748B] focus:outline-none focus:border-[#00FFA3]"
                />
              </div>
            </div>

            {/* Threads List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {isLoadingThreads ? (
                <div className="flex items-center justify-center py-8 text-xs text-[#64748B]">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin mr-2" />
                  Loading threads...
                </div>
              ) : filteredThreads.length === 0 ? (
                <div className="text-center py-8 px-4 text-xs text-[#64748B]">
                  No conversation threads found.
                </div>
              ) : (
                filteredThreads.map((thread) => {
                  const isSelected = thread.id === currentThreadId;
                  const isEditing = editingThreadId === thread.id;

                  return (
                    <div
                      key={thread.id}
                      onClick={() => {
                        if (!isEditing) setCurrentThreadId(thread.id);
                      }}
                      className={cn(
                        "group relative flex items-center justify-between rounded-lg px-3 py-2 text-xs transition-colors cursor-pointer",
                        isSelected
                          ? "bg-[#161B26] text-[#00FFA3] font-medium border border-[#1E2536]"
                          : "text-[#94A3B8] hover:bg-[#121620] hover:text-[#F0F4FC]"
                      )}
                    >
                      <div className="flex items-center gap-2 overflow-hidden flex-1 mr-2">
                        <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                        {isEditing ? (
                          <div className="flex items-center gap-1 w-full" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveRename();
                                if (e.key === "Escape") setEditingThreadId(null);
                              }}
                              autoFocus
                              className="w-full px-1.5 py-0.5 rounded bg-[#0A0D14] border border-[#00FFA3] text-xs text-white focus:outline-none"
                            />
                            <button
                              onClick={handleSaveRename}
                              className="p-1 hover:text-[#00FFA3]"
                              title="Save title"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setEditingThreadId(null)}
                              className="p-1 hover:text-red-400"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="truncate">{thread.title}</span>
                        )}
                      </div>

                      {/* Hover Actions */}
                      {!isEditing && (
                        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingThreadId(thread.id);
                              setEditingTitle(thread.title);
                            }}
                            className="p-1 text-[#64748B] hover:text-[#F0F4FC]"
                            title="Rename"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingThreadId(thread.id);
                            }}
                            className="p-1 text-[#64748B] hover:text-red-400"
                            title="Delete"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Realtime Gateway Connection Status Footer */}
            <div className="p-3 border-t border-[#1E2536] flex items-center justify-between text-[11px] text-[#64748B]">
              <div className="flex items-center gap-1.5">
                {wsConnected ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-[#00FFA3]" />
                    <span className="text-[#00FFA3] font-mono">Stream: Live</span>
                  </>
                ) : (
                  <>
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    <span className="text-amber-400 font-mono">Stream: Connecting</span>
                  </>
                )}
              </div>
              <span className="font-mono text-[10px] text-[#475569]">Fastify WS</span>
            </div>
          </div>

          {/* Conversation Main Canvas */}
          <div className="flex flex-1 flex-col overflow-hidden bg-[#07090E]">
            {/* Top Workspace Bar: Active Model & Advanced Drawer Toggle */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1E2536] bg-[#0A0D14]/90 backdrop-blur-sm">
              <div className="flex items-center gap-3">
                {/* Provider Connection Picker */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#64748B] font-mono">Provider:</span>
                  {connections.length > 0 ? (
                    <select
                      value={selectedConnectionId}
                      onChange={(e) => setSelectedConnectionId(e.target.value)}
                      className="px-2 py-1 rounded bg-[#121620] border border-[#1E2536] text-xs text-[#F0F4FC] focus:outline-none focus:border-[#00FFA3]"
                    >
                      {connections.map((conn) => (
                        <option key={conn.id} value={conn.id}>
                          {conn.displayName} ({conn.provider.toUpperCase()})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Link
                      href="/settings/integrations"
                      className="flex items-center gap-1 text-xs text-amber-400 hover:underline"
                    >
                      <AlertCircle className="w-3 h-3" />
                      <span>Connect API Key</span>
                    </Link>
                  )}
                </div>

                {/* Model Picker */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#64748B] font-mono">Model:</span>
                  <select
                    value={selectedModelId}
                    onChange={(e) => setSelectedModelId(e.target.value)}
                    disabled={models.length === 0 || isLoadingModels}
                    className="px-2 py-1 rounded bg-[#121620] border border-[#1E2536] text-xs text-[#F0F4FC] focus:outline-none focus:border-[#00FFA3] disabled:opacity-50"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Workstation Target Selector */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#64748B] font-mono flex items-center gap-1">
                    <Laptop2 className="w-3 h-3 text-indigo-400" />
                    Target:
                  </span>
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    className="px-2 py-1 rounded bg-[#121620] border border-[#1E2536] text-xs text-[#F0F4FC] focus:outline-none focus:border-indigo-500 max-w-[200px]"
                  >
                    <option value="">Cloud Engine</option>
                    {pairedDevices.map((d) => (
                      <option key={d.id} value={d.id} disabled={!d.isOnline}>
                        {d.displayName} ({d.platform}) {d.isOnline ? "• Online" : "• Offline"}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Right Bar Controls */}
              <div className="flex items-center gap-2">
                {activeWorkspace && authToken && (
                  <ThreadToolSelector
                    workspaceId={activeWorkspace.id}
                    authToken={authToken}
                    apiUrl={apiUrl}
                  />
                )}
                <Button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  variant="outline"
                  className={cn(
                    "h-7 px-2 text-xs flex items-center gap-1.5 border-[#1E2536]",
                    showAdvanced && "border-[#00FFA3] text-[#00FFA3]"
                  )}
                >
                  <Sliders className="w-3 h-3" />
                  <span>Config</span>
                </Button>
              </div>
            </div>

            {/* Collapsible Advanced Parameters Drawer */}
            {showAdvanced && (
              <div className="px-4 py-3 border-b border-[#1E2536] bg-[#0E121B] grid grid-cols-1 md:grid-cols-2 gap-4 text-xs animate-in slide-in-from-top-2 duration-150">
                <div>
                  <label className="block text-[11px] font-mono text-[#8B949E] uppercase mb-1">
                    System Instructions (Developer Persona)
                  </label>
                  <textarea
                    rows={2}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="e.g. You are Messiah's Universal AI Systems Engineer..."
                    className="w-full px-2.5 py-1.5 rounded bg-[#141924] border border-[#1E2536] text-xs text-[#F0F4FC] placeholder-[#475569] focus:outline-none focus:border-[#00FFA3]"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-[11px] font-mono text-[#8B949E]">
                    <span>Temperature</span>
                    <span className="text-[#00FFA3]">{temperature}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={temperature}
                    onChange={(e) => setTemperature(parseFloat(e.target.value))}
                    className="w-full accent-[#00FFA3] cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-[#475569]">
                    <span>0.0 (Deterministic)</span>
                    <span>1.0 (Creative)</span>
                  </div>
                </div>
              </div>
            )}

            {/* Message Timeline */}
            <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
              {isLoadingMessages ? (
                <div className="flex items-center justify-center py-12 text-xs text-[#64748B]">
                  <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                  Loading conversation history...
                </div>
              ) : messages.length === 0 && !isStreaming ? (
                // Empty State / Starter Screen
                <div className="flex h-full flex-col items-center justify-center text-center max-w-lg mx-auto py-12">
                  <div className="w-12 h-12 rounded-xl bg-[#00FFA3]/10 border border-[#00FFA3]/20 flex items-center justify-center mb-4">
                    <Sparkles className="w-6 h-6 text-[#00FFA3]" />
                  </div>
                  <h2 className="text-lg font-semibold text-[#F0F4FC] mb-2">
                    Universal AI Intelligence Canvas
                  </h2>
                  <p className="text-xs text-[#94A3B8] mb-6 leading-relaxed">
                    Start a conversation with verified cloud AI models across OpenAI, Anthropic, and Google Gemini through Messiah's unified streaming gateway.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full text-left">
                    {[
                      "Explain Messiah's agent architecture",
                      "Draft a system prompt for tool calling",
                      "Compare LLM context windows & caching",
                      "Analyze AES-256-GCM vault security",
                    ].map((prompt, pidx) => (
                      <button
                        key={pidx}
                        onClick={() => {
                          setInputText(prompt);
                          inputRef.current?.focus();
                        }}
                        className="p-3 rounded-lg border border-[#1E2536] bg-[#0E121B] hover:border-[#00FFA3]/40 hover:bg-[#121620] text-xs text-[#D1D5DB] transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((message) => {
                  const isUser = message.role === "USER";
                  const isCurrentStreaming = message.id === streamingMessageId && isStreaming;
                  const displayContent = isCurrentStreaming
                    ? streamingContent || message.content
                    : message.content;

                  return (
                    <div
                      key={message.id}
                      className={cn(
                        "flex gap-3 max-w-3xl",
                        isUser ? "ml-auto justify-end" : "mr-auto justify-start"
                      )}
                    >
                      {/* Avatar */}
                      {!isUser && (
                        <div className="w-7 h-7 rounded-lg bg-[#00FFA3]/10 border border-[#00FFA3]/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Bot className="w-4 h-4 text-[#00FFA3]" />
                        </div>
                      )}

                      <div
                        className={cn(
                          "rounded-xl px-4 py-3 text-xs leading-relaxed max-w-[85%]",
                          isUser
                            ? "bg-[#1E293B] text-[#F8FAFC] border border-[#334155]"
                            : "bg-[#0E121B] border border-[#1E2536] text-[#D1D5DB] shadow-sm"
                        )}
                      >
                        {!isUser && (
                          <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#1E2536]/80 text-[11px] font-mono text-[#64748B]">
                            <span className="text-[#00E5FF]">{message.modelId || selectedModelId}</span>
                            {message.status === "STREAMING" && (
                              <span className="text-[#00FFA3] flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#00FFA3] animate-ping" />
                                Streaming
                              </span>
                            )}
                            {message.status === "CANCELLED" && (
                              <span className="text-amber-400">Stopped</span>
                            )}
                          </div>
                        )}

                        <MarkdownRenderer
                          content={displayContent}
                          isStreaming={isCurrentStreaming}
                        />

                        {/* Associated Tool Executions for this message */}
                        {!isUser && (
                          <ToolActivityTimeline
                            toolCalls={threadToolCalls.filter(
                              (tc) =>
                                (message.run && tc.generationRunId === message.run.id) ||
                                (message.id === streamingMessageId &&
                                  activeRun &&
                                  tc.generationRunId === activeRun.id)
                            )}
                          />
                        )}

                        {!isUser && message.status === "COMPLETED" && displayContent.trim().length > 0 && (
                          <div className="mt-2 pt-2 border-t border-[#1E2536]/60 flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => handleSaveMessageToMemory(message)}
                              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-[#8E9BB4] hover:bg-[#1E2536] hover:text-[#00F0FF] transition-colors"
                              title="Save insight to Long-Term Vector Memory"
                            >
                              <Database className="w-3 h-3" />
                              {savedMemoryMsgIds.has(message.id) ? "Saved to Memory" : "Remember"}
                            </button>
                          </div>
                        )}
                      </div>

                      {isUser && (
                        <div className="w-7 h-7 rounded-lg bg-[#3B82F6]/20 border border-[#3B82F6]/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <User className="w-4 h-4 text-[#60A5FA]" />
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* In-Flight Streaming Bubble if message not in list yet */}
              {isStreaming && !messages.some((m) => m.id === streamingMessageId) && (
                <div className="flex gap-3 max-w-3xl mr-auto justify-start">
                  <div className="w-7 h-7 rounded-lg bg-[#00FFA3]/10 border border-[#00FFA3]/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-[#00FFA3]" />
                  </div>
                  <div className="rounded-xl px-4 py-3 text-xs leading-relaxed max-w-[85%] bg-[#0E121B] border border-[#1E2536] text-[#D1D5DB]">
                    <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#1E2536]/80 text-[11px] font-mono text-[#64748B]">
                      <span className="text-[#00E5FF]">{selectedModelId}</span>
                      <span className="text-[#00FFA3] flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#00FFA3] animate-ping" />
                        Streaming
                      </span>
                    </div>
                    <MarkdownRenderer content={streamingContent} isStreaming={true} />
                    {activeRun && (
                      <ToolActivityTimeline
                        toolCalls={threadToolCalls.filter(
                          (tc) => tc.generationRunId === activeRun.id
                        )}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Pending Tool Approval Cards */}
              {pendingApprovals.map((approval) => (
                <div key={approval.id} className="flex justify-start max-w-3xl mr-auto pl-10">
                  <ToolApprovalCard
                    approvalId={approval.id}
                    toolCallId={approval.toolCallId}
                    toolName={approval.toolCall?.toolName || "tool"}
                    providerToolAlias={approval.toolCall?.providerToolAlias || ""}
                    connectionName={(approval.toolCall as any)?.connectionName}
                    endpointUrl={(approval.toolCall as any)?.endpointUrl}
                    aiProvider={
                      connections.find((c) => c.id === selectedConnectionId)?.displayName ||
                      connections.find((c) => c.id === selectedConnectionId)?.provider.toUpperCase() ||
                      "AI Provider"
                    }
                    isReadOnly={(approval.toolCall as any)?.isReadOnly}
                    argumentsPreview={
                      (approval.toolCall?.argumentsPreview as Record<string, unknown>) || {}
                    }
                    status={approval.status}
                    expiresAt={approval.expiresAt}
                    onApprove={handleApproveTool}
                    onDeny={handleDenyTool}
                  />
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>

            {/* Awaiting Approval Banner */}
            {pendingApprovals.some((a) => a.status === "PENDING") && (
              <div className="px-4 py-2 bg-amber-500/10 border-t border-amber-500/20 text-xs text-amber-300 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-amber-400 animate-pulse" />
                  <span>
                    Agent paused: Human approval required to execute external MCP tool.
                  </span>
                </div>
                <span className="font-mono text-[11px] text-amber-400/80">Single-use token • 5m TTL</span>
              </div>
            )}

            {/* Active Swarm Banner inside Chat */}
            {activeSwarmRun && (
              <div className="px-4 py-2 bg-[#00FFA3]/10 border-t border-[#00FFA3]/30 text-xs text-[#F0F4FC] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-[#00FFA3]" />
                  <span>
                    Multi-Agent Swarm Active ({selectedWorkerIds.length} workers coordinated)
                  </span>
                </div>
                <Link
                  href={`/swarms/${activeSwarmRun.id}`}
                  className="font-mono text-[11px] text-[#00FFA3] hover:underline"
                >
                  Open 3D Constellation →
                </Link>
              </div>
            )}

            {/* Bottom Composer Bar */}
            <div className="p-4 border-t border-[#1E2536] bg-[#0A0D14]">
              <div className="max-w-3xl mx-auto">
                {/* Single Agent vs Multi-Agent Swarm Mode Switch */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <div className="inline-flex rounded-lg border border-[#1E2536] bg-[#0E121B] p-0.5">
                    <button
                      type="button"
                      onClick={() => setExecutionMode("single")}
                      className={cn(
                        "px-2.5 py-1 rounded-md transition-colors",
                        executionMode === "single"
                          ? "bg-[#171D2B] text-[#F0F4FC] font-medium"
                          : "text-[#64748B] hover:text-[#CBD5E1]"
                      )}
                    >
                      Single Agent
                    </button>
                    <button
                      type="button"
                      onClick={() => setExecutionMode("swarm")}
                      className={cn(
                        "px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors",
                        executionMode === "swarm"
                          ? "bg-[#00FFA3]/15 text-[#00FFA3] font-medium"
                          : "text-[#64748B] hover:text-[#CBD5E1]"
                      )}
                    >
                      <Sparkles className="w-3 h-3" />
                      Multi-Agent Swarm
                    </button>
                  </div>

                  {executionMode === "swarm" && (
                    <div className="flex items-center gap-2 text-[#94A3B8]">
                      {workspaceAgents.length === 0 ? (
                        <Link href="/agents" className="text-[#00FFA3] hover:underline">
                          Configure agents in Registry →
                        </Link>
                      ) : (
                        <>
                          <select
                            value={selectedSupervisorId}
                            onChange={(e) => setSelectedSupervisorId(e.target.value)}
                            className="rounded border border-[#1E2536] bg-[#0E121B] px-2 py-1 text-[11px] text-[#F0F4FC]"
                          >
                            <option value="">Supervisor...</option>
                            {workspaceAgents
                              .filter((a) => a.canSupervise && a.status === "ACTIVE")
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  Lead: {a.name}
                                </option>
                              ))}
                          </select>
                          <span className="font-mono text-[10px] text-[#00FFA3]">
                            {selectedWorkerIds.length} workers ready
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="relative rounded-xl border border-[#1E2536] bg-[#0E121B] focus-within:border-[#00FFA3] transition-colors">
                  <textarea
                    ref={inputRef}
                    rows={2}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    placeholder={
                      connections.length === 0
                        ? "Connect an AI provider in Settings -> AI Integrations to start chatting..."
                        : `Message ${selectedModelId || "Messiah"}... (Enter to send, Shift+Enter for newline)`
                    }
                    disabled={connections.length === 0}
                    className="w-full resize-none bg-transparent px-4 py-3 text-xs text-[#F0F4FC] placeholder-[#64748B] focus:outline-none"
                  />

                  {/* Composer Footer Actions */}
                  <div className="flex items-center justify-between px-3 py-2 border-t border-[#1E2536]/50 text-[11px] text-[#64748B]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">
                        {selectedModelId ? `${selectedModelId}` : "No model"}
                      </span>
                      {selectedDeviceId && (
                        <span className="font-mono text-indigo-400">
                          • 💻 {pairedDevices.find((d) => d.id === selectedDeviceId)?.displayName || "Workstation"}
                        </span>
                      )}
                      {activeRun && activeRun.outputTokens ? (
                        <span className="font-mono text-[#8B949E]">
                          • {activeRun.inputTokens} in / {activeRun.outputTokens} out
                        </span>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      {isStreaming ? (
                        <Button
                          onClick={handleStopGeneration}
                          className="h-7 px-3 bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 text-xs flex items-center gap-1.5"
                        >
                          <Square className="w-3 h-3 fill-current" />
                          <span>Stop</span>
                        </Button>
                      ) : (
                        <Button
                          onClick={handleSendMessage}
                          disabled={!inputText.trim() || isSending || connections.length === 0}
                          className="h-7 px-3 bg-[#00FFA3] text-black hover:bg-[#00FFA3]/90 font-medium text-xs flex items-center gap-1.5 disabled:opacity-40"
                        >
                          {isSending ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <Send className="w-3 h-3" />
                          )}
                          <span>Send</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Thread Confirmation Modal */}
      {deletingThreadId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-[#1E2536] bg-[#0E121B] p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-[#F0F4FC]">Delete Conversation</h3>
            <p className="text-xs text-[#94A3B8]">
              Are you sure you want to delete this conversation thread? All messages and generation history will be permanently deleted.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setDeletingThreadId(null)}
                className="h-8 text-xs border-[#1E2536]"
              >
                Cancel
              </Button>
              <Button
                onClick={() => handleDeleteThread(deletingThreadId)}
                className="h-8 text-xs bg-red-600 hover:bg-red-700 text-white"
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
