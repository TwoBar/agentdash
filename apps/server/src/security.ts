import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
export function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function redact(text: string): string {
  return text
    .slice(0, 30_000)
    .replace(
      /\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/g,
      "[credential redacted]",
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}
interface Operator {
  csrfToken: string;
  expiresAt: number;
}
export class OperatorSessions {
  #sessions = new Map<string, Operator>();
  constructor(readonly now: () => number = Date.now) {}
  establish(res: ServerResponse): void {
    const token = randomBytes(32).toString("base64url");
    this.#sessions.set(secretHash(token), {
      csrfToken: randomBytes(32).toString("base64url"),
      expiresAt: this.now() + 30 * 60_000,
    });
    res.setHeader(
      "Set-Cookie",
      `agcp_operator=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=1800`,
    );
    for (const [key, session] of this.#sessions)
      if (session.expiresAt <= this.now()) this.#sessions.delete(key);
  }
  authenticate(
    req: IncomingMessage,
    origin: string,
    mutation: boolean,
  ): Operator {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("agcp_operator="))
      ?.slice(14);
    const session = cookie ? this.#sessions.get(secretHash(cookie)) : undefined;
    requireCondition(
      session && session.expiresAt > this.now(),
      "unauthenticated",
      "Open the local Agentdash page to establish an operator session.",
      401,
    );
    if (req.headers.origin !== undefined)
      requireCondition(
        req.headers.origin === origin,
        "origin_rejected",
        "Request origin is not trusted.",
        403,
      );
    if (mutation) {
      requireCondition(
        req.headers.origin === origin,
        "origin_rejected",
        "A trusted Origin is required.",
        403,
      );
      requireCondition(
        req.headers["content-type"]?.split(";")[0].trim() ===
          "application/json",
        "json_required",
        "Use application/json.",
        415,
      );
      const csrf = req.headers["x-agcp-csrf"];
      requireCondition(
        typeof csrf === "string" && equalSecret(csrf, session.csrfToken),
        "csrf_rejected",
        "This request has no valid CSRF token.",
        403,
      );
    }
    session.expiresAt = this.now() + 30 * 60_000;
    return session;
  }
}
export interface CapabilityPrincipal {
  projectId: string;
  taskId: string;
  sessionId: string;
  bootId: string;
}
export class Capabilities {
  #tokens = new Map<string, CapabilityPrincipal & { expiresAt: number }>();
  constructor(
    readonly bootId: string,
    readonly now: () => number = Date.now,
  ) {}
  issue(principal: Omit<CapabilityPrincipal, "bootId">): string {
    const token = randomBytes(32).toString("base64url");
    this.#tokens.set(secretHash(token), {
      ...principal,
      bootId: this.bootId,
      expiresAt: this.now() + 15 * 60_000,
    });
    return token;
  }
  authenticate(header: string | undefined): CapabilityPrincipal {
    const token = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const principal = token ? this.#tokens.get(secretHash(token)) : undefined;
    requireCondition(
      principal &&
        principal.bootId === this.bootId &&
        principal.expiresAt > this.now(),
      "invalid_capability",
      "The session capability is missing, expired or revoked.",
      401,
    );
    return {
      projectId: principal.projectId,
      taskId: principal.taskId,
      sessionId: principal.sessionId,
      bootId: principal.bootId,
    };
  }
  revokeSession(sessionId: string): void {
    for (const [key, p] of this.#tokens)
      if (p.sessionId === sessionId) this.#tokens.delete(key);
  }
}
