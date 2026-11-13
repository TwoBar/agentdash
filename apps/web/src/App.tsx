import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiFailure, LocalApi, asFailure, operationFor } from "./api.js";
import {
  GitHubSettings,
  ArtifactIssuePlan,
  GitHubProject,
  useGitHubProfile,
  type InitialRepository,
} from "./github.js";
import { PersonaEditor, PersonaMetadata } from "./personas.js";
import { inspectionEvents } from "./inspector.js";
const apiClient = new LocalApi();

import type {
  Project,
  Task,
  Session,
  Approval,
  ActivityEvent as Activity,
  Observation,
  Artifact,
  Persona,
  Decision,
  AuditEntry,
  SkillVersion,
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
  decisions?: Decision[];
  policyEvaluations?: Array<{
    id: string;
    approvalId: string;
    check: string;
    outcome: string;
    summary: string;
    checkedAt: string;
  }>;
  auditEntries?: AuditEntry[];
  sessionEvidence?: Array<{
    sessionId: string;
    sandboxSummary: string;
    historyGaps: string[];
    gitBase?: string;
    gitHead?: string;
  }>;
  skills?: SkillVersion[];
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [actionError, setActionError] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [nav, setNav] = useState<"desk" | "artifacts" | "personas" | "github">(
    "desk",
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pinnedApprovalId, setPinnedApprovalId] = useState<string | null>(null);
  const [tab, setTab] = useState("Activity");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [treeFocusId, setTreeFocusId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const {
    profile: githubProfile,
    loading: githubLoading,
    failure: githubFailure,
  } = useGitHubProfile(apiClient, dialog === "project");
  const [projectRepositoryMode, setProjectRepositoryMode] = useState("local");
  const [initialRepository, setInitialRepository] = useState<
    (InitialRepository & { projectId: string }) | null
  >(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [chat, setChat] = useState("");
  const [reply, setReply] = useState("");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const requestSerial = useRef(0);
  const modalRef = useRef<HTMLElement>(null);
  const formDrafts = useRef<Record<string, Record<string, string>>>({});
  const draftKey = (kind: string) =>
    kind === "project" ? kind : `${activeProjectId}:${kind}`;
  const draft = (kind: string, name: string, fallback = "") =>
    formDrafts.current[draftKey(kind)]?.[name] ?? fallback;
  const rememberDraft = (kind: string, form: HTMLFormElement) => {
    formDrafts.current[draftKey(kind)] = Object.fromEntries(
      [...new FormData(form)].map(([key, value]) => [key, String(value)]),
    );
  };
  const clearDraft = (kind: string) => {
    delete formDrafts.current[draftKey(kind)];
  };
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const activeProjectId = data?.project?.id || "";

  useEffect(() => {
    if (dialog !== "project" || githubLoading) return;
    const saved = formDrafts.current.project;
    if (saved?.githubMode) setProjectRepositoryMode(saved.githubMode);
    else if (!saved)
      setProjectRepositoryMode(
        githubProfile?.connected &&
          !githubFailure &&
          githubProfile.capabilities.repositoryCreate
          ? "create"
          : "local",
      );
  }, [dialog, githubLoading, githubProfile, githubFailure]);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const serial = ++requestSerial.current;
      try {
        const next = await apiClient.get<State>(
          `/state${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
          signal,
        );
        if (serial !== requestSerial.current || signal?.aborted) return;
        setData(next);
        setError(null);
        setLoading(false);
        setLastSync(new Date());
      } catch (problem) {
        if (!signal?.aborted && serial === requestSerial.current) {
          setError(asFailure(problem, "Refresh workspace"));
          setLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    let active = true;
    void apiClient.session().catch((problem) => {
      if (active) setActionError(asFailure(problem, "Connect browser session"));
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let running = false;
    setLoading(true);
    const poll = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        if (!document.hidden) await reload(controller.signal);
      } finally {
        running = false;
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 2500);
      }
    };
    const visible = () => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        void poll();
      }
    };
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
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
    try {
      return await apiClient.post(endpoint, body);
    } catch (problem) {
      throw asFailure(problem, operationFor(endpoint));
    }
  }
  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice("");
    try {
      await work();
      await reload();
    } catch (problem) {
      setActionError(asFailure(problem, "Update workspace"));
      await reload();
    } finally {
      setBusy(false);
    }
  }
  function choose(next: Selection) {
    setSelection(next);
    if (next.kind === "approval") setPinnedApprovalId(next.id);
    setTab("Activity");
    setShowAllActivity(false);
    requestAnimationFrame(() =>
      document
        .getElementById("inspector-heading")
        ?.focus({ preventScroll: true }),
    );
    setChat("");
    setReply("");
  }
  function changeProject(id: string) {
    setProjectId(id);
    setSelection(null);
    setTreeFocusId(null);
    setPinnedApprovalId(null);
    setExcluded(new Set());
    setOutcomes([]);
    setActionError(null);
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
    (item) =>
      item.id ===
      (selectedApproval?.sessionId ||
        selectedObservation?.sessionId ||
        selectedTask?.sessionId),
  );
  const sessionPersona = data?.personas.find(
    (persona) =>
      persona.id ===
      (selectedSession?.personaVersionId || selectedTask?.personaId),
  );
  const historicalSession = Boolean(
    selectedSession &&
    selectedTask?.sessionId &&
    selectedSession.id !== selectedTask.sessionId,
  );
  const originUnavailable =
    !selectedSession ||
    ["disconnected", "failed", "terminated"].includes(selectedSession.state);
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
  const sessionEvents = inspectionEvents(
    data?.events || [],
    selectedTask?.id,
    selectedSession,
    data?.sessions || [],
    Boolean(selectedApproval || selectedObservation),
    selectedApproval?.sessionId || selectedObservation?.sessionId,
  );
  const events = showAllActivity
    ? [...sessionEvents]
    : sessionEvents.slice(-60);
  const sessionEvidence = data?.sessionEvidence?.find(
    (item) => item.sessionId === selectedSession?.id,
  );
  const approvalDecisions = (data?.decisions || []).filter(
    (item) =>
      item.approvalId === selectedApproval?.id &&
      item.sessionId === selectedApproval?.sessionId,
  );
  const approvalEvaluations = (data?.policyEvaluations || []).filter(
    (item) => item.approvalId === selectedApproval?.id,
  );
  const approvalAudit = (data?.auditEntries || []).filter(
    (item) =>
      item.entityId === selectedApproval?.id ||
      approvalDecisions.some((decision) => decision.id === item.entityId),
  );
  const approvalEvent = data?.events.find(
    (event) =>
      event.id === selectedApproval?.sourceEventId &&
      event.sessionId === selectedApproval.sessionId &&
      event.taskId === selectedApproval.taskId,
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
    const mode = projectRepositoryMode;
    await perform(async () => {
      const result = await mutate("/projects", {
        name: form.get("name"),
        workspace: form.get("workspace"),
        objective: form.get("objective"),
        createWorkspace: form.get("createWorkspace") === "on",
        initializeGit: form.get("initializeGit") === "on",
        githubRepo:
          mode === "reference"
            ? form.get("githubRepo") || undefined
            : undefined,
      });
      const id = result.project?.id || result.id;
      clearDraft("project");
      if (id) changeProject(id);
      setDialog(null);
      setProjectRepositoryMode("local");
      setNotice(
        "Project created locally. Launch the orchestrator when you are ready.",
      );
      if (!id || !["link", "create"].includes(mode)) return;
      const initial: InitialRepository = {
        owner: String(form.get("githubOwner") || ""),
        name: String(form.get("githubName") || ""),
        visibility:
          form.get("githubVisibility") === "public" ? "public" : "private",
        repository: String(form.get("githubRepo") || ""),
      };
      setInitialRepository({ ...initial, projectId: id });
      setNav("github");
      if (mode === "link") {
        await mutate(`/projects/${id}/github/link`, {
          repository: initial.repository,
        });
        setNotice("Project created locally and repository access verified.");
      } else {
        await mutate(`/projects/${id}/github/proposals`, {
          kind: "repository.create",
          owner: initial.owner,
          name: initial.name,
          visibility: initial.visibility,
        });
        setNotice(
          "Project created locally. Review its repository proposal before approving any remote creation.",
        );
      }
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
      clearDraft("task");
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
      clearDraft("artifact");
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
            <button
              aria-current={nav === "github" ? "page" : undefined}
              className={nav === "github" ? "active" : ""}
              onClick={() => setNav("github")}
            >
              <Icon name="layers" />
              GitHub
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
          <div
            className="agent-tree"
            role="tree"
            aria-label="Registered project tasks"
          >
            {tasks.map((task) => (
              <button
                key={task.id}
                role="treeitem"
                aria-level={taskDepth(task) + 1}
                aria-selected={selectedTask?.id === task.id}
                aria-expanded={
                  tasks.some((child) => child.parentTaskId === task.id)
                    ? true
                    : undefined
                }
                tabIndex={
                  (treeFocusId || selectedTask?.id || tasks[0]?.id) === task.id
                    ? 0
                    : -1
                }
                onFocus={() => setTreeFocusId(task.id)}
                onKeyDown={(event) => {
                  const index = tasks.findIndex((item) => item.id === task.id);
                  const next =
                    event.key === "ArrowDown"
                      ? tasks[index + 1]
                      : event.key === "ArrowUp"
                        ? tasks[index - 1]
                        : event.key === "Home"
                          ? tasks[0]
                          : event.key === "End"
                            ? tasks.at(-1)
                            : event.key === "ArrowRight"
                              ? tasks.find(
                                  (item) => item.parentTaskId === task.id,
                                )
                              : event.key === "ArrowLeft"
                                ? tasks.find(
                                    (item) => item.id === task.parentTaskId,
                                  )
                                : undefined;
                  if (next) {
                    event.preventDefault();
                    document.getElementById(`task-tree-${next.id}`)?.focus();
                  }
                }}
                id={`task-tree-${task.id}`}
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
                    : nav === "github"
                      ? "Project repository"
                      : "Persona library"}
              </h1>
              <p>
                {nav === "desk"
                  ? "See what needs you. Keep every agent moving with context."
                  : nav === "artifacts"
                    ? "Versioned project knowledge, with a clear source and owner."
                    : nav === "github"
                      ? "One profile connection. A reviewed repository and engineering record for each project."
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
                    setDialog(
                      nav === "github"
                        ? "settings"
                        : nav === "artifacts"
                          ? "artifact"
                          : "task",
                    )
                  }
                >
                  <Icon name="plus" size={15} />
                  {nav === "github"
                    ? "Profile connection"
                    : nav === "artifacts"
                      ? "Register artifact"
                      : "Add specialist"}
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
                <strong>{error.operation} could not complete.</strong>{" "}
                {error.message} Decisions are disabled until state is current.
              </span>
              <button className="text-button" onClick={() => void reload()}>
                Retry
              </button>
            </div>
          )}
          {actionError && (
            <div className="banner error" role="alert">
              <span>
                <strong>{actionError.operation} could not complete.</strong>{" "}
                {actionError.message}
                {Object.entries(actionError.fieldErrors).map(
                  ([field, message]) => (
                    <span className="error-field" key={field}>
                      {label(field)}: {message}
                    </span>
                  ),
                )}
                <small className="error-code">
                  {actionError.code}
                  {actionError.retryable
                    ? " · You can try again after reviewing current state."
                    : ""}
                </small>
              </span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setActionError(null)}
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
          ) : !data && error ? (
            <Empty title="Workspace unavailable">
              <p>{error.message}</p>
              <button className="button" onClick={() => void reload()}>
                Reconnect to local service
              </button>
            </Empty>
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
          ) : nav === "github" ? (
            <GitHubProject
              key={data.project.id}
              api={apiClient}
              busy={busy || Boolean(error)}
              run={perform}
              notify={setNotice}
              project={data.project}
              refreshWorkspace={reload}
              openSettings={() => setDialog("settings")}
              initialRepository={
                initialRepository?.projectId === data.project.id
                  ? initialRepository
                  : undefined
              }
            />
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
                    <h2 id="inspector-heading" tabIndex={-1}>
                      {selectedPersona.name}
                    </h2>
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
                    <PersonaMetadata
                      persona={selectedPersona}
                      skills={data.skills || []}
                    />
                    <PersonaEditor
                      key={selectedPersona.id}
                      source={selectedPersona}
                      skills={data.skills || []}
                      api={apiClient}
                      busy={busy}
                      run={perform}
                      notify={setNotice}
                    />
                  </>
                ) : selectedArtifact ? (
                  <>
                    <div className="eyebrow">
                      Project context · Version {selectedArtifact.version}
                    </div>
                    <h2 id="inspector-heading" tabIndex={-1}>
                      {selectedArtifact.logicalKey}
                    </h2>
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
                      {selectedArtifact.sourceSessionId && (
                        <>
                          <dt>Original session</dt>
                          <dd>
                            <code>{selectedArtifact.sourceSessionId}</code>
                          </dd>
                        </>
                      )}
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
                    {selectedArtifact.inputArtifacts && (
                      <section
                        className="proposal-inputs"
                        aria-label="Immutable artifact inputs"
                      >
                        <h3>Exact source inputs</h3>
                        {selectedArtifact.inputArtifacts.map((input) => (
                          <div className="pinned-input" key={input.id}>
                            <strong>
                              {input.logicalKey} · v{input.version}
                            </strong>
                            <code>{input.id}</code>
                            <span>
                              Source commit:{" "}
                              <code>{input.sourceCommit || "Unavailable"}</code>
                            </span>
                          </div>
                        ))}
                      </section>
                    )}
                    <pre className="content-text" tabIndex={0}>
                      {selectedArtifact.content ||
                        "This artifact has no retained content. Review its source reference and summary."}
                    </pre>
                    {selectedArtifact.logicalKey === "issue_proposals" && (
                      <ArtifactIssuePlan
                        key={selectedArtifact.id}
                        artifact={selectedArtifact}
                        project={data.project}
                        api={apiClient}
                        busy={busy || Boolean(error)}
                        run={perform}
                        notify={setNotice}
                        openProposals={() => setNav("github")}
                      />
                    )}
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
                    <h2 id="inspector-heading" tabIndex={-1}>
                      {selectedApproval?.summary || selectedTask.name}
                    </h2>
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
                        <div className="observation-state">
                          <Badge
                            state={
                              selectedObservation.terminalStatus || "unknown"
                            }
                          />
                          <span>
                            Advisory interpretation:{" "}
                            {label(selectedObservation.classification)}
                          </span>
                        </div>
                        {selectedObservation.classification === "ambiguous" && (
                          <p className="form-note">
                            This update needs interpretation. No decision or
                            task acceptance is inferred from it.
                          </p>
                        )}
                        <small>
                          Classification is advisory. Replying does not approve
                          an action or accept completion.
                        </small>
                        {(originUnavailable || historicalSession) && (
                          <div className="evidence-gap">
                            The originating session is unavailable for this
                            update. You can mark it read; a reply will not be
                            redirected into a replacement session.
                          </div>
                        )}
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
                            disabled={originUnavailable || historicalSession}
                            rows={3}
                            required
                            placeholder="Reply with the context they need…"
                            value={reply}
                            onChange={(event) => setReply(event.target.value)}
                          />
                          <div className="form-inline-actions">
                            <button
                              className="button primary compact"
                              disabled={
                                busy ||
                                !reply.trim() ||
                                originUnavailable ||
                                historicalSession
                              }
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
                          {selectedSession &&
                            !originUnavailable &&
                            !historicalSession && (
                              <div className="history-loader">
                                <button
                                  className="button compact"
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(async () => {
                                      const result = await mutate(
                                        `${taskPath}/history`,
                                        { includeText: true },
                                      );
                                      setNotice(
                                        `Native history loaded: ${result.entries} entries, ${result.gaps} evidence gaps. Former approvals remain invalid.`,
                                      );
                                    })
                                  }
                                >
                                  Load native history for inspection
                                </button>
                                <small>
                                  Loads supported transcript context into this
                                  local view. Retention settings control
                                  persistence. It does not restore old approval
                                  authority.
                                </small>
                              </div>
                            )}
                          {selectedApproval && !approvalEvent && (
                            <div className="evidence-gap" role="status">
                              The approval's source event is unavailable in the
                              retained timeline. Its action binding remains
                              pinned above; no other session's event is
                              substituted.
                            </div>
                          )}
                          {sessionEvidence?.historyGaps.map((gap, index) => (
                            <div className="evidence-gap" key={index}>
                              {gap}
                            </div>
                          ))}
                          {sessionEvents.length > 60 && (
                            <button
                              className="text-button"
                              onClick={() =>
                                setShowAllActivity(!showAllActivity)
                              }
                            >
                              {showAllActivity
                                ? "Show recent activity"
                                : `Show all ${sessionEvents.length} available entries`}
                            </button>
                          )}
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
                                    <pre className="event-text" tabIndex={0}>
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
                            {(sessionEvidence?.gitBase ||
                              sessionEvidence?.gitHead) && (
                              <dl className="facts">
                                <dt>Captured base</dt>
                                <dd>
                                  {sessionEvidence.gitBase || "Unavailable"}
                                </dd>
                                <dt>Captured head</dt>
                                <dd>
                                  {sessionEvidence.gitHead || "Unavailable"}
                                </dd>
                              </dl>
                            )}
                            <p className="muted small">
                              {taskGitRefs ||
                                "Unavailable: no task artifact source commit was captured."}
                            </p>
                            <p className="muted small">
                              Artifact provenance is separate from captured
                              execution diff evidence.{" "}
                              {(!sessionEvidence?.gitBase ||
                                !sessionEvidence?.gitHead) &&
                                "Complete diff base/head evidence is unavailable."}
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
                            <dt>Pinned persona</dt>
                            <dd>
                              {sessionPersona?.name || "Unavailable"} · v
                              {sessionPersona?.version ?? "unavailable"}
                            </dd>
                            <dt>Context digest</dt>
                            <dd>
                              {selectedSession?.contextDigest ||
                                "Unavailable: this session has no captured context digest."}
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
                              {sessionEvidence?.sandboxSummary ||
                                "Exact current sandbox evidence is unavailable in this inspector."}{" "}
                              Native approval does not grant persistent session
                              permissions.
                            </dd>
                          </dl>
                          <h3 className="subheading">
                            Pinned session artifact inputs
                          </h3>
                          {selectedSession?.artifactInputs?.length ? (
                            selectedSession.artifactInputs.map((input) => (
                              <div className="pinned-input" key={input.id}>
                                <strong>
                                  {input.logicalKey} · v{input.version}
                                </strong>
                                <code>
                                  {input.sourceCommit ||
                                    "No source commit captured"}
                                </code>
                                {!data.artifacts.some(
                                  (artifact) => artifact.id === input.id,
                                ) && (
                                  <span className="evidence-gap">
                                    Referenced artifact content is unavailable.
                                  </span>
                                )}
                              </div>
                            ))
                          ) : (
                            <p className="muted small">
                              No artifact input references were captured for
                              this session.
                            </p>
                          )}
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
                                <strong>Recorded policy checks</strong>
                                {approvalEvaluations.length ? (
                                  approvalEvaluations.map((check) => (
                                    <div
                                      className="recorded-check"
                                      key={check.id}
                                    >
                                      <Badge state={check.outcome} />
                                      <strong>{label(check.check)}</strong>
                                      <p>{check.summary}</p>
                                      <time>
                                        {new Date(
                                          check.checkedAt,
                                        ).toLocaleString()}
                                      </time>
                                    </div>
                                  ))
                                ) : (
                                  <p>
                                    No recorded policy evaluations are available
                                    for this approval.
                                  </p>
                                )}
                              </div>
                              <div>
                                <strong>Recorded human decisions</strong>
                                {approvalDecisions.length ? (
                                  approvalDecisions.map((decision) => (
                                    <div
                                      className="recorded-check"
                                      key={decision.id}
                                    >
                                      <strong>
                                        {decision.resolver} ·{" "}
                                        {label(decision.decision)}
                                      </strong>
                                      <p>
                                        Delivery: {label(decision.delivery)} ·
                                        Policy {decision.policySnapshotId}
                                      </p>
                                      <time>
                                        {new Date(
                                          decision.issuedAt,
                                        ).toLocaleString()}
                                      </time>
                                    </div>
                                  ))
                                ) : (
                                  <p>
                                    No human decision record is available for
                                    this approval.
                                  </p>
                                )}
                                <p>
                                  Only recorded resolver evidence is shown. No
                                  delegated judgment is inferred.
                                </p>
                              </div>
                              <div>
                                <strong>Audit provenance</strong>
                                {approvalAudit.length ? (
                                  approvalAudit.map((entry) => (
                                    <div
                                      className="recorded-check"
                                      key={entry.id}
                                    >
                                      <strong>
                                        {entry.actor} · {entry.operation}
                                      </strong>
                                      <p>
                                        Revision {entry.revision} · Event{" "}
                                        {entry.sequence}
                                      </p>
                                      <code>{entry.hash}</code>
                                      <time>
                                        {new Date(
                                          entry.timestamp,
                                        ).toLocaleString()}
                                      </time>
                                    </div>
                                  ))
                                ) : (
                                  <p>
                                    No scoped audit entries were returned for
                                    this approval.
                                  </p>
                                )}
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
                          {historicalSession || originUnavailable ? (
                            <>
                              <p className="form-note">
                                This view belongs to an earlier session. Actions
                                will not be redirected into its replacement.
                              </p>
                              <button
                                className="button"
                                onClick={() =>
                                  choose({ kind: "task", id: selectedTask.id })
                                }
                              >
                                Inspect current task session
                              </button>
                            </>
                          ) : (
                            <>
                              {!selectedSession ||
                              ["terminated", "failed", "disconnected"].includes(
                                selectedSession.state,
                              ) ? (
                                <>
                                  {selectedSession?.bindingRef &&
                                    !historicalSession && (
                                      <button
                                        className="button primary"
                                        disabled={
                                          busy ||
                                          !data.status.codexAvailable ||
                                          selectedTask.state === "completed"
                                        }
                                        onClick={() =>
                                          void perform(async () => {
                                            await mutate(`${taskPath}/resume`);
                                            setNotice(
                                              "Conversation recovered into a fresh registered session. Previous approvals stay invalid; send a message to continue.",
                                            );
                                          })
                                        }
                                      >
                                        Resume conversation
                                      </button>
                                    )}
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
                                    {selectedSession
                                      ? "Start fresh session"
                                      : "Launch agent"}
                                  </button>
                                </>
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
                                      setNotice(
                                        "Task completion accepted by you.",
                                      );
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
                            </>
                          )}
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
                              historicalSession ||
                              originUnavailable ||
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
                                historicalSession ||
                                originUnavailable ||
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
                      : "Profile & workspace settings"}
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
                <strong>{actionError.operation} could not complete.</strong>
                <p>{actionError.message}</p>
                {Object.entries(actionError.fieldErrors).map(
                  ([field, message]) => (
                    <p key={field}>
                      <button
                        type="button"
                        className="text-button field-error-link"
                        onClick={() =>
                          modalRef.current
                            ?.querySelector<HTMLElement>(
                              `[name="${CSS.escape(field)}"]`,
                            )
                            ?.focus()
                        }
                      >
                        <strong>{label(field)}:</strong> {message}
                      </button>
                    </p>
                  ),
                )}
                <small>
                  {actionError.code}
                  {actionError.retryable
                    ? " · Review current state, then try again."
                    : ""}
                </small>
              </div>
            )}
            {dialog === "project" ? (
              <form
                onChange={(event) =>
                  rememberDraft("project", event.currentTarget)
                }
                onSubmit={(event) => void submitProject(event)}
              >
                <p className="modal-description">
                  Start with an objective and a local workspace. Your
                  orchestrator launches when you choose.
                </p>
                <label>
                  Project name
                  <input
                    name="name"
                    defaultValue={draft("project", "name")}
                    required
                    maxLength={100}
                    placeholder="My next project"
                    onBlur={(event) => {
                      const form = event.currentTarget.form;
                      const repositoryInput =
                        form?.elements.namedItem("githubName");
                      if (
                        form &&
                        repositoryInput instanceof HTMLInputElement &&
                        !repositoryInput.value
                      ) {
                        repositoryInput.value = event.currentTarget.value
                          .toLowerCase()
                          .replace(/[^a-z0-9._-]+/g, "-")
                          .replace(/^-+|-+$/g, "")
                          .slice(0, 100);
                        rememberDraft("project", form);
                      }
                    }}
                    autoFocus
                  />
                </label>
                <label>
                  Local workspace
                  <input
                    name="workspace"
                    defaultValue={draft("project", "workspace")}
                    required
                    placeholder="/absolute/path/to/project"
                    pattern="(?:/|~/).*"
                  />
                  <small>
                    Use an absolute path or ~/folder. Agents work within this
                    project boundary.
                  </small>
                </label>
                <label className="checkbox-option">
                  <input
                    type="checkbox"
                    name="createWorkspace"
                    defaultChecked={
                      draft("project", "createWorkspace") === "on"
                    }
                  />
                  Create this folder if missing
                </label>
                <label className="checkbox-option">
                  <input
                    type="checkbox"
                    name="initializeGit"
                    defaultChecked={draft("project", "initializeGit") === "on"}
                  />
                  Initialize Git if needed{" "}
                  <small>
                    Creates an empty initial commit; existing files remain
                    unstaged.
                  </small>
                </label>
                <label>
                  Project objective
                  <textarea
                    name="objective"
                    defaultValue={draft("project", "objective")}
                    required
                    rows={3}
                    placeholder="What should the team build, and how will you know it's done?"
                  />
                </label>
                <fieldset className="project-repository-setup">
                  <legend>Project repository</legend>
                  <label htmlFor="new-project-repository-mode">
                    Setup mode
                  </label>
                  <select
                    id="new-project-repository-mode"
                    name="githubMode"
                    value={projectRepositoryMode}
                    onChange={(event) =>
                      setProjectRepositoryMode(event.target.value)
                    }
                  >
                    <option value="local">Local project only</option>
                    <option value="reference">
                      Keep an unverified repository reference
                    </option>
                    {githubProfile?.connected && (
                      <>
                        <option value="link">
                          Verify and link an existing repository
                        </option>
                        <option
                          value="create"
                          disabled={
                            !githubProfile.capabilities.repositoryCreate
                          }
                        >
                          Prepare a new repository for approval
                        </option>
                      </>
                    )}
                  </select>
                  <small>
                    {githubLoading
                      ? "Checking profile connection…"
                      : githubProfile?.connected
                        ? `Profile connected as ${githubProfile.identity?.login}. This project chooses its own repository.`
                        : githubFailure
                          ? "GitHub connection status is unavailable. Local setup still works."
                          : "GitHub is not connected. Connect in profile settings to verify links or prepare repository creation."}
                  </small>
                  {!githubProfile?.connected && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setDialog("settings")}
                    >
                      Open profile connection settings
                    </button>
                  )}
                  {(projectRepositoryMode === "reference" ||
                    projectRepositoryMode === "link") && (
                    <label>
                      Repository
                      <input
                        name="githubRepo"
                        defaultValue={draft("project", "githubRepo")}
                        required
                        placeholder="owner/repository"
                      />
                      <small>
                        {projectRepositoryMode === "reference"
                          ? "Stored as a local reference only; account access is not verified."
                          : "Current profile account access is checked before linking."}
                      </small>
                    </label>
                  )}
                  {projectRepositoryMode === "create" && (
                    <>
                      <label>
                        Repository owner
                        <select
                          name="githubOwner"
                          required
                          defaultValue={draft(
                            "project",
                            "githubOwner",
                            githubProfile?.identity?.login || "",
                          )}
                        >
                          <option value="" disabled>
                            Choose an authorized owner
                          </option>
                          {githubProfile?.owners.map((owner) => (
                            <option key={owner.id} value={owner.login}>
                              {owner.login}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Repository name
                        <input
                          name="githubName"
                          required
                          defaultValue={draft(
                            "project",
                            "githubName",
                            draft("project", "name")
                              .toLowerCase()
                              .replace(/[^a-z0-9._-]+/g, "-")
                              .replace(/^-+|-+$/g, "")
                              .slice(0, 100),
                          )}
                          maxLength={100}
                          placeholder="project-name"
                        />
                      </label>
                      <label>
                        Visibility
                        <select
                          name="githubVisibility"
                          defaultValue={draft(
                            "project",
                            "githubVisibility",
                            "private",
                          )}
                        >
                          <option value="private">Private</option>
                          <option value="public">Public</option>
                        </select>
                      </label>
                      <p className="form-note">
                        The project is created locally first. Repository
                        creation waits for your approval of the exact account,
                        owner, name and visibility.
                      </p>
                    </>
                  )}
                </fieldset>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="button"
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      (["link", "create"].includes(projectRepositoryMode) &&
                        (githubLoading || !githubProfile?.connected))
                    }
                  >
                    {projectRepositoryMode === "create"
                      ? "Create project & prepare proposal"
                      : projectRepositoryMode === "link"
                        ? "Create project & verify link"
                        : "Create local project"}
                    <Icon name="arrow" size={14} />
                  </button>
                </div>
              </form>
            ) : dialog === "task" ? (
              <form
                onChange={(event) => rememberDraft("task", event.currentTarget)}
                onSubmit={(event) => void submitTask(event)}
              >
                <p className="modal-description">
                  Give a specialist a clear objective and a place in the agent
                  tree.
                </p>
                <label>
                  Task name
                  <input
                    name="name"
                    defaultValue={draft("task", "name")}
                    required
                    maxLength={100}
                    placeholder="Review the architecture"
                    autoFocus
                  />
                </label>
                <label>
                  Parent agent
                  <select
                    name="parentTaskId"
                    required
                    defaultValue={draft(
                      "task",
                      "parentTaskId",
                      selectedTask?.id || data?.project?.rootTaskId || "",
                    )}
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
                    defaultValue={draft(
                      "task",
                      "personaId",
                      selectedPersona?.id || "",
                    )}
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
                    defaultValue={draft("task", "objective")}
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
              <form
                onChange={(event) =>
                  rememberDraft("artifact", event.currentTarget)
                }
                onSubmit={(event) => void submitArtifact(event)}
              >
                <p className="modal-description">
                  Add a versioned piece of project context. New artifacts start
                  as drafts.
                </p>
                <label>
                  Logical key
                  <input
                    name="logicalKey"
                    defaultValue={draft("artifact", "logicalKey")}
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
                    defaultValue={draft(
                      "artifact",
                      "taskId",
                      selectedTask?.id || data?.project?.rootTaskId || "",
                    )}
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
                  <textarea
                    name="summary"
                    defaultValue={draft("artifact", "summary")}
                    required
                    rows={2}
                  />
                </label>
                <label>
                  Content <span className="optional">optional</span>
                  <textarea
                    name="content"
                    defaultValue={draft("artifact", "content")}
                    rows={5}
                    placeholder="Project context retained locally…"
                  />
                </label>
                <label>
                  Source reference <span className="optional">optional</span>
                  <input
                    name="externalRef"
                    defaultValue={draft("artifact", "externalRef")}
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
                <GitHubSettings
                  api={apiClient}
                  busy={busy}
                  run={perform}
                  notify={setNotice}
                />
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
