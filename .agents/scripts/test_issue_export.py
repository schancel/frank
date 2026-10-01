#!/usr/bin/env python3
"""Checks for issue_export parsing and paginated GitHub export."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from issue_export import from_gh_issues, main as export_main, parse_body


def test_parse_queue_fields() -> None:
    body = "owner: @a\n\n## Queue\nvalue: 4\ncost: 2\ncertainty: 5\nunblocking: 1\nfiles: install.sh other.md\n"
    row = parse_body(body)
    assert row["value"] == 4
    assert row["cost"] == 2
    assert row["certainty"] == 5
    assert row["unblocking"] == 1
    assert row["files"] == ["install.sh", "other.md"]


def test_parse_ignores_inline_digits() -> None:
    row = parse_body("the value: 9 is a joke\ncost is high\n")
    assert "value" not in row
    assert "cost" not in row
    assert row["files"] == []


def test_from_gh_issues() -> None:
    issues = from_gh_issues(
        [{"number": 1, "title": "t", "body": "value: 3\ncost: 1\ncertainty: 5\nunblocking: 2\n"}]
    )
    assert issues[0]["number"] == 1
    assert issues[0]["value"] == 3
    assert issues[0]["unblocking"] == 2


def test_main_exports_all_paginated_issues_and_excludes_pull_requests() -> None:
    legacy_issues = [
        {"number": number, "title": f"issue {number}", "body": ""}
        for number in range(1, 101)
    ]
    pull_request = {
        "number": 900,
        "title": "pull request sentinel",
        "body": "",
        "pull_request": {"url": "https://api.github.test/pulls/900"},
    }
    first_page = [*legacy_issues[:99], pull_request]
    second_page = [
        legacy_issues[99],
        {
            "number": 185,
            "title": "ready beyond the old boundary",
            "body": "value: 5\ncost: 1\ncertainty: 5\nunblocking: 5\nfiles: queue.py\n",
        }
    ]

    def fake_run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if cmd[:3] == ["gh", "issue", "list"]:
            return subprocess.CompletedProcess(cmd, 0, json.dumps(legacy_issues), "")
        assert cmd == [
            "gh",
            "api",
            "--method",
            "GET",
            "--paginate",
            "--slurp",
            "repos/example/project/issues",
            "-f",
            "state=open",
            "-f",
            "per_page=100",
        ]
        return subprocess.CompletedProcess(cmd, 0, json.dumps([first_page, second_page]), "")

    stdout = io.StringIO()
    with (
        patch.object(sys, "argv", ["issue_export.py", "--repo", "example/project"]),
        patch("issue_export.subprocess.run", side_effect=fake_run),
        redirect_stdout(stdout),
    ):
        assert export_main() == 0

    exported = json.loads(stdout.getvalue())
    assert len(exported) == 101
    assert [issue["number"] for issue in exported] == [*range(1, 101), 185]
    assert all(issue["number"] != 900 for issue in exported)
    assert exported[-1]["files"] == ["queue.py"]


def test_main_uses_current_repository_and_propagates_gh_failure() -> None:
    failure = subprocess.CompletedProcess([], 17, "", "gh failed\n")
    stderr = io.StringIO()
    with (
        patch.object(sys, "argv", ["issue_export.py"]),
        patch("issue_export.subprocess.run", return_value=failure) as run,
        redirect_stderr(stderr),
    ):
        assert export_main() == 17

    assert run.call_args.args[0] == [
        "gh",
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "repos/{owner}/{repo}/issues",
        "-f",
        "state=open",
        "-f",
        "per_page=100",
    ]
    assert stderr.getvalue() == "gh failed\n"


def main() -> int:
    test_parse_queue_fields()
    test_parse_ignores_inline_digits()
    test_from_gh_issues()
    test_main_exports_all_paginated_issues_and_excludes_pull_requests()
    test_main_uses_current_repository_and_propagates_gh_failure()
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
