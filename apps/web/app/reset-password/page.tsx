"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Terminal,
  Lock,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@messiah/ui";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!password || !confirmPassword) {
      setErrorMessage("Please complete both password fields.");
      return;
    }

    if (password.length < 8) {
      setErrorMessage("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setIsLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({
        password,
      });

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      setIsSuccess(true);
      setTimeout(() => {
        router.push("/");
        router.refresh();
      }, 2000);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to update password."
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

        {/* Reset Password Card */}
        <Card className="border-[#1E2536] bg-[#0E111A]/90 backdrop-blur-xl shadow-2xl">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg font-semibold tracking-tight text-[#F0F4FC]">
              Set New Password
            </CardTitle>
            <CardDescription className="text-xs text-[#64748B]">
              Choose a strong, unique password to secure your workspace.
            </CardDescription>
          </CardHeader>

          <CardContent>
            {isSuccess ? (
              <div className="space-y-4 py-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#00FFA3]/10 text-[#00FFA3]">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-[#F0F4FC]">
                    Password updated successfully
                  </h3>
                  <p className="text-xs text-[#94A3B8]">
                    Your password has been changed. Redirecting to workspace command center...
                  </p>
                </div>
              </div>
            ) : (
              <>
                {errorMessage && (
                  <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-[#FF3366]/30 bg-[#FF3366]/10 p-3 text-xs text-[#FF3366]">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="password"
                      className="block text-xs font-medium text-[#94A3B8]"
                    >
                      New password (min. 8 characters)
                    </label>
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
                        autoComplete="new-password"
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

                  <div className="space-y-1.5">
                    <label
                      htmlFor="confirmPassword"
                      className="block text-xs font-medium text-[#94A3B8]"
                    >
                      Confirm new password
                    </label>
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                        <Lock className="h-4 w-4 text-[#64748B]" />
                      </div>
                      <input
                        id="confirmPassword"
                        type={showPassword ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="••••••••••••"
                        autoComplete="new-password"
                        required
                        disabled={isLoading}
                        className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] py-2 pl-9 pr-3 text-xs text-[#F0F4FC] placeholder-[#64748B] transition-colors focus:border-[#00F0FF] focus:outline-none focus:ring-1 focus:ring-[#00F0FF] disabled:opacity-50"
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    variant="cyan"
                    size="md"
                    isLoading={isLoading}
                    className="w-full font-semibold"
                  >
                    Update Password
                  </Button>
                </form>

                <div className="mt-6 border-t border-[#1E2536] pt-4 text-center">
                  <Link
                    href="/login"
                    className="text-xs text-[#94A3B8] hover:text-[#00F0FF] transition-colors"
                  >
                    Cancel and return to Sign In
                  </Link>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
