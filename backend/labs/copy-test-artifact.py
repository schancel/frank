#!/usr/bin/env python3
"""Copy one test executable emitted by the current successful Cargo invocation."""
import json
from pathlib import Path
import shutil
import subprocess
import sys


def select_executable(artifacts):
    executables = {
        artifact["executable"]
        for artifact in artifacts
        if artifact.get("reason") == "compiler-artifact"
        and artifact.get("profile", {}).get("test") is True
        and artifact.get("executable")
    }
    if len(executables) != 1:
        raise ValueError(f"expected exactly one current Cargo test executable, got {len(executables)}")
    return Path(executables.pop())


def main():
    artifact_file, destination, expected_test = sys.argv[1:]
    with open(artifact_file, encoding="utf-8") as stream:
        executable = select_executable(json.loads(line) for line in stream if line.strip())
    listing = subprocess.check_output([str(executable), "--list"], text=True)
    names = [line.removesuffix(": test") for line in listing.splitlines() if line.endswith(": test")]
    if not any(name == expected_test or name.endswith("::" + expected_test) for name in names):
        raise ValueError(f"current test executable does not contain {expected_test}")
    shutil.copy2(executable, destination)


if __name__ == "__main__":
    main()
