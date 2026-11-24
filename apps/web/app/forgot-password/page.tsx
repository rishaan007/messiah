"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Terminal, Mail, AlertCircle, CheckCircle2, ArrowLeft } from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@messiah/ui";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!email.trim()) {
      setErrorMessage("Please enter your email address.");
      return;
    }

    setIsLoading(true);

    try {
      const supabase = createClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;

      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo,
      });

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      setIsSuccess(true);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to initiate password reset."
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

        {/* Reset Request Card */}
        <Card className="border-[#1E2536] bg-[#0E111A]/90 backdrop-blur-xl shadow-2xl">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg font-semibold tracking-tight text-[#F0F4FC]">
              Reset Password
            </CardTitle>
            <CardDescription className="text-xs text-[#64748B]">
              Enter your verified email to receive secure recovery instructions.
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
                    Recovery email dispatched
                  </h3>
                  <p className="text-xs text-[#94A3B8]">
                    If an account exists for{" "}
                    <span className="font-mono text-[#00F0FF]">{email}</span>, you will receive an encrypted reset link shortly.
                  </p>
                </div>
                <div className="pt-2">
                  <Link href="/login">
                    <Button variant="outline" size="sm" className="w-full">
                      <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                      Back to Sign In
                    </Button>
                  </Link>
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
                      htmlFor="email"
                      className="block text-xs font-medium text-[#94A3B8]"
                    >
                      Registered email address
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
                        placeholder="user@domain.com"
                        autoComplete="email"
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
                    Send Reset Link
                  </Button>
                </form>

                <div className="mt-6 border-t border-[#1E2536] pt-4 text-center">
                  <Link
                    href="/login"
                    className="inline-flex items-center gap-1.5 text-xs text-[#94A3B8] hover:text-[#00F0FF] transition-colors"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to Sign In
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
