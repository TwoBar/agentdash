import type {
  Session,
  ActivityEvent,
} from "../../../packages/domain/src/index.js";

/** Exact approval/observation views never borrow a replacement session's context. */
export function inspectionSessionIds(
  source: Session | undefined,
  sessions: Session[],
  exactOrigin: boolean,
): Set<string> {
  const ids = new Set<string>();
  let session = source;
  while (session && !ids.has(session.id)) {
    ids.add(session.id);
    if (exactOrigin || !session.resumedFrom) break;
    const previous = sessions.find(
      (candidate) => candidate.id === session?.resumedFrom,
    );
    if (
      !previous ||
      previous.projectId !== source?.projectId ||
      previous.taskId !== source.taskId
    )
      break;
    session = previous;
  }
  return ids;
}

export function inspectionEvents(
  events: ActivityEvent[],
  taskId: string | undefined,
  source: Session | undefined,
  sessions: Session[],
  exactOrigin: boolean,
  requestedSessionId?: string,
): ActivityEvent[] {
  const ids = inspectionSessionIds(source, sessions, exactOrigin);
  return events.filter(
    (event) =>
      (!taskId || event.taskId === taskId) &&
      (exactOrigin && requestedSessionId
        ? !event.sessionId || event.sessionId === requestedSessionId
        : !source || !event.sessionId || ids.has(event.sessionId)),
  );
}
