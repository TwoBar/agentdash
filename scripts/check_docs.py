#!/usr/bin/env python3
"""Check tracked/planned documentation links and the initial planning graph.

Uses only the Python standard library. Does not contact GitHub or require model
credentials. GitHub remains the source of truth for current issue status.
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]


def main():
    errors = []
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    ).decode().split("\0")
    markdown = [ROOT / p for p in set(paths) if p.endswith(".md")]
    links_checked = 0
    for path in markdown:
        if not path.is_file():
            continue
        content = path.read_text(encoding="utf-8")
        for match in re.finditer(r"!?\[[^\]\n]*\]\(([^)\n]+)\)", content):
            target = match.group(1).strip()
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            destination = path.parent / unquote(parsed.path)
            links_checked += 1
            if not destination.exists():
                errors.append(f"{path.relative_to(ROOT)}: missing local target {target}")

    try:
        catalog = json.loads((ROOT / "docs/planning/backlog.json").read_text())
        if catalog["schema_version"] != 1:
            errors.append("Unsupported planning catalog schema")
        issues = catalog["issues"]
        by_id = {issue["id"]: issue for issue in issues}
        if len(by_id) != len(issues):
            errors.append("Duplicate issue IDs")
        milestone_ids = [m["id"] for m in catalog["milestones"]]
        if len(set(milestone_ids)) != len(milestone_ids):
            errors.append("Duplicate milestone IDs")
        label_names = [label["name"] for label in catalog["labels"]]
        if len(set(label_names)) != len(label_names):
            errors.append("Duplicate labels")
        for label in catalog["labels"]:
            if not re.fullmatch(r"[0-9A-Fa-f]{6}", label["color"]):
                errors.append(f"Invalid label color: {label['name']}")
        backlog = (ROOT / "docs/BACKLOG.md").read_text()
        for issue in issues:
            key = issue["id"]
            if not re.fullmatch(r"AGCP-\d{3}", key):
                errors.append(f"Invalid issue ID: {key}")
            for field in ("title", "outcome", "scope", "acceptance", "verification", "references"):
                if not issue[field]:
                    errors.append(f"{key}: missing {field}")
            if issue["milestone"] not in milestone_ids:
                errors.append(f"{key}: unknown milestone")
            status = "backlog" if issue["milestone"] == "M7" else (
                "blocked" if issue["dependencies"] else "ready"
            )
            scope = "next" if issue["milestone"] == "M7" else "mvp"
            expected_labels = [
                "priority:" + issue["priority"], "kind:" + issue["kind"],
                "area:" + issue["area"], "status:" + status, "scope:" + scope,
            ]
            for label in expected_labels:
                if label not in label_names:
                    errors.append(f"{key}: undefined label {label}")
            if key not in backlog:
                errors.append(f"{key}: absent from readable backlog")
            for dependency in issue["dependencies"]:
                if dependency not in by_id:
                    errors.append(f"{key}: unknown dependency {dependency}")

        visited, active = set(), set()

        def visit(key):
            if key in active:
                errors.append(f"Dependency cycle at {key}")
                return
            if key in visited or key not in by_id:
                return
            active.add(key)
            for dependency in by_id[key]["dependencies"]:
                visit(dependency)
            active.remove(key)
            visited.add(key)

        for key in by_id:
            visit(key)

        refs_path = ROOT / "docs/planning/github-issues.json"
        if refs_path.exists():
            refs = json.loads(refs_path.read_text())
            if set(refs) != set(by_id):
                errors.append("Published issue references differ from planning IDs")
            numbers = [ref["number"] for ref in refs.values()]
            if len(set(numbers)) != len(numbers):
                errors.append("Duplicate published issue numbers")
            for key, ref in refs.items():
                expected_url = f"https://github.com/{catalog['repository']}/issues/{ref['number']}"
                if ref["url"] != expected_url:
                    errors.append(f"{key}: inconsistent GitHub URL")
                if ref["url"] not in backlog:
                    errors.append(f"{key}: published issue link missing from readable backlog")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(f"Planning catalog could not be checked: {exc}")

    if errors:
        print("Documentation/planning checks failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(
        f"Checked {len(markdown)} Markdown files, {links_checked} local links, "
        f"{len(issues)} issues, and an acyclic dependency graph."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
