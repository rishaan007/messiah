export interface OfflineChatDraft {
  threadId: string;
  content: string;
  updatedAt: string;
}

const DRAFT_PREFIX = "messiah:draft:";

export function saveOfflineDraft(threadId: string, content: string): void {
  if (typeof window === "undefined" || !threadId) return;
  try {
    const clean = content.trim();
    if (!clean) {
      window.localStorage.removeItem(`${DRAFT_PREFIX}${threadId}`);
      return;
    }
    const payload: OfflineChatDraft = {
      threadId,
      content: clean,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(`${DRAFT_PREFIX}${threadId}`, JSON.stringify(payload));
  } catch {
    // Ignore storage quota restrictions safely
  }
}

export function loadOfflineDraft(threadId: string): OfflineChatDraft | null {
  if (typeof window === "undefined" || !threadId) return null;
  try {
    const raw = window.localStorage.getItem(`${DRAFT_PREFIX}${threadId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OfflineChatDraft;
    if (typeof parsed?.content !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearOfflineDraft(threadId: string): void {
  if (typeof window === "undefined" || !threadId) return;
  try {
    window.localStorage.removeItem(`${DRAFT_PREFIX}${threadId}`);
  } catch {}
}
