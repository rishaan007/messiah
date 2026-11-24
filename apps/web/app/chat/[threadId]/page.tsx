import { ChatWorkspace } from "@/components/ChatWorkspace";

export const metadata = {
  title: "Universal AI Chat | Messiah",
  description: "One intelligence layer. Every agent. Every device.",
};

export default async function ThreadChatPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  return <ChatWorkspace initialThreadId={threadId} />;
}
