import { Ajv, type ValidateFunction, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

export interface ToolValidationResult {
  valid: boolean;
  errors?: string[];
}

export const MAX_ARGUMENTS_SIZE_BYTES = 64 * 1024; // 64 KB
export const MAX_SCHEMA_DEPTH = 10;

/**
 * Checks whether an object or schema exceeds the maximum allowed nesting depth.
 */
export function getObjectDepth(val: unknown, currentDepth = 0): number {
  if (currentDepth > MAX_SCHEMA_DEPTH) {
    return currentDepth;
  }
  if (val === null || typeof val !== "object") {
    return currentDepth;
  }
  let max = currentDepth;
  if (Array.isArray(val)) {
    for (const item of val) {
      max = Math.max(max, getObjectDepth(item, currentDepth + 1));
      if (max > MAX_SCHEMA_DEPTH) return max;
    }
  } else {
    for (const key of Object.keys(val as Record<string, unknown>)) {
      max = Math.max(max, getObjectDepth((val as Record<string, unknown>)[key], currentDepth + 1));
      if (max > MAX_SCHEMA_DEPTH) return max;
    }
  }
  return max;
}

/**
 * Inspects a JSON Schema recursively to reject remote references ($ref pointing to URLs).
 */
export function hasRemoteRef(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;

  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    const ref = s.$ref.trim().toLowerCase();
    if (
      ref.startsWith("http://") ||
      ref.startsWith("https://") ||
      ref.startsWith("ftp://") ||
      ref.startsWith("//")
    ) {
      return true;
    }
  }

  for (const key of Object.keys(s)) {
    if (hasRemoteRef(s[key])) {
      return true;
    }
  }

  return false;
}

export class ToolSchemaValidator {
  private ajv: Ajv;
  private compiledValidators = new Map<string, ValidateFunction>();

  constructor() {
    // Instantiate Ajv with strict security settings
    // - allErrors: collect all schema validation errors
    // - strict: false to allow standard draft/custom annotations without throwing compile errors
    // - loadSchema: undefined (disallows async remote loading)
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
    });
    // Add standard formats (email, uri, date-time, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (addFormats as any)(this.ajv);
  }

  /**
   * Validates tool invocation arguments against a tool's declared JSON Schema.
   */
  public validateArguments(
    inputSchema: Record<string, unknown>,
    rawArguments: unknown,
    schemaHash?: string
  ): ToolValidationResult {
    // 1. Check arguments byte size
    const jsonStr = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {});
    const byteLength = Buffer.byteLength(jsonStr, "utf8");
    if (byteLength > MAX_ARGUMENTS_SIZE_BYTES) {
      return {
        valid: false,
        errors: [`Argument payload size (${byteLength} bytes) exceeds maximum allowed limit of ${MAX_ARGUMENTS_SIZE_BYTES} bytes.`],
      };
    }

    // 2. Parse arguments if provided as string
    let parsedArgs: unknown = rawArguments;
    if (typeof rawArguments === "string") {
      try {
        parsedArgs = JSON.parse(rawArguments);
      } catch (err) {
        return {
          valid: false,
          errors: [`Invalid JSON in tool arguments: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    }

    if (parsedArgs === null || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      return {
        valid: false,
        errors: ["Tool arguments must be a non-null JSON object."],
      };
    }

    // 3. Check nesting depth
    const depth = getObjectDepth(parsedArgs);
    if (depth > MAX_SCHEMA_DEPTH) {
      return {
        valid: false,
        errors: [`Tool arguments nesting depth (${depth}) exceeds maximum allowed depth of ${MAX_SCHEMA_DEPTH}.`],
      };
    }

    // 4. Reject remote $ref in schema to protect against SSRF/DoS
    if (hasRemoteRef(inputSchema)) {
      return {
        valid: false,
        errors: ["Input schema contains forbidden remote $ref URI references."],
      };
    }

    // 5. Check schema nesting depth
    const schemaDepth = getObjectDepth(inputSchema);
    if (schemaDepth > MAX_SCHEMA_DEPTH) {
      return {
        valid: false,
        errors: [`Tool schema nesting depth (${schemaDepth}) exceeds maximum allowed depth of ${MAX_SCHEMA_DEPTH}.`],
      };
    }

    // 6. Compile or retrieve cached validator
    let validator: ValidateFunction | undefined;
    const cacheKey = schemaHash || JSON.stringify(inputSchema);

    if (this.compiledValidators.has(cacheKey)) {
      validator = this.compiledValidators.get(cacheKey);
    } else {
      try {
        const compiled = this.ajv.compile(inputSchema);
        this.compiledValidators.set(cacheKey, compiled);
        validator = compiled;
      } catch (compileErr) {
        return {
          valid: false,
          errors: [`Failed to compile tool JSON Schema: ${compileErr instanceof Error ? compileErr.message : String(compileErr)}`],
        };
      }
    }

    if (!validator) {
      return {
        valid: false,
        errors: ["Internal error: failed to resolve schema validator function."],
      };
    }

    // 7. Validate parsed arguments
    const valid = validator(parsedArgs) as boolean;
    if (!valid) {
      const errors = (validator.errors || []).map((e: ErrorObject) => {
        const path = e.instancePath ? e.instancePath : "/";
        return `Field '${path}': ${e.message || "failed validation"}`;
      });
      return {
        valid: false,
        errors,
      };
    }

    return { valid: true };
  }
}
