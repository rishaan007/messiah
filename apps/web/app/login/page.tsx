"use client";

import React, { useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Terminal, Lock, Mail, Eye, EyeOff, AlertCircle } from "lucide-react";
import { Button, Card, CardHeader, CardTitle, CardDescription, CardContent } from "@messiah/ui";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "/";
  const authError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    authError === "invalid_auth_code"
      ? "Authentication link expired or is invalid. Please sign in again."
      : null
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!email.trim() || !password) {
      setErrorMessage("Please enter both email and password.");
      return;
    }

    setIsLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      router.push(redirectPath);
      router.refresh();
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "An unexpected error occurred during sign in."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#090A0F] px-4 py-12 text-[#F0F4FC]">
      <div className="w-full max-w-md space-y-6">
        {/* Brand Header */}
        <div className="flex flex-col items-center space-y-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-[#00F0FF] to-[#0080FF] shadow-[0_0_25px_rgba(0,240,255,0.4)]">
            <Terminal className="h-6 w-6 text-[#090A0F]" />
          </div>
          <h1 className="font-mono text-2xl font-bold tracking-widest text-[#F0F4FC]">
            MESSIAH
          </h1>
          <p className="text-xs text-[#94A3B8]">
            One intelligence layer. Every agent. Every device.
          </p>
        </div>

        {/* Login Card */}
        <Card className="border-[#1E2536] bg-[#0E111A]/90 backdrop-blur-xl shadow-2xl">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg font-semibold tracking-tight text-[#F0F4FC]">
              Sign in to Workspace
            </CardTitle>
            <CardDescription className="text-xs text-[#64748B]">
              Enter your credentials to access your autonomous agent cluster.
            </CardDescription>
          </CardHeader>

          <CardContent>
            {errorMessage && (
              <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-[#FF3366]/30 bg-[#FF3366]/10 p-3 text-xs text-[#FF3366]">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="email"
                  className="block text-xs font-medium text-[#94A3B8]"
                >
                  Email address
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Mail className="h-4 w-4 text-[#64748B]" />
                  </div>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="architect@domain.com"
                    autoComplete="email"
                    required
                    disabled={isLoading}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] py-2 pl-9 pr-3 text-xs text-[#F0F4FC] placeholder-[#64748B] transition-colors focus:border-[#00F0FF] focus:outline-none focus:ring-1 focus:ring-[#00F0FF] disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="password"
                    className="block text-xs font-medium text-[#94A3B8]"
                  >
                    Password
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-[11px] font-mono text-[#00F0FF] hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Lock className="h-4 w-4 text-[#64748B]" />
                  </div>
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    autoComplete="current-password"
                    required
                    disabled={isLoading}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] py-2 pl-9 pr-9 text-xs text-[#F0F4FC] placeholder-[#64748B] transition-colors focus:border-[#00F0FF] focus:outline-none focus:ring-1 focus:ring-[#00F0FF] disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-[#64748B] hover:text-[#94A3B8]"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                variant="cyan"
                size="md"
                isLoading={isLoading}
                className="w-full font-semibold"
              >
                Sign In
              </Button>
            </form>

            <div className="mt-6 border-t border-[#1E2536] pt-4 text-center">
              <p className="text-xs text-[#64748B]">
                Don&apos;t have an account?{" "}
                <Link
                  href="/signup"
                  className="font-medium text-[#00F0FF] hover:underline"
                >
                  Create one now
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Security Notice */}
        <p className="text-center font-mono text-[10px] text-[#64748B]">
          Zero-Trust Authentication · Supabase Auth & JWT Verified
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#090A0F] text-[#64748B]">
          <span className="font-mono text-xs">Loading authentication interface...</span>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
