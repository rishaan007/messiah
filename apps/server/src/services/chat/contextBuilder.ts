import type { ProviderChatMessage } from "@messiah/providers";
import type { Message } from "@messiah/db";

export interface ContextBuilderOptions {
  maxTurns?: number;
  maxContentChars?: number;
  systemPrompt?: string;
}

export class ContextBuilder {
  /**
   * Constructs sanitized, normalized conversation history for AI provider submission.
   * Excludes internal metadata, database IDs, and non-completed turns.
   */
  public static buildHistory(
    priorMessages: Message[],
    currentPrompt: string,
    options: ContextBuilderOptions = {}
  ): { messages: ProviderChatMessage[]; systemPrompt?: string } {
    const maxTurns = options.maxTurns || 30;
    const maxChars = options.maxContentChars || 16000;

    // Filter to only completed turns and sort by sequence
    const completedMessages = priorMessages
      .filter((m) => m.status === "COMPLETED" && (m.role === "USER" || m.role === "ASSISTANT"))
      .sort((a, b) => a.sequence - b.sequence);

    // Take the most recent turns within maxTurns limit
    const recentMessages = completedMessages.slice(-maxTurns);

    const formattedMessages: ProviderChatMessage[] = [];

    for (const msg of recentMessages) {
      // Truncate individual message if unreasonably large
      const safeContent =
        msg.content.length > maxChars
          ? msg.content.substring(0, maxChars) + "\n[Content truncated for context window]"
          : msg.content;

      formattedMessages.push({
        role: msg.role === "USER" ? "user" : "assistant",
        content: safeContent,
      });
    }

    // Append the new incoming user prompt
    formattedMessages.push({
      role: "user",
      content: currentPrompt,
    });

    return {
      messages: formattedMessages,
      systemPrompt: options.systemPrompt?.trim() || undefined,
    };
  }
}
