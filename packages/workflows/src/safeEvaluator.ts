const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Safely resolves dot/bracket-free property paths like `steps.research.output.score`
 * from an untrusted execution context without allowing prototype pollution or code execution.
 */
export function resolveContextPath(context: Record<string, unknown>, pathStr: string): unknown {
  const clean = pathStr.trim();
  if (!clean) return undefined;
  const segments = clean.split(".");
  let current: unknown = context;

  for (const seg of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) {
      return undefined;
    }
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, seg)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }

  return current;
}

export function renderSafeTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, path) => {
    const val = resolveContextPath(context, String(path));
    if (val === undefined || val === null) return "";
    if (typeof val === "object") {
      try {
        return JSON.stringify(val);
      } catch {
        return "";
      }
    }
    return String(val);
  });
}

export function renderTemplateValue(
  input: unknown,
  context: Record<string, unknown>
): unknown {
  if (typeof input === "string") {
    return renderSafeTemplate(input, context);
  }
  if (Array.isArray(input)) {
    return input.map((item) => renderTemplateValue(item, context));
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (FORBIDDEN_PATH_SEGMENTS.has(k)) continue;
      out[k] = renderTemplateValue(v, context);
    }
    return out;
  }
  return input;
}

const FORBIDDEN_EXPR_KEYWORDS = /\b(eval|Function|require|import|process|global|globalThis|window|__proto__|constructor|prototype)\b/;

/**
 * Evaluates declarative boolean condition expressions with ZERO eval/Function execution.
 * Supports:
 * - Logical grouping: `(...)`, `&&`, `||`, `!`
 * - Unary checks: `exists <path>`, truthy `<path>`
 * - Comparisons: `<path> == <literal|path>`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `startsWith`
 */
export class SafeExpressionEvaluator {
  public static validateSyntax(expr: string): { valid: boolean; error?: string } {
    const trimmed = expr.trim();
    if (!trimmed) {
      return { valid: false, error: "Condition expression cannot be empty." };
    }
    if (FORBIDDEN_EXPR_KEYWORDS.test(trimmed)) {
      return {
        valid: false,
        error: "Condition contains forbidden code-execution or prototype keywords.",
      };
    }
    if (trimmed.length > 1000) {
      return { valid: false, error: "Condition expression exceeds maximum length (1000 chars)." };
    }
    try {
      this.evaluate(trimmed, { trigger: { payload: {} }, steps: {} });
      return { valid: true };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Invalid expression syntax",
      };
    }
  }

  public static evaluate(expr: string, context: Record<string, unknown>): boolean {
    const trimmed = expr.trim();
    if (!trimmed) return false;
    if (FORBIDDEN_EXPR_KEYWORDS.test(trimmed)) {
      throw new Error("Unsafe keyword detected in condition expression.");
    }

    const tokens = this.tokenize(trimmed);
    let pos = 0;

    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    const parseOr = (): boolean => {
      let left = parseAnd();
      while (peek()?.type === "OR") {
        consume();
        const right = parseAnd();
        left = left || right;
      }
      return left;
    };

    const parseAnd = (): boolean => {
      let left = parseNot();
      while (peek()?.type === "AND") {
        consume();
        const right = parseNot();
        left = left && right;
      }
      return left;
    };

    const parseNot = (): boolean => {
      if (peek()?.type === "NOT") {
        consume();
        return !parseNot();
      }
      return parsePrimary();
    };

    const parseOperand = (): unknown => {
      const tok = consume();
      if (!tok) throw new Error("Unexpected end of condition expression.");
      if (tok.type === "STRING") return tok.value;
      if (tok.type === "NUMBER") return Number(tok.value);
      if (tok.type === "BOOLEAN") return tok.value === "true";
      if (tok.type === "NULL") return null;
      if (tok.type === "IDENT") return resolveContextPath(context, tok.value);
      throw new Error(`Unexpected token '${tok.value}' while parsing operand`);
    };

    const parsePrimary = (): boolean => {
      const next = peek();
      if (!next) throw new Error("Unexpected end of condition expression.");

      if (next.type === "LPAREN") {
        consume();
        const res = parseOr();
        if (peek()?.type !== "RPAREN") {
          throw new Error("Missing closing parenthesis ')' in condition expression.");
        }
        consume();
        return res;
      }

      if (next.type === "IDENT" && next.value === "exists") {
        consume();
        const val = parseOperand();
        return val !== undefined && val !== null;
      }

      const leftVal = parseOperand();
      const opTok = peek();

      if (opTok && opTok.type === "OP") {
        consume();
        const rightVal = parseOperand();
        return this.compareValues(leftVal, opTok.value, rightVal);
      }

      return Boolean(leftVal);
    };

    const result = parseOr();
    if (pos < tokens.length) {
      throw new Error(`Unexpected trailing token '${tokens[pos]?.value}' in expression.`);
    }
    return result;
  }

  private static compareValues(left: unknown, op: string, right: unknown): boolean {
    switch (op) {
      case "==":
      case "===":
        return left === right || String(left ?? "") === String(right ?? "");
      case "!=":
      case "!==":
        return left !== right && String(left ?? "") !== String(right ?? "");
      case ">":
        return Number(left) > Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<":
        return Number(left) < Number(right);
      case "<=":
        return Number(left) <= Number(right);
      case "contains": {
        if (Array.isArray(left)) return left.includes(right);
        return String(left ?? "").toLowerCase().includes(String(right ?? "").toLowerCase());
      }
      case "startsWith":
        return String(left ?? "").toLowerCase().startsWith(String(right ?? "").toLowerCase());
      default:
        throw new Error(`Unsupported comparison operator '${op}'`);
    }
  }

  private static tokenize(
    expr: string
  ): Array<{
    type: "LPAREN" | "RPAREN" | "AND" | "OR" | "NOT" | "OP" | "STRING" | "NUMBER" | "BOOLEAN" | "NULL" | "IDENT";
    value: string;
  }> {
    const tokens: Array<{
      type: "LPAREN" | "RPAREN" | "AND" | "OR" | "NOT" | "OP" | "STRING" | "NUMBER" | "BOOLEAN" | "NULL" | "IDENT";
      value: string;
    }> = [];
    let i = 0;

    while (i < expr.length) {
      const ch = expr.charAt(i);
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === "(") {
        tokens.push({ type: "LPAREN", value: "(" });
        i++;
        continue;
      }
      if (ch === ")") {
        tokens.push({ type: "RPAREN", value: ")" });
        i++;
        continue;
      }
      if (expr.startsWith("&&", i)) {
        tokens.push({ type: "AND", value: "&&" });
        i += 2;
        continue;
      }
      if (expr.startsWith("||", i)) {
        tokens.push({ type: "OR", value: "||" });
        i += 2;
        continue;
      }
      if (expr.startsWith("===", i) || expr.startsWith("!==", i)) {
        tokens.push({ type: "OP", value: expr.slice(i, i + 3) });
        i += 3;
        continue;
      }
      if (
        expr.startsWith("==", i) ||
        expr.startsWith("!=", i) ||
        expr.startsWith(">=", i) ||
        expr.startsWith("<=", i)
      ) {
        tokens.push({ type: "OP", value: expr.slice(i, i + 2) });
        i += 2;
        continue;
      }
      if (ch === ">" || ch === "<") {
        tokens.push({ type: "OP", value: ch });
        i++;
        continue;
      }
      if (ch === "!") {
        tokens.push({ type: "NOT", value: "!" });
        i++;
        continue;
      }
      if (ch === `"` || ch === `'`) {
        const quote = ch;
        i++;
        let str = "";
        while (i < expr.length && expr[i] !== quote) {
          if (expr[i] === "\\" && i + 1 < expr.length) {
            i++;
          }
          str += expr[i++];
        }
        if (expr[i] !== quote) {
          throw new Error("Unterminated string literal in condition expression.");
        }
        i++;
        tokens.push({ type: "STRING", value: str });
        continue;
      }
      const numMatch = expr.slice(i).match(/^-?\d+(?:\.\d+)?(?=\s|\)|$|&|\|)/);
      if (numMatch) {
        tokens.push({ type: "NUMBER", value: numMatch[0] });
        i += numMatch[0].length;
        continue;
      }
      const identMatch = expr.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_.-]*/);
      if (identMatch) {
        const word = identMatch[0];
        i += word.length;
        if (word === "true" || word === "false") {
          tokens.push({ type: "BOOLEAN", value: word });
        } else if (word === "null") {
          tokens.push({ type: "NULL", value: "null" });
        } else if (word === "contains" || word === "startsWith") {
          tokens.push({ type: "OP", value: word });
        } else {
          tokens.push({ type: "IDENT", value: word });
        }
        continue;
      }
      throw new Error(`Unexpected character '${ch}' at position ${i} in condition expression.`);
    }

    return tokens;
  }
}

export class SafeTransformEngine {
  public static runTransform(
    config: Record<string, unknown>,
    context: Record<string, unknown>
  ): Record<string, unknown> {
    const mode = String(config.mode || "template");

    if (mode === "extract") {
      const path = String(config.extractPath || "steps");
      const value = resolveContextPath(context, path);
      return { result: value ?? null };
    }

    if (mode === "pick") {
      const mapping = (config.fieldMapping as Record<string, string>) || {};
      const out: Record<string, unknown> = {};
      for (const [outKey, exprPath] of Object.entries(mapping)) {
        if (FORBIDDEN_PATH_SEGMENTS.has(outKey)) continue;
        out[outKey] = typeof exprPath === "string" && exprPath.includes("{{")
          ? renderSafeTemplate(exprPath, context)
          : resolveContextPath(context, String(exprPath));
      }
      return { result: out };
    }

    const template = String(config.template || "");
    return { result: renderSafeTemplate(template, context) };
  }
}
