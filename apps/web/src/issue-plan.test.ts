import { test } from "node:test";
import assert from "node:assert/strict";
import { displayIssuePlan } from "./issue-plan.js";

test("issue-plan display preserves exact source order, content and optional labels", () => {
  const issues = [
    { title: "First", body: "Exact\nbody", labels: ["planning"] },
    { title: "Second", body: "" },
  ];
  assert.deepEqual(displayIssuePlan(JSON.stringify(issues)), issues);
});
test("a malformed middle entry disables the whole plan rather than shifting publication indices", () => {
  assert.equal(
    displayIssuePlan(
      JSON.stringify([
        { title: "First", body: "OK" },
        { title: "Malformed" },
        { title: "Third", body: "Do not become index 1" },
      ]),
    ),
    null,
  );
});
test("missing, malformed and misleading issue content has no publishable display entries", () => {
  for (const content of [
    null,
    "invalid",
    "[]",
    "{}",
    '[{"title":"A","body":"B","labels":"bug"}]',
    '[{"title":" ","body":"B"}]',
  ])
    assert.equal(displayIssuePlan(content), null);
});
