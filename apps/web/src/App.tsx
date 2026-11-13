import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import type {
  Project,
  Task,
  Session,
  Approval,
  ActivityEvent as Activity,
  Observation,
  Artifact,
  Persona,
} from "../../../packages/domain/src/index.js";

type Outcome = {
  approvalId: string;
  ok: boolean;
  state: string;
  error?: string;
};
type State = {
  projects: Project[];
  project: Project | null;
  tasks: Task[];
  sessions: Session[];
  approvals: Approval[];
  events: Activity[];
  artifacts: Artifact[];
  observations: Observation[];
  personas: Persona[];
  changes?: Record<string, string>;
  status: {
    codexAvailable: boolean;
    codexVersion: string | null;
    connectorReason: string | null;
    retention: string;
    limitations: string[];
  };
  audit: unknown;
};
type Selection = {
  kind: "task" | "approval" | "observation" | "artifact" | "persona";
  id: string;
};
type Dialog = "project" | "task" | "artifact" | "settings" | null;
type IconName =
  | "grid"
  | "tree"
  | "layers"
  | "people"
  | "plus"
  | "arrow"
  | "check"
  | "close"
  | "activity"
  | "settings"
  | "shield"
  | "chat";

function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    tree: (
      <>
        <rect x="8" y="2" width="8" height="6" rx="2" />
        <path d="M12 8v5M5 17v-4h14v4" />
        <rect x="2" y="17" width="6" height="5" rx="1" />
        <rect x="16" y="17" width="6" height="5" rx="1" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    chat: <path d="M21 11a9 9 0 0 1-9 9H3l1.5-5A9 9 0 1 1 21 11Z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
const label = (value: string) =>
  value.replaceAll("_", " ").replaceAll(".", " ");
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";
const taskName = (tasks: Task[], id: string) =>
  tasks.find((task) => task.id === id)?.name || "Registered task";
const inspectorTabs = ["Activity", "Changes", "Context", "Decision path"];

function Empty({
  icon = "activity",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={24} />
      </span>
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
function Badge({ state }: { state: string }) {
  return (
    <span
      className={`badge ${["pending", "waiting_approval", "blocked", "unread"].includes(state) ? "amber" : ["running", "approved", "completed", "ready"].includes(state) ? "green" : ["failed", "denied", "disconnected", "uncertain"].includes(state) ? "red" : ""}`}
    >
      <i />
      {label(state)}
    </span>
  );
}

export default function App() {
  const [data, setData] = useState<State | null>(null);
  const [projectId, setProjectId] = useState("");
  const [csrf, setCsrf] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [nav, setNav] = useState<"desk" | "artifacts" | "personas">("desk");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pinnedApprovalId, setPinnedApprovalId] = useState<string | null>(null);
  const [tab, setTab] = useState("Activity");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [chat, setChat] = useState("");
  const [reply, setReply] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneInstructions, setCloneInstructions] = useState("");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const requestSerial = useRef(0);
  const modalRef = useRef<HTMLElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const activeProjectId = data?.project?.id || "";

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const serial = ++requestSerial.current;
      try {
        const response = await fetch(
          `/api/state${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
          { signal, credentials: "same-origin", cache: "no-store" },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(
            body?.error?.message ||
              `Workspace could not load (${response.status}).`,
          );
        }
        const next: State = await response.json();
        if (serial !== requestSerial.current || signal?.aborted) return;
        setData(next);
        setError("");
        setLoading(false);
        setLastSync(new Date());
      } catch (problem) {
        if (!signal?.aborted && serial === requestSerial.current) {
          setError(messageOf(problem));
          setLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/session", {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Reopen the local Agentdash page to establish this browser's operator session.",
          );
        const session = await response.json();
        if (!controller.signal.aborted) setCsrf(session.csrfToken);
      })
      .catch((problem) => {
        if (!controller.signal.aborted) setActionError(messageOf(problem));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void reload(controller.signal);
    const interval = window.setInterval(() => {
      if (!document.hidden) void reload(controller.signal);
    }, 2500);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [reload]);

  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const focusable = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href]",
        ) || [],
      );
    const firstInput = modal?.querySelector<HTMLElement>(
      "[autofocus], input, textarea, select",
    );
    (firstInput || focusable()[0])?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) setDialog(null);
      if (event.key !== "Tab") return;
      const controls = focusable();
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [dialog]);

  async function mutate(endpoint: string, body: unknown = {}) {
    if (!csrf)
      throw new Error(
        "The local service has not authenticated this browser. Reopen the local Agentdash page.",
      );
    const response = await fetch(`/api${endpoint}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-AGCP-CSRF": csrf },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        result.error?.message || `Request failed (${response.status}).`,
      );
    return result;
  }
  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await work();
      await reload();
    } catch (problem) {
      setActionError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  }
  function choose(next: Selection) {
    setSelection(next);
    if (next.kind === "approval") setPinnedApprovalId(next.id);
    setTab("Activity");
    setChat("");
    setReply("");
  }
  function changeProject(id: string) {
    setProjectId(id);
    setSelection(null);
    setPinnedApprovalId(null);
    setExcluded(new Set());
    setOutcomes([]);
    setActionError("");
    setData(null);
  }
  const tasks = data?.tasks || [];
  const pinnedApproval = data?.approvals.find(
    (item) => item.id === pinnedApprovalId,
  );
  const selectedApproval =
    selection?.kind === "approval"
      ? data?.approvals.find((item) => item.id === selection.id)
      : undefined;
  const selectedObservation =
    selection?.kind === "observation"
      ? data?.observations.find((item) => item.id === selection.id)
      : undefined;
  const selectedTask = tasks.find(
    (task) =>
      task.id ===
      (selectedApproval?.taskId ||
        selectedObservation?.taskId ||
        (selection?.kind === "task" ? selection.id : "")),
  );
  const selectedArtifact =
    selection?.kind === "artifact"
      ? data?.artifacts.find((item) => item.id === selection.id)
      : undefined;
  const selectedPersona =
    selection?.kind === "persona"
      ? data?.personas.find((item) => item.id === selection.id)
      : undefined;
  const selectedSession = data?.sessions.find(
    (item) => item.id === selectedTask?.sessionId,
  );
  const pending = (data?.approvals || []).filter(
    (item) => item.state === "pending",
  );
  const unread = (data?.observations || []).filter(
    (item) => item.state === "unread",
  );
  const groups = new Map<string, Approval[]>();
  for (const item of pending) {
    const task = tasks.find((candidate) => candidate.id === item.taskId);
    const group = task?.parentTaskId || task?.id || item.taskId;
    groups.set(group, [...(groups.get(group) || []), item]);
  }
  const eligible = (item: Approval) =>
    item.state === "pending" &&
    new Date(item.expiresAt).getTime() > Date.now() &&
    !["disconnected", "failed", "terminated"].includes(
      data?.sessions.find((session) => session.id === item.sessionId)?.state ||
        "disconnected",
    ) &&
    !error;
  async function resolve(items: Approval[], decision: "approve" | "deny") {
    // Freeze displayed member identity, digest and revision before the network request.
    const members = items.map((item) => ({
      approvalId: item.id,
      actionDigest: item.actionDigest,
      expectedRevision: item.revision,
    }));
    await perform(async () => {
      const results: Outcome[] = [];
      for (let offset = 0; offset < members.length; offset += 50) {
        const chunk = members.slice(offset, offset + 50);
        try {
          const result = await mutate(
            `/projects/${activeProjectId}/approvals/resolve`,
            { decision, members: chunk },
          );
          results.push(...(result.outcomes as Outcome[]));
        } catch (problem) {
          // Do not retry a request whose delivery may have succeeded.
          results.push(
            ...chunk.map((member) => ({
              approvalId: member.approvalId,
              ok: false,
              state: "uncertain",
              error: `Response unconfirmed: ${messageOf(problem)}`,
            })),
          );
          results.push(
            ...members.slice(offset + 50).map((member) => ({
              approvalId: member.approvalId,
              ok: false,
              state: "not_sent",
              error:
                "Not sent because an earlier response could not be confirmed.",
            })),
          );
          setOutcomes(results);
          throw problem;
        }
      }
      setOutcomes(results);
      setNotice(
        `${results.filter((item) => item.ok).length} of ${results.length} action${results.length === 1 ? "" : "s"} ${decision === "approve" ? "approved" : "denied"}. Each action has its own result.`,
      );
    });
  }
  const projectPath = `/projects/${activeProjectId}`;
  const taskPath = selectedTask
    ? `${projectPath}/tasks/${selectedTask.id}`
    : "";
  const liveChanges = selectedSession
    ? data?.changes?.[selectedSession.id]
    : undefined;
  const taskGitRefs = (data?.artifacts || [])
    .filter(
      (artifact) =>
        artifact.taskId === selectedTask?.id && artifact.sourceCommit,
    )
    .map(
      (artifact) =>
        `${artifact.logicalKey} v${artifact.version}: ${artifact.sourceCommit}`,
    )
    .join("; ");
  const events = (data?.events || [])
    .filter((event) => !selectedTask || event.taskId === selectedTask.id)
    .slice(-60);
  const approvalEvent = data?.events.find(
    (event) => event.id === selectedApproval?.sourceEventId,
  );
  if (approvalEvent && !events.some((event) => event.id === approvalEvent.id)) {
    events.unshift(approvalEvent);
  }
  useEffect(() => {
    if (selectedApproval && tab === "Activity") {
      document
        .getElementById(`activity-${selectedApproval.sourceEventId}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedApproval?.id, tab]);
  const taskDepth = (task: Task) => {
    let depth = 0;
    let parent = task.parentTaskId;
    const seen = new Set([task.id]);
    while (parent && depth < 6 && !seen.has(parent)) {
      seen.add(parent);
      depth++;
      parent = tasks.find((item) => item.id === parent)?.parentTaskId || null;
    }
    return depth;
  };

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      const result = await mutate("/projects", {
        name: form.get("name"),
        workspace: form.get("workspace"),
        objective: form.get("objective"),
        githubRepo: form.get("githubRepo") || undefined,
      });
      const id = result.project?.id || result.id;
      if (id) changeProject(id);
      setDialog(null);
      setNotice("Project created. Launch the orchestrator when you are ready.");
    });
  }
  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      await mutate(`${projectPath}/tasks`, {
        name: form.get("name"),
        objective: form.get("objective"),
        parentTaskId: form.get("parentTaskId"),
        personaId: form.get("personaId"),
      });
      setDialog(null);
      setNotice("Specialist task registered. Select it to launch its session.");
    });
  }
  async function submitArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      await mutate(`${projectPath}/artifacts`, {
        taskId: form.get("taskId"),
        logicalKey: form.get("logicalKey"),
        summary: form.get("summary"),
        content: form.get("content") || undefined,
        externalRef: form.get("externalRef") || undefined,
      });
      setDialog(null);
      setNotice("Draft artifact registered. Review it before approval.");
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Agentdash home">
          <span className="brand-mark">
            <Icon name="tree" size={18} />
          </span>
          agentdash<span className="brand-dot">.</span>
        </a>
        <span className="top-divider" />
        <div className="project-picker">
          <Icon name="layers" />
          {data?.projects.length ? (
            <select
              aria-label="Select project"
              value={activeProjectId}
              onChange={(event) => changeProject(event.target.value)}
            >
              {data.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : (
            <span>Your workspace</span>
          )}
        </div>
        <button
          className="icon-button"
          aria-label="Create project"
          title="Create project"
          onClick={() => setDialog("project")}
        >
          <Icon name="plus" />
        </button>
        <div className="topbar-end">
          <span className={`connection ${error ? "offline" : ""}`}>
            <i />
            {error ? "Connection lost" : "Local workspace"}
          </span>
          <button
            className="icon-button"
            aria-label="Workspace settings"
            onClick={() => setDialog("settings")}
          >
            <Icon name="settings" />
          </button>
          <span className="avatar" title="Human operator">
            You
          </span>
        </div>
      </header>

      <div className="workspace-shell">
        <aside className="sidebar">
          <div className="workspace-label">
            <span className="project-monogram">
              {data?.project?.name.slice(0, 1).toUpperCase() || "A"}
            </span>
            <div>
              <strong>{data?.project?.name || "Agent workspace"}</strong>
              <span>Personal control plane</span>
            </div>
          </div>
          <nav aria-label="Workspace">
            <button
              aria-current={nav === "desk" ? "page" : undefined}
              className={nav === "desk" ? "active" : ""}
              onClick={() => setNav("desk")}
            >
              <Icon name="grid" />
              Operations desk
              <span className="nav-count">
                {pending.length + unread.length || ""}
              </span>
            </button>
            <button
              aria-current={nav === "artifacts" ? "page" : undefined}
              className={nav === "artifacts" ? "active" : ""}
              onClick={() => setNav("artifacts")}
            >
              <Icon name="layers" />
              Artifacts
              <span className="nav-count">{data?.artifacts.length || ""}</span>
            </button>
            <button
              aria-current={nav === "personas" ? "page" : undefined}
              className={nav === "personas" ? "active" : ""}
              onClick={() => setNav("personas")}
            >
              <Icon name="people" />
              Personas
              <span className="nav-count">{data?.personas.length || ""}</span>
            </button>
          </nav>
          <div className="section-label">
            Project agents
            <button
              className="icon-button"
              aria-label="Add specialist task"
              disabled={!data?.project}
              onClick={() => setDialog("task")}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          <div className="agent-tree">
            {tasks.map((task) => (
              <button
                key={task.id}
                className={`agent-node ${selectedTask?.id === task.id ? "selected" : ""}`}
                style={{ marginLeft: taskDepth(task) * 12 }}
                onClick={() => {
                  setNav("desk");
                  choose({ kind: "task", id: task.id });
                }}
              >
                <span className="agent-symbol">
                  <Icon
                    name={task.parentTaskId ? "people" : "tree"}
                    size={14}
                  />
                </span>
                <span>
                  <strong>{task.name}</strong>
                  <small className={`state-${task.state}`}>
                    {label(task.state)}
                  </small>
                  <small className="persona-name">
                    {data?.personas.find(
                      (persona) => persona.id === task.personaId,
                    )?.name || "Assigned persona"}
                  </small>
                </span>
              </button>
            ))}
            {!tasks.length && (
              <p className="sidebar-hint">
                Your orchestrator and specialist agents will appear here.
              </p>
            )}
          </div>
          <div className="sidebar-bottom">
            <div>
              <Icon name="shield" size={14} />
              Human decisions · one action
            </div>
            <div>
              <span className="tiny-dot" />
              Governance stays on this computer
            </div>
          </div>
        </aside>

        <main className="workspace-main">
          <div className="workspace-heading">
            <div>
              <div className="eyebrow">
                {data?.project?.name || "A place to coordinate your agents"}
              </div>
              <h1>
                {nav === "desk"
                  ? "Operations desk"
                  : nav === "artifacts"
                    ? "Artifact registry"
                    : "Persona library"}
              </h1>
              <p>
                {nav === "desk"
                  ? "See what needs you. Keep every agent moving with context."
                  : nav === "artifacts"
                    ? "Versioned project knowledge, with a clear source and owner."
                    : "The roles, working context, and boundaries behind each agent."}
              </p>
            </div>
            <div className="heading-actions">
              <span className="human-policy">
                <Icon name="shield" size={15} />
                Human governed
              </span>
              {data?.project && (
                <button
                  className="button"
                  onClick={() =>
                    setDialog(nav === "artifacts" ? "artifact" : "task")
                  }
                >
                  <Icon name="plus" size={15} />
                  {nav === "artifacts" ? "Register artifact" : "Add specialist"}
                </button>
              )}
            </div>
          </div>
          {pinnedApproval && (
            <section
              className="approval-dock"
              aria-label="Pinned approval review"
            >
              <Icon name="shield" size={17} />
              <div className="approval-dock-action">
                <div>
                  <strong>{taskName(tasks, pinnedApproval.taskId)}</strong>
                  <Badge state={pinnedApproval.state} />
                </div>
                <code title={pinnedApproval.command}>
                  {pinnedApproval.command}
                </code>
                <small>{pinnedApproval.cwd}</small>
              </div>
              <div className="approval-dock-controls">
                <button
                  className="button compact"
                  onClick={() => {
                    setNav("desk");
                    choose({ kind: "approval", id: pinnedApproval.id });
                  }}
                >
                  Return to approval
                </button>
                <button
                  className="button primary compact"
                  disabled={busy || !eligible(pinnedApproval)}
                  onClick={() => void resolve([pinnedApproval], "approve")}
                >
                  Approve
                </button>
                <button
                  className="button compact deny"
                  disabled={busy || !eligible(pinnedApproval)}
                  onClick={() => void resolve([pinnedApproval], "deny")}
                >
                  Deny
                </button>
                <button
                  className="icon-button"
                  aria-label="Unpin approval review"
                  onClick={() => setPinnedApprovalId(null)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </section>
          )}
          {data?.project && (
            <div className="mobile-agent-picker">
              <label htmlFor="mobile-agent">Inspect agent</label>
              <select
                id="mobile-agent"
                value={selectedTask?.id || ""}
                onChange={(event) => {
                  if (event.target.value) {
                    setNav("desk");
                    choose({ kind: "task", id: event.target.value });
                  }
                }}
              >
                <option value="">Choose a registered agent…</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.name} · {label(task.state)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {error && (
            <div className="banner error" role="alert">
              <span>
                <strong>Workspace connection interrupted.</strong> {error}{" "}
                Decisions are disabled until state is current.
              </span>
              <button className="text-button" onClick={() => void reload()}>
                Retry
              </button>
            </div>
          )}
          {actionError && (
            <div className="banner error" role="alert">
              <span>{actionError}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setActionError("")}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div className="banner success" role="status">
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="Dismiss notice"
                onClick={() => setNotice("")}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          {loading && !data ? (
            <div className="loading" aria-live="polite">
              <span className="spinner" />
              <h2>Opening your workspace</h2>
              <p>Loading local project state…</p>
            </div>
          ) : !data?.project ? (
            <div className="welcome">
              <div className="welcome-graphic">
                <Icon name="tree" size={40} />
                <span className="orbit o1" />
                <span className="orbit o2" />
                <span className="orbit o3" />
              </div>
              <div className="eyebrow">Your agents. One clear view.</div>
              <h2>Give the work a home.</h2>
              <p>
                Create a local project to organize the objective, assign
                specialist roles, and review the actions that need your
                decision.
              </p>
              <button
                className="button primary"
                onClick={() => setDialog("project")}
              >
                <Icon name="plus" />
                Create your first project
              </button>
              <div className="welcome-features">
                <span>
                  <Icon name="tree" />A registered agent tree
                </span>
                <span>
                  <Icon name="shield" />
                  Approval at the action
                </span>
                <span>
                  <Icon name="layers" />
                  Traceable project knowledge
                </span>
              </div>
            </div>
          ) : (
            <div
              className={`content-grid ${nav !== "desk" ? "registry-layout" : ""}`}
            >
              <section
                className="feed"
                aria-label={nav === "desk" ? "Action inbox" : nav}
              >
                {nav === "desk" ? (
                  <>
                    <div className="feed-title">
                      <h2>Needs your attention</h2>
                      <span className="count-pill">
                        {pending.length + unread.length}
                      </span>
                    </div>
                    <p className="feed-subtitle">
                      Approvals and conversations, kept in context.
                    </p>
                    {!pending.length && !unread.length && (
                      <Empty icon="check" title="You're all clear">
                        <p>
                          No pending decisions. Select an agent to review its
                          work or start the next task.
                        </p>
                      </Empty>
                    )}
                    {Array.from(groups.entries()).map(([id, approvals]) => {
                      const selected = approvals.filter(
                        (item) => !excluded.has(item.id),
                      );
                      return (
                        <section
                          className="approval-group"
                          key={id}
                          aria-label={`${taskName(tasks, id)} approvals`}
                        >
                          <div className="group-heading">
                            <span>{taskName(tasks, id)}</span>
                            <small>{approvals.length} pending</small>
                          </div>
                          {approvals.map((item) => (
                            <article
                              className={`approval-card ${selectedApproval?.id === item.id ? "chosen" : ""}`}
                              key={item.id}
                            >
                              <div className="card-kicker">
                                <Badge state={item.state} />
                                <span>{item.risk} risk</span>
                              </div>
                              <button
                                className="card-title"
                                onClick={() =>
                                  choose({ kind: "approval", id: item.id })
                                }
                              >
                                {item.summary}
                              </button>
                              <div className="card-owner">
                                <span className="tiny-avatar">
                                  {taskName(tasks, item.taskId).slice(0, 1)}
                                </span>
                                {taskName(tasks, item.taskId)}
                              </div>
                              <pre className="command-inline">
                                {item.command}
                              </pre>
                              <div className="card-target">
                                <span>Directory</span>
                                <code>{item.cwd}</code>
                                {item.target !== item.cwd && (
                                  <>
                                    <span>Target</span>
                                    <code>{item.target}</code>
                                  </>
                                )}
                              </div>
                              <p className="card-impact">
                                {item.impact ||
                                  item.reason ||
                                  "Review this action before it proceeds."}
                              </p>
                              <div className="card-actions">
                                <button
                                  className="button primary compact"
                                  disabled={busy || !eligible(item)}
                                  onClick={() =>
                                    void resolve([item], "approve")
                                  }
                                >
                                  <Icon name="check" size={14} />
                                  Approve
                                </button>
                                <button
                                  className="button compact deny"
                                  disabled={busy || !eligible(item)}
                                  onClick={() => void resolve([item], "deny")}
                                >
                                  Deny
                                </button>
                                <button
                                  className="text-button inspect"
                                  onClick={() =>
                                    choose({ kind: "approval", id: item.id })
                                  }
                                >
                                  Inspect
                                  <Icon name="arrow" size={13} />
                                </button>
                              </div>
                              <label className="include-control">
                                <input
                                  type="checkbox"
                                  checked={!excluded.has(item.id)}
                                  disabled={busy}
                                  onChange={(event) =>
                                    setExcluded((previous) => {
                                      const next = new Set(previous);
                                      if (event.target.checked)
                                        next.delete(item.id);
                                      else next.add(item.id);
                                      return next;
                                    })
                                  }
                                />
                                Include in group approval
                              </label>
                              {!eligible(item) && (
                                <p className="card-warning">
                                  This request cannot currently be resolved.
                                  Inspect its session or wait for refreshed
                                  state.
                                </p>
                              )}
                            </article>
                          ))}
                          <div className="group-footer">
                            <small>Every action is validated separately.</small>
                            <button
                              className="button compact"
                              disabled={
                                busy ||
                                !selected.length ||
                                selected.some((item) => !eligible(item))
                              }
                              onClick={() => void resolve(selected, "approve")}
                            >
                              <Icon name="check" size={14} />
                              {selected.length === approvals.length
                                ? "Approve all"
                                : "Approve selected"}
                              <span className="button-count">
                                {selected.length}
                              </span>
                            </button>
                          </div>
                        </section>
                      );
                    })}
                    {outcomes.length > 0 && (
                      <section
                        className="outcomes"
                        aria-label="Approval results"
                      >
                        <h3>Decision results</h3>
                        {outcomes.map((item) => (
                          <div key={item.approvalId}>
                            <Icon
                              name={item.ok ? "check" : "close"}
                              size={14}
                            />
                            <span>
                              {data.approvals.find(
                                (approval) => approval.id === item.approvalId,
                              )?.summary || "Action"}
                              <small>{item.error || label(item.state)}</small>
                            </span>
                          </div>
                        ))}
                      </section>
                    )}
                    {unread.length > 0 && (
                      <section className="conversation-inbox">
                        <div className="group-heading">
                          <span>Questions & updates</span>
                          <small>{unread.length}</small>
                        </div>
                        {unread.map((item) => (
                          <button
                            key={item.id}
                            className={`question-card ${selectedObservation?.id === item.id ? "chosen" : ""}`}
                            onClick={() =>
                              choose({ kind: "observation", id: item.id })
                            }
                          >
                            <span className="question-icon">
                              <Icon name="chat" />
                            </span>
                            <span>
                              <small>
                                {taskName(tasks, item.taskId)} ·{" "}
                                {Array.isArray(item.classification)
                                  ? item.classification.map(label).join(", ")
                                  : label(item.classification)}
                              </small>
                              <strong>{item.summary}</strong>
                              <span className="text-link">
                                Open conversation{" "}
                                <Icon name="arrow" size={12} />
                              </span>
                            </span>
                          </button>
                        ))}
                      </section>
                    )}
                    <section className="recent">
                      <div className="group-heading">
                        <span>Recent activity</span>
                        <Icon name="activity" size={14} />
                      </div>
                      {data.events.length ? (
                        data.events
                          .slice(-5)
                          .reverse()
                          .map((event) => (
                            <button
                              key={event.id}
                              onClick={() =>
                                choose({ kind: "task", id: event.taskId })
                              }
                            >
                              <span className="event-dot" />
                              <span>
                                {event.summary}
                                <small>{taskName(tasks, event.taskId)}</small>
                              </span>
                              <time>{time(event.createdAt)}</time>
                            </button>
                          ))
                      ) : (
                        <p className="muted small">
                          Activity will appear when an agent starts working.
                        </p>
                      )}
                    </section>
                  </>
                ) : nav === "artifacts" ? (
                  <>
                    <div className="feed-title">
                      <h2>Project artifacts</h2>
                      <span className="count-pill">
                        {data.artifacts.length}
                      </span>
                    </div>
                    <p className="feed-subtitle">
                      Draft, review, and keep the current context clear.
                    </p>
                    {data.artifacts.length ? (
                      data.artifacts.map((item) => (
                        <button
                          className={`registry-card ${selectedArtifact?.id === item.id ? "chosen" : ""}`}
                          key={item.id}
                          onClick={() =>
                            choose({ kind: "artifact", id: item.id })
                          }
                        >
                          <Icon name="layers" />
                          <Badge state={item.status} />
                          <h3>{item.logicalKey}</h3>
                          <p>{item.summary}</p>
                          <small>
                            Version {item.version} ·{" "}
                            {taskName(tasks, item.taskId)}
                          </small>
                        </button>
                      ))
                    ) : (
                      <Empty
                        icon="layers"
                        title="Project knowledge starts here"
                      >
                        <p>
                          Register a roadmap, decision, or codebase map so
                          agents can work from reviewed context.
                        </p>
                        <button
                          className="button"
                          onClick={() => setDialog("artifact")}
                        >
                          Register an artifact
                        </button>
                      </Empty>
                    )}
                  </>
                ) : (
                  <>
                    <div className="feed-title">
                      <h2>Working roles</h2>
                      <span className="count-pill">{data.personas.length}</span>
                    </div>
                    <p className="feed-subtitle">
                      Select a role to review its mandate and context.
                    </p>
                    {data.personas.map((item) => (
                      <button
                        key={item.id}
                        className={`registry-card ${selectedPersona?.id === item.id ? "chosen" : ""}`}
                        onClick={() => {
                          choose({ kind: "persona", id: item.id });
                          setCloneName(`${item.name} copy`);
                          setCloneInstructions(item.instructions);
                        }}
                      >
                        <span className="persona-symbol">
                          <Icon name="people" />
                        </span>
                        <small className="version">v{item.version}</small>
                        <h3>{item.name}</h3>
                        <p>{item.mandate}</p>
                        <small>{item.authority}</small>
                      </button>
                    ))}
                  </>
                )}
              </section>

              <section className="inspector" aria-label="Session inspector">
                <div className="inspector-top">
                  <span>
                    <Icon
                      name={
                        selectedPersona
                          ? "people"
                          : selectedArtifact
                            ? "layers"
                            : "activity"
                      }
                      size={15}
                    />
                    {selectedPersona
                      ? "Persona details"
                      : selectedArtifact
                        ? "Artifact details"
                        : "Session inspector"}
                  </span>
                  {selectedSession && <Badge state={selectedSession.state} />}
                </div>
                {selectedPersona ? (
                  <>
                    <div className="eyebrow">
                      {selectedPersona.role} · Version {selectedPersona.version}
                    </div>
                    <h2>{selectedPersona.name}</h2>
                    <p className="inspector-description">
                      {selectedPersona.mandate}
                    </p>
                    <dl className="facts">
                      <dt>Authority</dt>
                      <dd>{selectedPersona.authority}</dd>
                      <dt>Required inputs</dt>
                      <dd>
                        {selectedPersona.requiredArtifacts.join(", ") ||
                          "No required artifacts"}
                      </dd>
                      <dt>Skills</dt>
                      <dd>
                        {selectedPersona.skills.join(", ") ||
                          "No attached skills"}
                      </dd>
                    </dl>
                    <div className="subheading">Instructions</div>
                    <pre className="content-text">
                      {selectedPersona.instructions}
                    </pre>
                    <form
                      className="clone-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(async () => {
                          await mutate("/personas", {
                            sourceId: selectedPersona.id,
                            name: cloneName,
                            instructions: cloneInstructions,
                          });
                          setNotice(
                            "New persona version created. Existing sessions keep their original version.",
                          );
                        });
                      }}
                    >
                      <h3>Make this role your own</h3>
                      <label>
                        Name
                        <input
                          required
                          value={cloneName}
                          onChange={(event) => setCloneName(event.target.value)}
                        />
                      </label>
                      <label>
                        Instructions
                        <textarea
                          required
                          rows={6}
                          value={cloneInstructions}
                          onChange={(event) =>
                            setCloneInstructions(event.target.value)
                          }
                        />
                      </label>
                      <button className="button" disabled={busy}>
                        Create a new version
                      </button>
                    </form>
                  </>
                ) : selectedArtifact ? (
                  <>
                    <div className="eyebrow">
                      Project context · Version {selectedArtifact.version}
                    </div>
                    <h2>{selectedArtifact.logicalKey}</h2>
                    <p className="inspector-description">
                      {selectedArtifact.summary}
                    </p>
                    <dl className="facts">
                      <dt>Status</dt>
                      <dd>
                        <Badge state={selectedArtifact.status} />
                      </dd>
                      <dt>Owner</dt>
                      <dd>{taskName(tasks, selectedArtifact.taskId)}</dd>
                      <dt>Source commit</dt>
                      <dd>{selectedArtifact.sourceCommit || "Not linked"}</dd>
                      {selectedArtifact.externalRef && (
                        <>
                          <dt>Reference</dt>
                          <dd>
                            {/^https?:\/\//.test(
                              selectedArtifact.externalRef,
                            ) ? (
                              <a
                                href={selectedArtifact.externalRef}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open source reference ↗
                              </a>
                            ) : (
                              selectedArtifact.externalRef
                            )}
                          </dd>
                        </>
                      )}
                    </dl>
                    <pre className="content-text">
                      {selectedArtifact.content ||
                        "This artifact has no retained content. Review its source reference and summary."}
                    </pre>
                    <div className="inspector-actions">
                      <button
                        className="button primary"
                        disabled={
                          busy || selectedArtifact.status === "approved"
                        }
                        onClick={() =>
                          void perform(async () => {
                            await mutate(
                              `${projectPath}/artifacts/${selectedArtifact.id}/approve`,
                            );
                            setNotice("Artifact approved for project context.");
                          })
                        }
                      >
                        Approve context
                      </button>
                      <button
                        className="button"
                        disabled={busy || selectedArtifact.status === "stale"}
                        onClick={() =>
                          void perform(async () => {
                            await mutate(
                              `${projectPath}/artifacts/${selectedArtifact.id}/stale`,
                            );
                            setNotice("Artifact marked stale.");
                          })
                        }
                      >
                        Mark stale
                      </button>
                    </div>
                  </>
                ) : selectedTask ? (
                  <>
                    <div className="eyebrow">
                      {data.personas.find(
                        (persona) => persona.id === selectedTask.personaId,
                      )?.name || "Registered agent"}{" "}
                      · {label(selectedTask.state)}
                    </div>
                    <h2>{selectedApproval?.summary || selectedTask.name}</h2>
                    <p className="inspector-description">
                      {selectedApproval?.reason || selectedTask.objective}
                    </p>
                    {selectedApproval && (
                      <div className="pending-context">
                        <span className="command-label">
                          Exact requested command
                        </span>
                        <pre>{selectedApproval.command}</pre>
                        <dl className="facts">
                          <dt>Directory</dt>
                          <dd>{selectedApproval.cwd}</dd>
                          <dt>Impact</dt>
                          <dd>{selectedApproval.impact}</dd>
                          <dt>Expires</dt>
                          <dd>
                            {new Date(
                              selectedApproval.expiresAt,
                            ).toLocaleString()}
                          </dd>
                          <dt>State</dt>
                          <dd>
                            <Badge state={selectedApproval.state} />
                          </dd>
                        </dl>
                      </div>
                    )}
                    {selectedSession?.error && (
                      <div className="inline-error">
                        {selectedSession.error}
                      </div>
                    )}
                    {selectedObservation && (
                      <div className="question-detail">
                        <span className="eyebrow">
                          Question or update ·{" "}
                          {label(selectedObservation.state)}
                        </span>
                        <p>{selectedObservation.summary}</p>
                        <small>
                          Classification is advisory. Replying does not approve
                          an action or accept completion.
                        </small>
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void perform(async () => {
                              await mutate(
                                `${projectPath}/observations/${selectedObservation.id}/reply`,
                                { text: reply },
                              );
                              setReply("");
                              setNotice(
                                "Reply sent to the originating task session.",
                              );
                            });
                          }}
                        >
                          <label
                            className="sr-only"
                            htmlFor="observation-reply"
                          >
                            Reply to this task
                          </label>
                          <textarea
                            id="observation-reply"
                            rows={3}
                            required
                            placeholder="Reply with the context they need…"
                            value={reply}
                            onChange={(event) => setReply(event.target.value)}
                          />
                          <div className="form-inline-actions">
                            <button
                              className="button primary compact"
                              disabled={busy || !reply.trim()}
                            >
                              Send reply
                              <Icon name="arrow" size={13} />
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              disabled={
                                busy || selectedObservation.state !== "unread"
                              }
                              onClick={() =>
                                void perform(async () => {
                                  await mutate(
                                    `${projectPath}/observations/${selectedObservation.id}/read`,
                                  );
                                })
                              }
                            >
                              Mark read
                            </button>
                          </div>
                        </form>
                      </div>
                    )}
                    <div
                      className="inspector-tabs"
                      role="tablist"
                      aria-label="Inspector view"
                    >
                      {inspectorTabs.map((name) => (
                        <button
                          key={name}
                          role="tab"
                          id={`tab-${name.replaceAll(" ", "-")}`}
                          aria-controls="inspector-panel"
                          aria-selected={tab === name}
                          tabIndex={tab === name ? 0 : -1}
                          onClick={() => setTab(name)}
                          onKeyDown={(event) => {
                            const index = inspectorTabs.indexOf(name);
                            const next =
                              event.key === "ArrowRight"
                                ? inspectorTabs[
                                    (index + 1) % inspectorTabs.length
                                  ]
                                : event.key === "ArrowLeft"
                                  ? inspectorTabs[
                                      (index + inspectorTabs.length - 1) %
                                        inspectorTabs.length
                                    ]
                                  : event.key === "Home"
                                    ? inspectorTabs[0]
                                    : event.key === "End"
                                      ? inspectorTabs.at(-1)
                                      : undefined;
                            if (!next) return;
                            event.preventDefault();
                            setTab(next);
                            document
                              .getElementById(
                                `tab-${next.replaceAll(" ", "-")}`,
                              )
                              ?.focus();
                          }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    <div
                      className="inspector-panel"
                      id="inspector-panel"
                      role="tabpanel"
                      tabIndex={0}
                      aria-labelledby={`tab-${tab.replaceAll(" ", "-")}`}
                    >
                      {tab === "Activity" ? (
                        <>
                          {events.length ? (
                            events.map((event) => (
                              <div
                                className={`timeline-event ${event.id === selectedApproval?.sourceEventId ? "anchored-event" : ""}`}
                                id={`activity-${event.id}`}
                                key={event.id}
                              >
                                <span
                                  className={`timeline-mark ${event.type.includes("approval") ? "amber" : ""}`}
                                >
                                  <Icon
                                    name={
                                      event.type.includes("approval")
                                        ? "shield"
                                        : "activity"
                                    }
                                    size={12}
                                  />
                                </span>
                                <div>
                                  <div className="event-heading">
                                    <strong>{event.summary}</strong>
                                    <time>{time(event.createdAt)}</time>
                                  </div>
                                  <small>{label(event.type)}</small>
                                  {event.id ===
                                    selectedApproval?.sourceEventId && (
                                    <span className="anchor-label">
                                      Selected approval
                                    </span>
                                  )}
                                  {event.text && (
                                    <pre className="event-text">
                                      {event.text}
                                    </pre>
                                  )}
                                </div>
                              </div>
                            ))
                          ) : (
                            <Empty title="Ready for the first turn">
                              <p>
                                Start this registered agent to see messages,
                                tools, and execution results.
                              </p>
                            </Empty>
                          )}
                          {data.status.retention === "minimal" && (
                            <p className="retention-note">
                              <Icon name="shield" size={13} />
                              Minimal retention keeps persisted activity
                              metadata. Enable local content in Settings to
                              retain messages and tool output.
                            </p>
                          )}
                        </>
                      ) : tab === "Changes" ? (
                        <>
                          {liveChanges && (
                            <div className="change-block">
                              <h3>Current session changes</h3>
                              <pre>{liveChanges}</pre>
                            </div>
                          )}
                          {events.filter((event) =>
                            /diff|change|file/.test(event.type),
                          ).length
                            ? events
                                .filter((event) =>
                                  /diff|change|file/.test(event.type),
                                )
                                .map((event) => (
                                  <div className="change-block" key={event.id}>
                                    <h3>{event.summary}</h3>
                                    <pre>
                                      {event.text ||
                                        "Change metadata recorded. Full content is not retained."}
                                    </pre>
                                  </div>
                                ))
                            : !liveChanges && (
                                <Empty
                                  icon="layers"
                                  title="Diff evidence unavailable"
                                >
                                  <p>
                                    No diff was captured or retained for this
                                    session. This does not establish that no
                                    files changed.
                                  </p>
                                </Empty>
                              )}
                          <div className="change-block">
                            <h3>Related Git references</h3>
                            <p className="muted small">
                              {taskGitRefs ||
                                "Unavailable: no task artifact source commit was captured."}
                            </p>
                            <p className="muted small">
                              Artifact provenance is not a captured diff base or
                              head. Diff base/head evidence is unavailable.
                            </p>
                          </div>
                        </>
                      ) : tab === "Context" ? (
                        <>
                          <dl className="facts">
                            <dt>Git references</dt>
                            <dd>
                              {taskGitRefs ||
                                "Unavailable: no source commit reference was captured for this task."}
                            </dd>
                            <dt>Objective</dt>
                            <dd>{selectedTask.objective}</dd>
                            <dt>Persona</dt>
                            <dd>
                              {data.personas.find(
                                (persona) =>
                                  persona.id === selectedTask.personaId,
                              )?.name || selectedTask.personaId}{" "}
                              · v
                              {data.personas.find(
                                (persona) =>
                                  persona.id === selectedTask.personaId,
                              )?.version ?? "unavailable"}
                            </dd>
                            <dt>Parent</dt>
                            <dd>
                              {selectedTask.parentTaskId
                                ? taskName(tasks, selectedTask.parentTaskId)
                                : "Project root"}
                            </dd>
                            <dt>Workspace</dt>
                            <dd>
                              {selectedTask.workspace || data.project.workspace}
                            </dd>
                            <dt>Session</dt>
                            <dd>
                              {selectedSession
                                ? label(selectedSession.state)
                                : "Not launched"}
                            </dd>
                            <dt>Authority</dt>
                            <dd>Human approval only</dd>
                            <dt>Sandbox</dt>
                            <dd>
                              Exact current sandbox evidence is unavailable in
                              this inspector. Native approval does not grant
                              persistent session permissions.
                            </dd>
                          </dl>
                          <h3 className="subheading">
                            Available project context
                          </h3>
                          {data.artifacts.length ? (
                            data.artifacts.map((artifact) => (
                              <button
                                className="context-artifact"
                                key={artifact.id}
                                onClick={() =>
                                  choose({ kind: "artifact", id: artifact.id })
                                }
                              >
                                <Icon name="layers" size={14} />
                                <span>
                                  {artifact.logicalKey}{" "}
                                  <small>v{artifact.version}</small>
                                </span>
                                <Badge state={artifact.status} />
                              </button>
                            ))
                          ) : (
                            <p className="muted">
                              No artifacts registered yet.
                            </p>
                          )}
                        </>
                      ) : (
                        <div className="decision-path">
                          <div>
                            <strong>Registered task</strong>
                            <p>
                              {selectedTask.name} ·{" "}
                              {data.personas.find(
                                (persona) =>
                                  persona.id === selectedTask.personaId,
                              )?.name || "Assigned persona"}
                            </p>
                          </div>
                          <div>
                            <strong>Human authority</strong>
                            <p>
                              Agents may recommend. Every pending native
                              approval requires its own valid decision.
                            </p>
                          </div>
                          {selectedApproval ? (
                            <>
                              <div>
                                <strong>Recorded policy snapshot</strong>
                                <p>{selectedApproval.policySnapshotId}</p>
                              </div>
                              <div>
                                <strong>Exact action binding</strong>
                                <code>{selectedApproval.actionDigest}</code>
                              </div>
                              <div>
                                <strong>
                                  {selectedApproval.state === "pending"
                                    ? "Waiting for your decision"
                                    : label(selectedApproval.state)}
                                </strong>
                                <p>
                                  Session and action are checked again before
                                  delivery. A lost connection invalidates the
                                  pending response.
                                </p>
                                <p>
                                  {selectedApproval.reason ||
                                    "No resolution reason recorded."}
                                </p>
                              </div>
                              <div>
                                <strong>Resolver ancestry evidence</strong>
                                <p>
                                  Detailed decision records and policy
                                  evaluation results are not exposed in this
                                  inspector. No delegated judgments are recorded
                                  here.
                                </p>
                              </div>
                            </>
                          ) : (
                            <div>
                              <strong>No approval selected</strong>
                              <p>
                                Choose an approval card to inspect its exact
                                action and current decision state.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {selectedApproval ? (
                      <div className="inspector-actions sticky-actions">
                        <button
                          className="button primary"
                          disabled={busy || !eligible(selectedApproval)}
                          onClick={() =>
                            void resolve([selectedApproval], "approve")
                          }
                        >
                          <Icon name="check" size={15} />
                          Approve action
                        </button>
                        <button
                          className="button deny"
                          disabled={busy || !eligible(selectedApproval)}
                          onClick={() =>
                            void resolve([selectedApproval], "deny")
                          }
                        >
                          Deny action
                        </button>
                        <small>
                          One action. Original session. No persistent
                          permission.
                        </small>
                      </div>
                    ) : (
                      <>
                        <div className="task-controls">
                          {!selectedSession ||
                          ["terminated", "failed", "disconnected"].includes(
                            selectedSession.state,
                          ) ? (
                            <button
                              className="button primary"
                              disabled={
                                busy ||
                                !data.status.codexAvailable ||
                                selectedTask.state === "completed"
                              }
                              onClick={() =>
                                void perform(async () => {
                                  await mutate(`${taskPath}/start`);
                                  setNotice(
                                    "Registered session launch requested.",
                                  );
                                })
                              }
                            >
                              <Icon name="activity" size={15} />
                              Launch agent
                            </button>
                          ) : (
                            <>
                              <button
                                className="button compact"
                                disabled={
                                  busy ||
                                  !["running", "waiting_approval"].includes(
                                    selectedSession.state,
                                  )
                                }
                                onClick={() =>
                                  void perform(async () => {
                                    await mutate(`${taskPath}/interrupt`);
                                  })
                                }
                              >
                                Interrupt
                              </button>
                              <button
                                className="button compact deny"
                                disabled={busy}
                                onClick={() =>
                                  void perform(async () => {
                                    await mutate(`${taskPath}/terminate`);
                                  })
                                }
                              >
                                End session
                              </button>
                            </>
                          )}
                          {selectedTask.state === "review" && (
                            <button
                              className="button"
                              disabled={busy}
                              onClick={() =>
                                void perform(async () => {
                                  await mutate(`${taskPath}/accept`);
                                  setNotice("Task completion accepted by you.");
                                })
                              }
                            >
                              <Icon name="check" size={14} />
                              Accept completion
                            </button>
                          )}
                          <button
                            className="text-button"
                            onClick={() => setDialog("task")}
                          >
                            <Icon name="plus" size={14} />
                            Add specialist
                          </button>
                        </div>
                        {!data.status.codexAvailable && (
                          <p className="inline-error">
                            Codex is unavailable:{" "}
                            {data.status.connectorReason ||
                              "A supported local CLI is required."}
                          </p>
                        )}
                        <form
                          className="chat-composer"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void perform(async () => {
                              await mutate(`${taskPath}/message`, {
                                text: chat,
                              });
                              setChat("");
                            });
                          }}
                        >
                          <label htmlFor="task-message">
                            Message {selectedTask.name}
                          </label>
                          <textarea
                            id="task-message"
                            rows={3}
                            placeholder={
                              selectedSession
                                ? "Send a message to this agent…"
                                : "Launch the agent to begin the conversation."
                            }
                            value={chat}
                            onChange={(event) => setChat(event.target.value)}
                            disabled={
                              !selectedSession ||
                              ["disconnected", "terminated", "failed"].includes(
                                selectedSession.state,
                              )
                            }
                          />
                          <div>
                            <small>Routes to this registered session</small>
                            <button
                              className="button primary compact"
                              disabled={
                                busy ||
                                !chat.trim() ||
                                !selectedSession ||
                                [
                                  "disconnected",
                                  "terminated",
                                  "failed",
                                ].includes(selectedSession.state)
                              }
                            >
                              Send
                              <Icon name="arrow" size={13} />
                            </button>
                          </div>
                        </form>
                      </>
                    )}
                  </>
                ) : (
                  <div className="inspector-placeholder">
                    <span className="inspector-graphic">
                      <Icon name="tree" size={35} />
                    </span>
                    <h2>Keep the whole picture.</h2>
                    <p>
                      Select an agent, approval, or artifact to see the work,
                      the context, and the decision behind it.
                    </p>
                    <div>
                      <Icon name="activity" />
                      Activity and execution evidence
                    </div>
                    <div>
                      <Icon name="layers" />
                      Changes and project knowledge
                    </div>
                    <div>
                      <Icon name="shield" />
                      Authority and action boundaries
                    </div>
                    {data.status.limitations.length > 0 && (
                      <details>
                        <summary>Current capability limits</summary>
                        <ul>
                          {data.status.limitations.map((limit) => (
                            <li key={limit}>{limit}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              <span className={`tiny-dot ${error ? "red-dot" : ""}`} />
              {error
                ? "Reconnecting to local service"
                : lastSync
                  ? `Synced ${lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Connecting"}
            </span>
            <span>
              {data?.status.codexAvailable
                ? `Codex ${data.status.codexVersion || ""}`
                : "Codex unavailable"}
              <span className="footer-separator">·</span>
              {data?.status.retention === "local-content"
                ? "Local content retention"
                : "Minimal retention"}
            </span>
          </footer>
        </main>
      </div>

      {dialog && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setDialog(null);
          }}
        >
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <div className="modal-heading">
              <h2 id="dialog-title">
                {dialog === "project"
                  ? "Create a project"
                  : dialog === "task"
                    ? "Add a specialist"
                    : dialog === "artifact"
                      ? "Register an artifact"
                      : "Workspace settings"}
              </h2>
              <button
                className="icon-button"
                aria-label="Close dialog"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                <Icon name="close" />
              </button>
            </div>
            {actionError && (
              <div className="inline-error" role="alert">
                {actionError}
              </div>
            )}
            {dialog === "project" ? (
              <form onSubmit={(event) => void submitProject(event)}>
                <p className="modal-description">
                  Start with an objective and a local workspace. Your
                  orchestrator launches when you choose.
                </p>
                <label>
                  Project name
                  <input
                    name="name"
                    required
                    maxLength={120}
                    placeholder="My next project"
                    autoFocus
                  />
                </label>
                <label>
                  Local workspace
                  <input
                    name="workspace"
                    required
                    placeholder="/absolute/path/to/project"
                    pattern="/.*"
                  />
                  <small>
                    Use an existing local folder. Agents work within this
                    project boundary.
                  </small>
                </label>
                <label>
                  Project objective
                  <textarea
                    name="objective"
                    required
                    rows={3}
                    placeholder="What should the team build, and how will you know it's done?"
                  />
                </label>
                <label>
                  GitHub reference <span className="optional">optional</span>
                  <input name="githubRepo" placeholder="owner/repository" />
                  <small>
                    Links the project reference. This does not create or change
                    a repository.
                  </small>
                </label>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="button"
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </button>
                  <button className="button primary" disabled={busy}>
                    Create project
                    <Icon name="arrow" size={14} />
                  </button>
                </div>
              </form>
            ) : dialog === "task" ? (
              <form onSubmit={(event) => void submitTask(event)}>
                <p className="modal-description">
                  Give a specialist a clear objective and a place in the agent
                  tree.
                </p>
                <label>
                  Task name
                  <input
                    name="name"
                    required
                    maxLength={120}
                    placeholder="Review the architecture"
                    autoFocus
                  />
                </label>
                <label>
                  Parent agent
                  <select
                    name="parentTaskId"
                    required
                    defaultValue={selectedTask?.id || data?.project?.rootTaskId}
                  >
                    {tasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Persona
                  <select
                    name="personaId"
                    required
                    defaultValue={selectedPersona?.id || ""}
                  >
                    <option value="" disabled>
                      Choose a specialist persona
                    </option>
                    {data?.personas.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.name} · v{persona.version}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Objective
                  <textarea
                    name="objective"
                    required
                    rows={4}
                    placeholder="Define scope, expected output, and acceptance criteria."
                  />
                </label>
                <p className="form-note">
                  <Icon name="shield" size={14} />
                  Child sessions require an isolated workspace before launch.
                </p>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="button"
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </button>
                  <button className="button primary" disabled={busy}>
                    Register specialist
                    <Icon name="arrow" size={14} />
                  </button>
                </div>
              </form>
            ) : dialog === "artifact" ? (
              <form onSubmit={(event) => void submitArtifact(event)}>
                <p className="modal-description">
                  Add a versioned piece of project context. New artifacts start
                  as drafts.
                </p>
                <label>
                  Logical key
                  <input
                    name="logicalKey"
                    required
                    placeholder="current_roadmap"
                    autoFocus
                  />
                </label>
                <label>
                  Owning task
                  <select
                    name="taskId"
                    required
                    defaultValue={selectedTask?.id || data?.project?.rootTaskId}
                  >
                    {tasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Summary
                  <textarea name="summary" required rows={2} />
                </label>
                <label>
                  Content <span className="optional">optional</span>
                  <textarea
                    name="content"
                    rows={5}
                    placeholder="Project context retained locally…"
                  />
                </label>
                <label>
                  Source reference <span className="optional">optional</span>
                  <input
                    name="externalRef"
                    placeholder="https://github.com/owner/repository/…"
                  />
                </label>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="button"
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </button>
                  <button className="button primary" disabled={busy}>
                    Register draft
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="modal-description">
                  Your governance workspace is stored on this computer.
                </p>
                <div className="setting-row">
                  <div>
                    <strong>Retain session content locally</strong>
                    <p>
                      Store messages and tool output as plaintext in the local
                      database, with common credential redaction. Raw reasoning
                      is never retained. With this off, new persisted activity
                      keeps minimal metadata. Turning it off does not erase
                      previously stored content. Retention resets to minimal
                      after a service restart.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Retain session content locally"
                    checked={data?.status.retention === "local-content"}
                    disabled={busy}
                    onChange={(event) => {
                      const retention = event.target.checked
                        ? "local-content"
                        : "minimal";
                      void perform(async () => {
                        await mutate("/settings/retention", { retention });
                        setNotice(
                          retention === "local-content"
                            ? "Local content retention enabled for future activity."
                            : "Minimal retention enabled for future activity.",
                        );
                      });
                    }}
                  />
                </div>
                <dl className="facts">
                  <dt>Connector</dt>
                  <dd>
                    {data?.status.codexAvailable
                      ? data.status.codexVersion
                      : data?.status.connectorReason || "Unavailable"}
                  </dd>
                  <dt>Authority</dt>
                  <dd>Human approvals only</dd>
                  <dt>Integration</dt>
                  <dd>Agentdash-owned Codex sessions</dd>
                </dl>
                {data?.status.limitations.length ? (
                  <div className="capability-limits">
                    <h3>Current limits</h3>
                    <ul>
                      {data.status.limitations.map((limit) => (
                        <li key={limit}>{limit}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
