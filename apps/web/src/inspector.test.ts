import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectionSessionIds, inspectionEvents } from "./inspector.js";
import type {
  Session,
  ActivityEvent,
} from "../../../packages/domain/src/index.js";

const original = {
  id: "original",
  projectId: "project-a",
  taskId: "task-a",
} as Session;
const resumed = {
  id: "resumed",
  projectId: "project-a",
  taskId: "task-a",
  resumedFrom: "original",
} as Session;
const unrelated = {
  id: "unrelated",
  projectId: "project-a",
  taskId: "task-a",
} as Session;
test("approval origin excludes replacement session while ordinary resumed chat includes its exact ancestry", () => {
  assert.deepEqual(
    [...inspectionSessionIds(original, [original, resumed, unrelated], true)],
    ["original"],
  );
  assert.deepEqual(
    [...inspectionSessionIds(resumed, [original, resumed, unrelated], false)],
    ["resumed", "original"],
  );
  const events = [
    { id: "old", taskId: "task-a", sessionId: "original" },
    { id: "new", taskId: "task-a", sessionId: "resumed" },
    { id: "other", taskId: "task-a", sessionId: "unrelated" },
  ] as ActivityEvent[];
  assert.deepEqual(
    inspectionEvents(
      events,
      "task-a",
      original,
      [original, resumed, unrelated],
      true,
    ).map((e) => e.id),
    ["old"],
  );
});
test("forged cross-project ancestry and cycles cannot broaden inspector context", () => {
  const foreign = {
    id: "foreign",
    projectId: "project-b",
    taskId: "task-a",
  } as Session;
  assert.deepEqual(
    [
      ...inspectionSessionIds(
        { ...resumed, resumedFrom: "foreign" },
        [foreign],
        false,
      ),
    ],
    ["resumed"],
  );
  assert.deepEqual(
    [
      ...inspectionSessionIds(
        { ...resumed, resumedFrom: "resumed" },
        [resumed],
        false,
      ),
    ],
    ["resumed"],
  );
});

test("missing original session metadata never substitutes another session", () => {
  const events = [
    { id: "old", taskId: "task-a", sessionId: "original" },
    { id: "new", taskId: "task-a", sessionId: "resumed" },
    { id: "foreign", taskId: "task-b", sessionId: "original" },
  ] as ActivityEvent[];
  assert.deepEqual(
    inspectionEvents(
      events,
      "task-a",
      undefined,
      [resumed],
      true,
      "original",
    ).map((e) => e.id),
    ["old"],
  );
});
