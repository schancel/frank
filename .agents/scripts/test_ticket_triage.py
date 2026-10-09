#!/usr/bin/env python3
"""Pure-function checks for ticket_triage.score and READY vs NEEDS_SPECIFICATION."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from issue_export import READINESS_STATES
from ticket_triage import readiness, score


def test_score_formula() -> None:
    issue = {"value": 5, "cost": 2, "certainty": 4, "unblocking": 1}
    assert score(issue) == 5 * 4 * (1 + 1) / 2


def test_score_rejects_partial() -> None:
    assert score({"value": 5, "cost": 2, "certainty": 4}) is None
    assert score({"value": 6, "cost": 2, "certainty": 4, "unblocking": 1}) is None


def test_script_classifies(tmp_path: Path) -> None:
    payload = [
        {
            "number": 1,
            "title": "ready",
            "body": "acceptance criteria and owner: maintainer",
            "value": 3,
            "cost": 1,
            "certainty": 5,
            "unblocking": 1,
            "files": ["src/a.rs"],
        },
        {
            "number": 2,
            "title": "unready",
            "body": "an idea",
            "files": ["src/a.rs"],
        },
    ]
    path = tmp_path / "issues.json"
    path.write_text(json.dumps(payload))
    script = Path(__file__).with_name("ticket_triage.py")
    result = subprocess.run(
        [sys.executable, str(script), str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "30.00\tREADY\t1\tready\t" in result.stdout
    assert "NEEDS_SPECIFICATION\t2\tunready\tacceptance,owner" in result.stdout
    assert "src/a.rs: #1, #2" in result.stdout



def test_explicit_states_override_scores_and_markers() -> None:
    issue = {"body": "acceptance criteria; owner: maintainer", "value": 3,
             "cost": 1, "certainty": 5, "unblocking": 1}
    assert readiness(issue) == ("READY", [])
    for state in READINESS_STATES:
        assert readiness({**issue, "body": f"State: {state}\n" + issue["body"]}) == (state, [])
    assert readiness({**issue, "body": "State: READY\nowner: maintainer"}) == (
        "NEEDS_SPECIFICATION", ["acceptance"])
    assert readiness({**issue, "body": "State: READY\nacceptance criteria"}) == (
        "NEEDS_SPECIFICATION", ["owner"])
    assert readiness({**issue, "cost": None}) == ("NEEDS_SPECIFICATION", [])
    # The original body, not a stale derived export field, owns the declaration.
    assert readiness({**issue, "body": "State: NEEDS_SPECIFICATION\n" + issue["body"],
                      "readiness_state": "READY"}) == ("NEEDS_SPECIFICATION", [])


def main() -> int:
    test_score_formula()
    test_explicit_states_override_scores_and_markers()
    test_score_rejects_partial()
    with tempfile.TemporaryDirectory() as directory:
        test_script_classifies(Path(directory))
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
