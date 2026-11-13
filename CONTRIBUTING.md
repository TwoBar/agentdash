# Contributing

The project has an experimental local build. Read the [roadmap](docs/ROADMAP.md), current GitHub issue and accepted runtime decision before changing behavior. M0 evidence is recorded; future work follows the dependency graph and release gates.

Use a short-lived branch such as `spike/agcp-001-native-approvals` or `feat/agcp-005-domain-contracts`. Open a PR against `main`, reference the issue with `Closes #N`, and explain the resulting behavior, acceptance evidence, and known limitations. Keep changes scoped enough to review.

An issue is ready when its dependencies are complete, expected behavior and acceptance criteria are clear, and required architecture decisions are recorded. Initial `status:ready`, `status:blocked`, and `status:backlog` labels are planning aids; update them as dependencies change.

An issue is done when its acceptance criteria pass, relevant checks pass, user-facing behavior is documented, and evidence is linked. A completed model turn is not proof that an application task has met its acceptance criteria. A milestone closes only when its exit criteria and acceptance evidence are satisfied.

For the full local checks:

```sh
npm run check
```

CI runs type checks, focused tests, production builds and documentation checks. Native model-backed probes are explicit local experiments and are not run in CI. Use synthetic examples and keep credentials, production data, real session content, and governance state out of commits and issue attachments.

Changes to requirements should update the relevant specification and decision record in the same PR. GitHub owns current issue status; the checked-in planning catalog records the initial scope and dependency graph.

The repository has no license grant yet. Resolve licensing before accepting external code contributions or redistributing a release.
