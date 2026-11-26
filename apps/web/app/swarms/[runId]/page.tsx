import { SwarmWorkspace } from "@/components/swarms/SwarmWorkspace";

export default async function SwarmRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <SwarmWorkspace initialRunId={runId} />;
}
