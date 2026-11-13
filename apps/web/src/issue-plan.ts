export type IssuePlanEntry = { title: string; body: string; labels?: string[] };

/** Fail as a whole so a malformed entry can never shift the server's issue index. */
export function displayIssuePlan(
  content: string | null,
): IssuePlanEntry[] | null {
  try {
    const value: unknown = JSON.parse(content || "");
    if (!Array.isArray(value) || !value.length) return null;
    if (
      !value.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof entry.title === "string" &&
          entry.title.trim() &&
          typeof entry.body === "string" &&
          (entry.labels === undefined ||
            (Array.isArray(entry.labels) &&
              entry.labels.every(
                (label: unknown) => typeof label === "string",
              ))),
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
