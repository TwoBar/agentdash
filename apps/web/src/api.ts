export type ServerFailure = {
  code?: string;
  message?: string;
  retryable?: boolean;
  fieldErrors?: Record<string, string>;
  operation?: string;
};

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly operation: string,
    readonly status = 0,
    readonly retryable = false,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export function operationFor(path: string): string {
  if (path === "/projects") return "Create project";
  if (path === "/personas") return "Save persona version";
  if (path === "/skills") return "Save skill version";
  if (path.includes("/github")) return "Update GitHub integration";
  if (path.endsWith("/start")) return "Launch agent";
  if (path.endsWith("/resume")) return "Resume conversation";
  if (path.endsWith("/history")) return "Load native history";
  if (path.endsWith("/message") || path.endsWith("/reply"))
    return "Send message";
  if (path.endsWith("/interrupt")) return "Interrupt agent";
  if (path.endsWith("/terminate")) return "End agent session";
  if (path.endsWith("/accept")) return "Accept task completion";
  if (path.endsWith("/tasks")) return "Register specialist";
  if (path.endsWith("/approvals/resolve")) return "Resolve reviewed actions";
  if (path.endsWith("/artifacts")) return "Register artifact";
  if (path.includes("/artifacts/") && path.endsWith("/approve"))
    return "Approve artifact";
  if (path.endsWith("/stale")) return "Mark artifact stale";
  if (path.endsWith("/read")) return "Mark update read";
  if (path.includes("/retention")) return "Update content retention";
  return "Update workspace";
}

export const asFailure = (error: unknown, operation: string): ApiFailure =>
  error instanceof ApiFailure
    ? error
    : new ApiFailure(
        error instanceof Error
          ? error.message
          : "The operation could not complete. Your entered values have been kept.",
        "client_error",
        operation,
      );

/** Browser session renewal never navigates or replays a mutation. */
export class LocalApi {
  private csrf = "";
  private renewing: Promise<void> | null = null;
  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async fetch(
    path: string,
    init: RequestInit,
    operation: string,
  ): Promise<Response> {
    try {
      return await this.fetcher(path, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiFailure(
        "The local service did not respond. Reconnect to Agentdash, then refresh workspace status. Your entered values are kept; check the current state before submitting this action again.",
        "connection_unavailable",
        operation,
        0,
        true,
      );
    }
  }

  private async error(
    response: Response,
    operation: string,
  ): Promise<ApiFailure> {
    const body = (await response.json().catch(() => null)) as {
      error?: ServerFailure;
    } | null;
    const failure = body?.error;
    return new ApiFailure(
      failure?.message ||
        `${operation} was rejected (${response.status}). Review the current project and try again.`,
      failure?.code || "request_rejected",
      failure?.operation || operation,
      response.status,
      failure?.retryable ?? response.status >= 500,
      failure?.fieldErrors || {},
    );
  }

  async session(renew = false): Promise<void> {
    if (this.renewing) return this.renewing;
    this.renewing = (async () => {
      if (renew) {
        const page = await this.fetch(
          "/",
          { method: "GET", headers: { Accept: "text/html" } },
          "Reconnect browser session",
        );
        if (!page.ok) throw await this.error(page, "Reconnect browser session");
        // Consume no app code; this navigation-free GET establishes the cookie only.
        await page.text();
      }
      let response = await this.fetch(
        "/api/session",
        { method: "GET" },
        "Connect browser session",
      );
      if (response.status === 401 && !renew) {
        const page = await this.fetch(
          "/",
          { method: "GET", headers: { Accept: "text/html" } },
          "Reconnect browser session",
        );
        if (!page.ok) throw await this.error(page, "Reconnect browser session");
        await page.text();
        response = await this.fetch(
          "/api/session",
          { method: "GET" },
          "Reconnect browser session",
        );
      }
      if (!response.ok)
        throw await this.error(response, "Connect browser session");
      const result = (await response.json()) as { csrfToken?: string };
      if (!result.csrfToken)
        throw new ApiFailure(
          "The local service did not issue a browser session. Reopen the local Agentdash page.",
          "invalid_session",
          "Connect browser session",
        );
      this.csrf = result.csrfToken;
    })().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response = await this.fetch(
      `/api${path}`,
      { method: "GET", signal },
      "Refresh workspace",
    );
    if (response.status === 401) {
      await this.session(true);
      response = await this.fetch(
        `/api${path}`,
        { method: "GET", signal },
        "Refresh workspace",
      );
    }
    if (!response.ok) throw await this.error(response, "Refresh workspace");
    return (await response.json()) as T;
  }

  async post<T = any>(
    path: string,
    body: unknown = {},
    operation = operationFor(path),
  ): Promise<T> {
    if (!this.csrf) await this.session();
    const response = await this.fetch(
      `/api${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AGCP-CSRF": this.csrf,
        },
        body: JSON.stringify(body),
      },
      operation,
    );
    if (!response.ok) {
      const failure = await this.error(response, operation);
      if (
        failure.status === 401 ||
        ["csrf_rejected", "csrf_failed", "invalid_csrf"].includes(failure.code)
      ) {
        await this.session(true);
        throw new ApiFailure(
          "Your browser session was renewed. Review the refreshed workspace, then submit this action again. Your draft has been kept; the action was not retried.",
          "session_renewed",
          operation,
          failure.status,
          true,
          failure.fieldErrors,
        );
      }
      throw failure;
    }
    return (await response.json()) as T;
  }
}
