import dns from "node:dns/promises";
import net from "node:net";

export class SsrfSecurityError extends Error {
  constructor(message: string, public readonly code = "SSRF_VALIDATION_FAILED") {
    super(message);
    this.name = "SsrfSecurityError";
  }
}

export interface SsrfValidationOptions {
  allowLocalhost?: boolean;
  allowPrivateIps?: boolean;
  allowHttp?: boolean;
  allowedPorts?: number[];
  enforceProductionEgressPolicy?: boolean;
}

/**
 * Detects evasive numeric, octal, hexadecimal, integer dword representations,
 * or IPv6 zone identifiers designed to evade naive IP filters.
 */
export function isEvasiveNumericHost(hostname: string): boolean {
  // Check IPv6 zone identifier / scope ID (e.g. fe80::1%eth0 or fe80::1%25eth0)
  if (hostname.includes("%")) return true;

  // Dword integer IP notation: e.g. "2130706433" (decimal for 127.0.0.1)
  if (/^\d+$/.test(hostname)) return true;

  // Check dot-separated numeric or hex segments
  const parts = hostname.split(".");
  if (parts.length >= 1 && parts.length <= 4) {
    const isAllNumericOrHex = parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p));
    if (isAllNumericOrHex) {
      // Malformed/short numeric representation like 127.1 or 10.1
      if (parts.length !== 4) return true;
      for (const p of parts) {
        // Hexadecimal notation like 0x7f.0.0.1
        if (/^0x/i.test(p)) return true;
        // Octal notation with leading zero like 0177.0.0.1
        if (p.length > 1 && p.startsWith("0")) return true;
      }
    }
  }

  return false;
}

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, carrier-grade NAT, or reserved range.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IPv4 is treated as unsafe
  }

  const b0 = parts[0]!;
  const b1 = parts[1]!;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;

  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true;

  // 100.64.0.0/10 (Carrier-grade NAT: 100.64.0.0 - 100.127.255.255) & Alibaba metadata 100.100.100.100
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 169.254.0.0/16 (Link-local & Cloud Metadata: 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (b0 === 192 && b1 === 0 && parts[2] === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0 && parts[2] === 2) return true;

  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true;

  // 198.18.0.0/15 (Network benchmark tests)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && parts[2] === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && parts[2] === 113) return true;

  // 224.0.0.0/4 (Multicast: 224-239)
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use: 240-255)
  if (b0 >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (parts.every((p) => p === 255)) return true;

  return false;
}

/**
 * Checks if an IPv6 address is in a loopback, unique-local, link-local, or mapped IPv4 private range.
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Zone identifiers / scope IDs
  if (normalized.includes("%")) {
    return true;
  }

  // Loopback (::1)
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }

  // Unspecified (::)
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:192.0.2.128 or ::ffff:7f00:1)
  if (normalized.includes("::ffff:")) {
    const lastPart = normalized.substring(normalized.lastIndexOf(":") + 1);
    if (net.isIPv4(lastPart)) {
      return isPrivateOrReservedIpv4(lastPart);
    }
    const idx = normalized.indexOf("::ffff:");
    const remainder = normalized.substring(idx + 7);
    const hexParts = remainder.split(":");
    if (hexParts.length === 2 && hexParts.every((h) => /^[0-9a-f]{1,4}$/i.test(h))) {
      const h1 = parseInt(hexParts[0]!, 16);
      const h2 = parseInt(hexParts[1]!, 16);
      const b0 = (h1 >> 8) & 0xff;
      const b1 = h1 & 0xff;
      const b2 = (h2 >> 8) & 0xff;
      const b3 = h2 & 0xff;
      return isPrivateOrReservedIpv4(`${b0}.${b1}.${b2}.${b3}`);
    }
  }

  // IPv4-compatible IPv6 (::127.0.0.1)
  if (normalized.startsWith("::") && !normalized.includes("::ffff:")) {
    const remainder = normalized.substring(2);
    if (net.isIPv4(remainder)) {
      return isPrivateOrReservedIpv4(remainder);
    }
  }

  // 6to4 addresses (2002::/16)
  if (normalized.startsWith("2002:")) {
    const parts = normalized.split(":");
    if (parts.length >= 3 && /^[0-9a-f]{1,4}$/i.test(parts[1]!) && /^[0-9a-f]{1,4}$/i.test(parts[2]!)) {
      const h1 = parseInt(parts[1]!, 16);
      const h2 = parseInt(parts[2]!, 16);
      const b0 = (h1 >> 8) & 0xff;
      const b1 = h1 & 0xff;
      const b2 = (h2 >> 8) & 0xff;
      const b3 = h2 & 0xff;
      return isPrivateOrReservedIpv4(`${b0}.${b1}.${b2}.${b3}`);
    }
  }

  // Unique local addresses (fc00::/7 -> fc00... to fdff...)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  // Link-local unicast (fe80::/10 -> fe8... to feb...)
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  // Multicast (ff00::/8)
  if (normalized.startsWith("ff")) {
    return true;
  }

  // Cloud metadata IPv6 (e.g. AWS fd00:ec2::254)
  if (normalized.includes("fd00:ec2:")) {
    return true;
  }

  return false;
}

/**
 * Validates a single IP address against SSRF rules.
 */
export function validateIpAddress(ip: string, options: SsrfValidationOptions = {}): void {
  // Reject IPv6 zone indices
  if (ip.includes("%")) {
    throw new SsrfSecurityError(`IPv6 zone identifiers are not permitted in IP addresses: ${ip}`);
  }

  const isV4 = net.isIPv4(ip);
  const isV6 = net.isIPv6(ip);

  if (!isV4 && !isV6) {
    throw new SsrfSecurityError(`Invalid IP address format: ${ip}`);
  }

  if (isV4) {
    // If localhost is explicitly allowed in dev/test, permit 127.0.0.1
    if (options.allowLocalhost && ip.startsWith("127.")) {
      return;
    }

    if (isPrivateOrReservedIpv4(ip)) {
      if (options.allowPrivateIps) return;
      throw new SsrfSecurityError(`Access to private, loopback, or reserved IPv4 address is blocked: ${ip}`);
    }
  }

  if (isV6) {
    // If localhost is explicitly allowed in dev/test, permit ::1
    if (options.allowLocalhost && (ip === "::1" || ip === "0:0:0:0:0:0:0:1")) {
      return;
    }

    if (isPrivateOrReservedIpv6(ip)) {
      if (options.allowPrivateIps) return;
      throw new SsrfSecurityError(`Access to private, loopback, or link-local IPv6 address is blocked: ${ip}`);
    }
  }
}

/**
 * Resolves a hostname via DNS (both A and AAAA) and validates every resolved IP address.
 * Throws SsrfSecurityError if any resolved IP address is in a prohibited range.
 */
export async function resolveAndValidateHostname(
  hostname: string,
  options: SsrfValidationOptions = {}
): Promise<string[]> {
  // Reject evasive or malformed representations before lookup
  if (isEvasiveNumericHost(hostname)) {
    throw new SsrfSecurityError(`Evasive, malformed, or unusual IP representation is blocked: ${hostname}`);
  }

  // If hostname is directly an IP literal
  if (net.isIP(hostname)) {
    validateIpAddress(hostname, options);
    return [hostname];
  }

  // Disallow common localhost/internal aliases unless explicitly allowed
  const lowerHost = hostname.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal") ||
    lowerHost.endsWith(".arpa")
  ) {
    if (!options.allowLocalhost) {
      throw new SsrfSecurityError(`Access to local/internal domain name is blocked: ${hostname}`);
    }
  }

  try {
    // Resolve both IPv4 and IPv6 records
    const lookupResults = await dns.lookup(hostname, { all: true });

    if (!lookupResults || lookupResults.length === 0) {
      throw new SsrfSecurityError(`Could not resolve hostname: ${hostname}`);
    }

    const resolvedIps = lookupResults.map((r) => r.address);

    for (const ip of resolvedIps) {
      validateIpAddress(ip, options);
    }

    return resolvedIps;
  } catch (err) {
    if (err instanceof SsrfSecurityError) {
      throw err;
    }
    throw new SsrfSecurityError(`DNS resolution failed for hostname ${hostname}: ${(err as Error).message}`);
  }
}

/**
 * Validates a remote MCP endpoint URL against SSRF and network security policies.
 * Enforces production egress-port policy: HTTPS only, Port 443 by default.
 */
export async function validateMcpEndpointUrl(
  endpointUrl: string,
  options: SsrfValidationOptions = {}
): Promise<{ url: URL; resolvedIps: string[] }> {
  // Pre-check raw host string before WHATWG URL normalizes evasive representations
  const rawHostMatch = endpointUrl.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#:]+)/);
  if (rawHostMatch && rawHostMatch[1] && isEvasiveNumericHost(rawHostMatch[1])) {
    throw new SsrfSecurityError(`Evasive, malformed, or unusual IP representation is blocked: ${rawHostMatch[1]}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new SsrfSecurityError(`Malformed MCP endpoint URL: ${endpointUrl}`);
  }

  // 1. Detect evasive numeric host
  if (isEvasiveNumericHost(parsed.hostname)) {
    throw new SsrfSecurityError(`Evasive, malformed, or unusual IP representation is blocked: ${parsed.hostname}`);
  }

  // 2. Protocol validation: HTTPS required in production; HTTP allowed only when explicitly permitted
  const isHttp = parsed.protocol === "http:";
  const isHttps = parsed.protocol === "https:";

  if (!isHttp && !isHttps) {
    throw new SsrfSecurityError(`Unsupported protocol "${parsed.protocol}". Remote MCP endpoints must use HTTPS.`);
  }

  const isProd =
    options.enforceProductionEgressPolicy ??
    (process.env.NODE_ENV === "production");

  if (isHttp && isProd && !options.allowHttp) {
    throw new SsrfSecurityError(`Insecure HTTP endpoints are not permitted in production. Remote MCP servers must use HTTPS.`);
  }

  // 3. Reject credentials in URL (e.g. https://user:pass@evil.com)
  if (parsed.username || parsed.password) {
    throw new SsrfSecurityError(`Embedded credentials in endpoint URL are not permitted.`);
  }

  // 4. Production Egress-Port Policy & Port restrictions
  const explicitPort = parsed.port ? parseInt(parsed.port, 10) : undefined;
  const effectivePort = explicitPort ?? (isHttps ? 443 : 80);

  if (explicitPort !== undefined) {
    if (isNaN(explicitPort) || explicitPort < 1 || explicitPort > 65535) {
      throw new SsrfSecurityError(`Invalid port number: ${parsed.port}`);
    }
  }

  // Resolve allowed ports: options take precedence, then env var
  const envAllowedPorts = process.env.MCP_ALLOWED_EGRESS_PORTS
    ? process.env.MCP_ALLOWED_EGRESS_PORTS.split(",")
        .map((p) => parseInt(p.trim(), 10))
        .filter((p) => !isNaN(p))
    : undefined;

  const allowedPorts = options.allowedPorts ?? envAllowedPorts;

  if (isProd) {
    // Default production policy: HTTPS only, port 443 by default
    if (effectivePort !== 443) {
      if (!allowedPorts || !allowedPorts.includes(effectivePort)) {
        throw new SsrfSecurityError(
          `Egress to port ${effectivePort} is prohibited by production security policy. Only port 443 is permitted by default.`
        );
      }
    }
  } else {
    // Non-production (dev/test):
    if (allowedPorts && !allowedPorts.includes(effectivePort)) {
      throw new SsrfSecurityError(`Port ${effectivePort} is not in the allowed ports list.`);
    }

    // Prohibit dangerous infrastructure ports unless allowLocalhost is set
    const prohibitedInfrastructurePorts = [
      22,   // SSH
      25,   // SMTP
      53,   // DNS
      111,  // rpcbind
      135, 137, 138, 139, 445, // NetBIOS / SMB
      2375, 2376, // Docker daemon
      5432, // PostgreSQL
      6379, 6380, // Redis
      9000, 9001, // MinIO / internal admin
      11211, // Memcached
      27017, // MongoDB
    ];

    if (!options.allowLocalhost && prohibitedInfrastructurePorts.includes(effectivePort)) {
      throw new SsrfSecurityError(`Access to restricted infrastructure port ${effectivePort} is blocked.`);
    }
  }

  // 5. Resolve and validate IP destinations
  const resolvedIps = await resolveAndValidateHostname(parsed.hostname, options);

  return { url: parsed, resolvedIps };
}
