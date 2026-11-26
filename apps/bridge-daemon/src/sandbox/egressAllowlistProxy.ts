import http from "node:http";
import net from "node:net";
import dns from "node:dns";

function isDisallowedPrivateIp(ip: string, explicitlyAllowedHosts: string[]): boolean {
  const lower = ip.toLowerCase();
  // Allow explicit loopback only if caller explicitly allowlisted localhost/127.0.0.1
  if (lower === "127.0.0.1" || lower === "::1") {
    if (
      explicitlyAllowedHosts.some(
        (h) => h.toLowerCase() === "127.0.0.1" || h.toLowerCase() === "localhost"
      )
    ) {
      return false;
    }
    return true;
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true;
    if (a! >= 224) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("ff")) {
      return true;
    }
    if (lower.startsWith("::ffff:")) {
      return isDisallowedPrivateIp(lower.slice(7), explicitlyAllowedHosts);
    }
  }
  return false;
}

/**
 * Ephemeral loopback HTTP/CONNECT egress proxy used inside OS-enforced sandboxes
 * when networkAllowed=true with a scoped destination host/port allowlist.
 * Combined with OS kernel rules allowing ONLY localhost:<proxyPort>, unauthorized
 * external sockets are physically dropped by the OS kernel and SSRF targets are blocked.
 */
export class EgressAllowlistProxy {
  private server: http.Server | null = null;
  private port = 0;

  constructor(
    private readonly allowedHosts: string[],
    private readonly allowedPorts: number[]
  ) {}

  private isHostAllowed(hostname: string): boolean {
    const target = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return this.allowedHosts.some((ruleRaw) => {
      const rule = ruleRaw.toLowerCase().trim();
      if (!rule || rule === "*") return false;
      if (rule.startsWith("*.")) {
        const suffix = rule.slice(1); // ".example.com"
        return target.endsWith(suffix) && target.length > suffix.length;
      }
      return target === rule;
    });
  }

  private isPortAllowed(port: number): boolean {
    const ports = this.allowedPorts.length > 0 ? this.allowedPorts : [443, 80];
    return ports.includes(port);
  }

  private async resolveAndCheckTarget(hostname: string, port: number): Promise<string> {
    if (!this.isHostAllowed(hostname)) {
      throw new Error(`Egress host '${hostname}' is not in networkAllowedHosts allowlist.`);
    }
    if (!this.isPortAllowed(port)) {
      throw new Error(`Egress port '${port}' is not in networkAllowedPorts allowlist.`);
    }

    if (net.isIP(hostname)) {
      if (isDisallowedPrivateIp(hostname, this.allowedHosts)) {
        throw new Error(`SSRF protection blocked private IP '${hostname}'.`);
      }
      return hostname;
    }

    const looked = await dns.promises.lookup(hostname, { all: true });
    for (const addr of looked) {
      if (isDisallowedPrivateIp(addr.address, this.allowedHosts)) {
        throw new Error(`SSRF protection blocked resolved private IP '${addr.address}' for '${hostname}'.`);
      }
    }
    return looked[0]?.address || hostname;
  }

  public async start(): Promise<number> {
    if (this.server) return this.port;

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "");
        const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
        const resolvedIp = await this.resolveAndCheckTarget(url.hostname, port);

        const forwardReq = http.request(
          {
            host: resolvedIp,
            port,
            method: req.method,
            path: url.pathname + url.search,
            agent: false,
            headers: {
              ...req.headers,
              host: url.host,
              connection: "close",
            },
          },
          (forwardRes) => {
            res.writeHead(forwardRes.statusCode || 502, forwardRes.headers);
            forwardRes.pipe(res);
          }
        );

        forwardReq.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end("Bad Gateway");
        });
        req.pipe(forwardReq);
      } catch (err) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end(err instanceof Error ? err.message : "Egress Forbidden");
      }
    });

    server.on("connect", async (req, clientSocket, head) => {
      try {
        const [rawHost, rawPort] = (req.url || "").split(":");
        const port = Number(rawPort || 443);
        const hostname = (rawHost || "").trim();
        const resolvedIp = await this.resolveAndCheckTarget(hostname, port);

        const upstream = net.connect(port, resolvedIp, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => {
          clientSocket.destroy();
        });
        clientSocket.on("error", () => {
          upstream.destroy();
        });
      } catch (err) {
        clientSocket.write(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${err instanceof Error ? err.message : "Forbidden"}`
        );
        clientSocket.destroy();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
    });

    this.server = server;
    return this.port;
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }
}
