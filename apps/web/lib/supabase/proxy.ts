import { updateSession } from "./middleware";
import type { NextRequest } from "next/server";

/**
 * Next.js 16 Proxy Session Handler.
 * Proxies request through Supabase authentication session refresh.
 */
export async function proxyAuthSession(request: NextRequest) {
  return updateSession(request);
}

export { updateSession };
