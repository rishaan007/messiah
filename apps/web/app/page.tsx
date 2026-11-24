"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  Server,
  Database,
  Cpu,
  Bot,
  Laptop2,
  Clock,
  Sparkles,
  RefreshCw,
  CheckCircle2,
  Key,
  MessageSquare,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  EmptyState,
  Badge,
  StatusDot,
  Button,
} from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";

interface HealthData {
  status: string;
  timestamp: string;
  version: string;
  checks?: {
    database?: { status: string; latencyMs?: number; message?: string };
    redis?: { status: string; latencyMs?: number; message?: string };
  };
}

export default function DashboardPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const fetchHealth = async () => {
    setIsLoadingHealth(true);
    setHealthError(null);
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    try {
      const res = await fetch(`${apiUrl}/health/ready`, { cache: "no-store" });
      const data = await res.json();
      setHealthData(data);
    } catch {
      setHealthError("Unable to connect to Fastify backend on " + apiUrl);
    } finally {
      setIsLoadingHealth(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  return (
    <div className="flex h-screen flex-col bg-[#090A0F] text-[#F0F4FC]">
      <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
        />

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mx-auto max-w-7xl space-y-8">
            {/* Command Center Title Header */}
            <div className="flex flex-col justify-between gap-4 border-b border-[#1E2536] pb-6 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-xl md:text-2xl font-bold tracking-tight text-[#F0F4FC]">
                    AI Command Center
                  </h1>
                  <Badge variant="cyan">Phase 1B Authenticated</Badge>
                </div>
                <p className="text-xs text-[#94A3B8]">
                  One intelligence layer. Every agent. Every device.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Link href="/chat">
                  <Button variant="cyan" size="sm" className="font-mono text-xs font-semibold bg-[#00FFA3] text-black hover:bg-[#00FFA3]/90">
                    <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                    Launch Chat
                  </Button>
                </Link>
                <Link href="/settings/integrations">
                  <Button variant="cyan" size="sm" className="font-mono text-xs font-semibold">
                    <Key className="h-3.5 w-3.5 mr-1.5" />
                    AI Integrations
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchHealth}
                  isLoading={isLoadingHealth}
                  className="font-mono text-xs"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Poll Probes
                </Button>
              </div>
            </div>

            {/* Infrastructure Health Status Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-mono uppercase tracking-wider text-[#64748B]">
                  Platform Infrastructure Probes
                </h2>
                <span className="text-[11px] font-mono text-[#94A3B8]">
                  PostgreSQL 16 · Redis 7.2 · Fastify 5
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {/* 1. Fastify Gateway Card */}
                <Card className="hover:border-[#00F0FF]/30 transition-all">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#F0F4FC]">
                        <Server className="h-4 w-4 text-[#00F0FF]" />
                        <span>API Gateway</span>
                      </div>
                      <StatusDot
                        status={
                          healthData ? "online" : healthError ? "error" : "busy"
                        }
                        pulse
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-[#64748B]">Engine:</span>
                        <span className="text-[#94A3B8]">Fastify v5.2</span>
                      </div>
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-[#64748B]">Status:</span>
                        <span
                          className={
                            healthData ? "text-[#00FFA3]" : "text-[#FF3366]"
                          }
                        >
                          {healthData
                            ? "Active / 200 OK"
                            : healthError
                              ? "Unreachable"
                              : "Probing..."}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* 2. PostgreSQL Relational Store Card */}
                <Card className="hover:border-[#00FFA3]/30 transition-all">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#F0F4FC]">
                        <Database className="h-4 w-4 text-[#00FFA3]" />
                        <span>PostgreSQL Store</span>
                      </div>
                      <StatusDot
                        status={
                          healthData?.checks?.database?.status === "healthy"
                            ? "online"
                            : "offline"
                        }
                        pulse={
                          healthData?.checks?.database?.status === "healthy"
                        }
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-[#64748B]">ORM Client:</span>
                        <span className="text-[#94A3B8]">Prisma v6</span>
                      </div>
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-[#64748B]">Latency:</span>
                        <span className="text-[#00FFA3]">
                          {healthData?.checks?.database?.latencyMs !== undefined
                            ? `${healthData.checks.database.latencyMs} ms`
                            : "N/A"}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* 3. Redis Ephemeral Engine Card */}
                <Card className="hover:border-[#FFB800]/30 transition-all">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#F0F4FC]">
                        <Cpu className="h-4 w-4 text-[#FFB800]" />
                        <span>Redis Ephemeral</span>
                      </div>
                      <StatusDot
                        status={
                          healthData?.checks?.redis?.status === "healthy"
                            ? "online"
                            : "offline"
                        }
                        pulse={healthData?.checks?.redis?.status === "healthy"}
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-[#64748B]">Role:</span>
                        <span className="text-[#94A3B8]">
                          Pub/Sub & Heartbeat
                        </span>
                      </div>
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-[#64748B]">Latency:</span>
                        <span className="text-[#00FFA3]">
                          {healthData?.checks?.redis?.latencyMs !== undefined
                            ? `${healthData.checks.redis.latencyMs} ms`
                            : "N/A"}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Real Empty States Grid (No fabricated mock items) */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-mono uppercase tracking-wider text-[#64748B]">
                  Workspace Domains (Awaiting Phase Implementations)
                </h2>
                <span className="text-[11px] text-[#64748B]">
                  0 Connected Entities
                </span>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {/* Real Empty State: Agents */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Bot className="h-4 w-4 text-[#00F0FF]" />
                      Agent Fleet
                    </CardTitle>
                    <CardDescription>
                      Autonomous personas and supervisor loops.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <EmptyState
                      icon={<Bot className="h-6 w-6 text-[#64748B]" />}
                      title="No Agents Registered"
                      description="AI models (OpenAI, Anthropic, Gemini, Ollama) and personas will be configured in Phase 2."
                      badge="Phase 2 Scope"
                    />
                  </CardContent>
                </Card>

                {/* Real Empty State: Devices & Local Bridges */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Laptop2 className="h-4 w-4 text-[#00FFA3]" />
                      Local Bridges
                    </CardTitle>
                    <CardDescription>
                      Connected developer machines and execution daemons.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <EmptyState
                      icon={<Laptop2 className="h-6 w-6 text-[#64748B]" />}
                      title="No Enrolled Devices"
                      description="Outbound TLS WebSocket pairing for macOS, Windows, and Linux will be integrated in Phase 4."
                      badge="Phase 4 Scope"
                    />
                  </CardContent>
                </Card>

                {/* Real Empty State: Task Stream */}
                <Card className="md:col-span-2 lg:col-span-1">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Clock className="h-4 w-4 text-[#FFB800]" />
                      Execution Queue
                    </CardTitle>
                    <CardDescription>
                      Durable background task and reasoning transcripts.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <EmptyState
                      icon={<Clock className="h-6 w-6 text-[#64748B]" />}
                      title="Queue Idle"
                      description="Task execution pipeline with BullMQ checkpointing and cooperative cancellation active in Phase 3."
                      badge="Phase 3 Scope"
                    />
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Architecture Governance Footer Card */}
            <Card className="border-[#1E2536] bg-[#0E111A]/60">
              <CardContent className="p-4 sm:p-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-[#00FFA3]" />
                      <span className="text-xs font-semibold text-[#F0F4FC]">
                        Phase 1B Zero-Trust Authentication & Workspaces Active
                      </span>
                    </div>
                    <p className="text-xs text-[#94A3B8]">
                      Turborepo monorepo, Fastify 5 modular backend, Next.js 16
                      command center, Supabase Auth external identity, and
                      isolated workspaces verified.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-mono text-[#64748B]">
                    <Sparkles className="h-3.5 w-3.5 text-[#00F0FF]" />
                    <span>MESSIAH v0.1.0-alpha</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
