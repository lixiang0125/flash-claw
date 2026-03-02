import { lookup } from "dns";

const PRIVATE_IP_RANGES = [
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^0\.\d+\.\d+\.\d+$/,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google",
  "169.254.169.254",
  "metadata.aws.internal",
  "instance-data",
  "metadata.azure.com",
]);

export interface SSRFCheckResult {
  allowed: boolean;
  reason?: string;
}

export class SSRFProtection {
  private allowedHosts: Set<string>;
  private blockedHosts: Set<string>;

  constructor(allowedHosts: string[] = [], blockedHosts: string[] = []) {
    this.allowedHosts = new Set(allowedHosts);
    this.blockedHosts = new Set([...BLOCKED_HOSTS, ...blockedHosts]);
  }

  check(url: string): SSRFCheckResult {
    try {
      const parsedUrl = new URL(url);

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return { allowed: false, reason: `Protocol '${parsedUrl.protocol}' not allowed` };
      }

      const hostname = parsedUrl.hostname.toLowerCase();

      if (this.blockedHosts.has(hostname)) {
        return { allowed: false, reason: `Host '${hostname}' is blocked` };
      }

      if (this.allowedHosts.size > 0 && !this.allowedHosts.has(hostname)) {
        return { allowed: false, reason: `Host '${hostname}' not in allowed list` };
      }

      if (this.isPrivateHostname(hostname)) {
        return { allowed: false, reason: `Hostname '${hostname}' resolves to private network` };
      }

      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: `Invalid URL: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }

  private isPrivateHostname(hostname: string): boolean {
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return true;
    }

    if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) {
      return true;
    }

    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return false;
    }

    return false;
  }

  async checkWithDNS(url: string): Promise<SSRFCheckResult> {
    const basicCheck = this.check(url);
    if (!basicCheck.allowed) {
      return basicCheck;
    }

    try {
      const ip = await this.resolveHostname(url);
      if (ip && this.isPrivateIP(ip)) {
        return { allowed: false, reason: `URL resolves to private IP: ${ip}` };
      }
    } catch {
      // DNS resolution failed, but basic check passed
    }

    return { allowed: true };
  }

  private resolveHostname(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      const hostname = new URL(url).hostname;
      lookup(hostname, (err, address) => {
        if (err || !address) {
          resolve(null);
        } else {
          resolve(address);
        }
      });
    });
  }

  private isPrivateIP(ip: string): boolean {
    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(ip)) {
        return true;
      }
    }
    return false;
  }
}

export const defaultSSRFProtection = new SSRFProtection();
