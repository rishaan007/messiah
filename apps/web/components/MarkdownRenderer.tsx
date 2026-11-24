"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

/**
 * Validates whether a link URL is safe to render in an <a> tag using an explicit protocol allowlist.
 * Only permits: http:, https:, mailto:, and explicit relative internal paths (/ , # , ./ , ../).
 * Rejects any protocol-relative (//), non-allowlisted protocols, or URLs with control characters.
 */
export function isSafeUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  // Reject control characters, line breaks, or null bytes
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return false;
  }

  // Reject protocol-relative URLs (e.g. //evil.com)
  if (trimmed.startsWith("//")) {
    return false;
  }

  // Allow explicit safe relative paths
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return true;
  }

  // Parse as absolute URL and strictly validate against explicit protocol allowlist
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

/**
 * Escapes potentially dangerous raw HTML angle brackets so they render as inert text.
 */
export function sanitizeRawHtml(text: string): string {
  return text.replace(/<(?:\/?[a-zA-Z][^>]*)>/g, (tag) => {
    return tag.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  });
}

export function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  return (
    <div className="prose prose-invert max-w-none text-sm leading-relaxed text-[#D1D5DB] space-y-3">
      {parseMarkdownBlocks(content)}
      {isStreaming && (
        <span className="inline-block w-2 h-4 ml-1 bg-[#00FFA3] animate-pulse align-middle" />
      )}
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-lg border border-[#1E2536] bg-[#0A0D14] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#1E2536] bg-[#121620] text-xs font-mono text-[#8B949E]">
        <span className="uppercase">{language || "text"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#1E2536] hover:text-[#F0F4FC] transition-colors"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-[#00FFA3]" />
              <span className="text-[11px] text-[#00FFA3]">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span className="text-[11px]">Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-xs font-mono text-[#E6EDF3] leading-5 whitespace-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function renderInlineFormatting(text: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  let remaining = text;
  let keyIdx = 0;

  while (remaining.length > 0) {
    // 1. Check for markdown links: [link text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch && linkMatch[1] !== undefined && linkMatch[2] !== undefined) {
      const linkText = linkMatch[1];
      const linkUrl = linkMatch[2];

      if (isSafeUrl(linkUrl)) {
        tokens.push(
          <a
            key={`link-${keyIdx++}`}
            href={linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#00FFA3] hover:underline underline-offset-2 transition-colors"
          >
            {linkText}
          </a>
        );
      } else {
        // Disallowed protocol (e.g. javascript: or data:): Render as safe inert text
        tokens.push(
          <span key={`unsafe-link-${keyIdx++}`} className="text-[#8B949E] underline line-through">
            {linkText}
          </span>
        );
      }
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // 2. Check for inline code `...`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch && codeMatch[1] !== undefined) {
      tokens.push(
        <code
          key={`code-${keyIdx++}`}
          className="px-1.5 py-0.5 rounded bg-[#1A202C] text-[#00E5FF] font-mono text-[12px] border border-[#2D3748]"
        >
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 3. Check for bold **...**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch && boldMatch[1] !== undefined) {
      tokens.push(
        <strong key={`bold-${keyIdx++}`} className="font-semibold text-[#F0F4FC]">
          {boldMatch[1]}
        </strong>
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 4. Check for italic *...*
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch && italicMatch[1] !== undefined) {
      tokens.push(
        <em key={`italic-${keyIdx++}`} className="italic text-[#E2E8F0]">
          {italicMatch[1]}
        </em>
      );
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Find next delimiter ([ for link, ` for code, * for bold/italic)
    const nextIdx = remaining.search(/[\[`*]/);
    if (nextIdx === -1) {
      tokens.push(remaining);
      break;
    } else if (nextIdx === 0) {
      tokens.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      tokens.push(remaining.slice(0, nextIdx));
      remaining = remaining.slice(nextIdx);
    }
  }

  return <>{tokens}</>;
}

export function parseMarkdownBlocks(markdown: string): React.ReactNode[] {
  if (!markdown) return [];

  const lines = markdown.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      i++;
      continue;
    }

    // 1. Code blocks: ```lang ... ```
    if (rawLine.trim().startsWith("```")) {
      const language = rawLine.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const curLine = lines[i];
        if (curLine === undefined || curLine.trim().startsWith("```")) {
          break;
        }
        codeLines.push(curLine);
        i++;
      }
      i++; // Skip closing ```
      nodes.push(
        <CodeBlock
          key={`codeblock-${blockKey++}`}
          language={language}
          code={codeLines.join("\n")}
        />
      );
      continue;
    }

    // Sanitize non-code block lines to prevent raw HTML injection
    const line = sanitizeRawHtml(rawLine);

    // 2. Headings
    if (line.startsWith("### ")) {
      nodes.push(
        <h3 key={`h3-${blockKey++}`} className="text-base font-semibold text-[#F0F4FC] mt-3 mb-1">
          {renderInlineFormatting(line.slice(4))}
        </h3>
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      nodes.push(
        <h2 key={`h2-${blockKey++}`} className="text-lg font-bold text-[#F0F4FC] mt-4 mb-2">
          {renderInlineFormatting(line.slice(3))}
        </h2>
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      nodes.push(
        <h1 key={`h1-${blockKey++}`} className="text-xl font-bold text-[#F0F4FC] mt-4 mb-2">
          {renderInlineFormatting(line.slice(2))}
        </h1>
      );
      i++;
      continue;
    }

    // 3. Blockquotes
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [line.slice(2)];
      i++;
      while (i < lines.length) {
        const curLine = lines[i];
        if (curLine === undefined || !curLine.startsWith("> ")) {
          break;
        }
        quoteLines.push(sanitizeRawHtml(curLine).slice(2));
        i++;
      }
      nodes.push(
        <blockquote
          key={`quote-${blockKey++}`}
          className="border-l-2 border-[#00FFA3] pl-3 py-1 my-2 bg-[#0F1420]/60 rounded-r text-[#94A3B8] italic"
        >
          {quoteLines.map((ql, qidx) => (
            <p key={qidx}>{renderInlineFormatting(ql)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // 4. Bullet lists
    if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
      const listItems: string[] = [];
      while (i < lines.length) {
        const curLine = lines[i];
        if (curLine === undefined || (!curLine.trim().startsWith("- ") && !curLine.trim().startsWith("* "))) {
          break;
        }
        listItems.push(sanitizeRawHtml(curLine).trim().slice(2));
        i++;
      }
      nodes.push(
        <ul key={`ul-${blockKey++}`} className="list-disc list-inside space-y-1 my-2 text-[#D1D5DB]">
          {listItems.map((item, lidx) => (
            <li key={lidx}>{renderInlineFormatting(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // 5. Numbered lists
    if (/^\d+\.\s/.test(line.trim())) {
      const listItems: string[] = [];
      while (i < lines.length) {
        const curLine = lines[i];
        if (curLine === undefined || !/^\d+\.\s/.test(curLine.trim())) {
          break;
        }
        listItems.push(sanitizeRawHtml(curLine).trim().replace(/^\d+\.\s/, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${blockKey++}`} className="list-decimal list-inside space-y-1 my-2 text-[#D1D5DB]">
          {listItems.map((item, lidx) => (
            <li key={lidx}>{renderInlineFormatting(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 6. Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Standard paragraph
    nodes.push(
      <p key={`p-${blockKey++}`} className="my-1.5 leading-relaxed">
        {renderInlineFormatting(line)}
      </p>
    );
    i++;
  }

  return nodes;
}
