import { createBrowserClient } from "@supabase/ssr";

/**
 * Creates an isolated browser Supabase client using public credentials.
 * Used exclusively in Client Components ('use client').
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be configured."
    );
  }

  return createBrowserClient(supabaseUrl, supabaseKey);
}
