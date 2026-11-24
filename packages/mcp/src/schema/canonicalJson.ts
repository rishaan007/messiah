import { createHash } from "node:crypto";

/**
 * Deterministically serializes any JavaScript object or primitive into a canonical JSON string
 * where all object keys are sorted recursively in lexicographical order.
 */
export function canonicalJsonStringify(val: unknown): string {
  if (val === null || val === undefined) {
    return "null";
  }

  if (typeof val === "boolean" || typeof val === "number") {
    return JSON.stringify(val);
  }

  if (typeof val === "string") {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    const items = val.map((item) => canonicalJsonStringify(item));
    return `[${items.join(",")}]`;
  }

  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
    return `{${pairs.join(",")}}`;
  }

  return JSON.stringify(val);
}

/**
 * Computes a deterministic SHA-256 hex digest of a JSON-serializable value.
 */
export function computeHash(val: unknown): string {
  const canonical = canonicalJsonStringify(val);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeSchemaHash(schema: unknown): string {
  return computeHash(schema || {});
}

export function computeArgumentsHash(args: unknown): string {
  return computeHash(args || {});
}
