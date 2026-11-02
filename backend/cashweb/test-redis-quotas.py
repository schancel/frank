#!/usr/bin/env python3
"""Run the real Redis quota boundaries on one disposable, ownership-checked CI instance.

This is not a deployment tool. It never mounts host data and only controls its generated
UUID-labelled container. URL, identity, memory and mount receipts precede test execution.
"""
import argparse
import json
import os
import re
from pathlib import Path
import signal
import socket
import subprocess
import time
import uuid

IMAGE = "redis:7.4.12-bookworm@sha256:b6b6e3dc0c0952737748e55d5d885272840c7e42ba41ab1d5489f693419882f5"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    args = parser.parse_args()
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    owner = str(uuid.uuid4())
    (evidence / ".frank-workspace-owner").write_text(owner + "\n")
    docker = ["docker", "--context", args.docker_context]
    manifest = Path(__file__).resolve().parent / "Cargo.toml"
    receipt = {"workspace_uuid": owner, "docker_context": args.docker_context,
               "source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
               "image_reference": IMAGE, "commands": [], "tests": []}
    cid = None

    def save():
        (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def docker_run(arguments, timeout=30):
        return subprocess.run(docker + arguments, text=True, capture_output=True, timeout=timeout)

    def required(arguments, timeout=30):
        result = docker_run(arguments, timeout)
        if result.returncode:
            raise RuntimeError(f"Owned Docker operation failed: {arguments[0]}")
        return result.stdout

    def current():
        result = docker_run(["inspect", cid])
        if result.returncode:
            if "no such object" in result.stderr.lower() and cid in result.stderr:
                return None
            raise RuntimeError("Cannot verify owned Redis container identity")
        info = json.loads(result.stdout)[0]
        if info["Id"] != cid or info["Config"]["Labels"].get("frank.workspace") != owner:
            raise RuntimeError("Redis ownership mismatch; refusing lifecycle operation")
        return info

    def cargo_test(name, test_filter, env, expected_passed, ignored=True):
        command = ["cargo", "test", "--locked", "--manifest-path", str(manifest),
                   "-p", "cashweb-registry", "--lib", test_filter, "--", "--nocapture", "--test-threads=1", "--color", "never"]
        if ignored:
            command.append("--ignored")
        log = evidence / f"{name}.log"
        receipt["commands"].append(command)
        save()
        started = time.monotonic()
        with log.open("wb") as stream:
            child = subprocess.Popen(command, cwd=manifest.parent, env=env,
                                     stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            receipt["active_process"] = {"pid": child.pid, "pgid": child.pid, "command": command}
            save()
            try:
                while child.poll() is None:
                    if time.monotonic() - started > 600 or log.stat().st_size > 8 * 1024 * 1024:
                        raise RuntimeError("Focused Redis test deadline or log bound exceeded")
                    try:
                        child.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        pass
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
                receipt["active_process"] = None
            receipt["tests"].append({"name": name, "exit_code": child.returncode,
                                     "seconds": time.monotonic() - started, "log": log.name})
            save()
            print("\n".join(log.read_text().splitlines()[-35:]), flush=True)
            if child.returncode:
                raise RuntimeError(f"Real Redis boundary failed: {name}")
            summary=re.search(r"test result: ok\. (\d+) passed; (\d+) failed",log.read_text())
            if not summary or int(summary[1])!=expected_passed or int(summary[2])!=0:
                raise RuntimeError(f"Unexpected named test count: {name}")
            receipt["tests"][-1]["passed"]=int(summary[1]);save()

    try:
        save()
        required(["pull", IMAGE], timeout=120)
        image = json.loads(required(["image", "inspect", IMAGE]))[0]
        receipt["image_id"] = image["Id"]
        (evidence / "image.json").write_text(json.dumps({key: image.get(key) for key in
            ["Id", "RepoDigests", "Architecture", "Os"]}, indent=2) + "\n")
        # Choose an ephemeral loopback port and fix its mapping so stop/start keeps the URL.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        receipt["host_binding"] = {"ip": "127.0.0.1", "port": port}
        create = ["create", "--name", "frank-quota-ci-" + owner[:8], "--cidfile", str(evidence / "redis.cid"),
                  "--label", "frank.workspace=" + owner, "--memory", "128m", "--memory-swap", "128m",
                  "--cpus", "0.25", "--pids-limit", "64", "--user", "999:999", "--read-only",
                  "--tmpfs", "/data:rw,nosuid,noexec,size=16m,uid=999,gid=999,mode=0700",
                  "--publish", f"127.0.0.1:{port}:6379", image["Id"], "redis-server", "--save", "",
                  "--appendonly", "no", "--maxmemory", "16mb", "--maxmemory-policy", "noeviction",
                  "--protected-mode", "no", "--bind", "0.0.0.0"]
        receipt["create_command"] = docker + create
        save()
        cid = required(create).strip()
        receipt["container_id"] = cid
        save()  # Immutable ID and owner are durable BEFORE start.
        info = current()
        host = info["HostConfig"]
        assert info["Image"] == image["Id"] and info["Config"]["User"] == "999:999"
        assert host["Memory"] == host["MemorySwap"] == 128 * 1024 * 1024
        assert host["NanoCpus"] == 250000000 and host["PidsLimit"] == 64 and host["ReadonlyRootfs"]
        assert host["PortBindings"] == {"6379/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
        assert all(mount["Type"] == "tmpfs" for mount in info["Mounts"])
        assert "uid=999" in host["Tmpfs"]["/data"]
        (evidence / "created.json").write_text(json.dumps(info, indent=2) + "\n")
        required(["start", cid])
        deadline = time.monotonic() + 30
        while True:
            health = docker_run(["exec", cid, "redis-cli", "PING"], timeout=3)
            if health.returncode == 0 and health.stdout.strip() == "PONG":
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Owned Redis did not become ready")
            time.sleep(0.1)
        env = os.environ.copy()
        env.update(FRANK_QUOTA_TEST_REDIS_URL=f"redis://127.0.0.1:{port}/",
                   FRANK_QUOTA_TEST_REDIS_CONTAINER_ID=cid, FRANK_QUOTA_TEST_WORKSPACE_UUID=owner,
                   FRANK_QUOTA_TEST_DOCKER_CONTEXT=args.docker_context)
        cargo_test("cancelled-callers-driver-bound", "cancelled_callers_cannot_accumulate_unanswered_redis_commands", env, 1, ignored=False)
        cargo_test("atomic-ttl-auth-oom-stop-restart", "http::redis_quota::tests", env, 5)
        cargo_test("production-directory-and-family-quotas", "shared_quota", env, 5)
        receipt["outcome"] = "passed"
    except BaseException as error:
        receipt["outcome"] = "failed"
        receipt["failure_class"] = type(error).__name__
        raise
    finally:
        # A failed create can still have written a CID; never discover a target by name.
        if cid is None and (evidence / "redis.cid").exists():
            cid = (evidence / "redis.cid").read_text().strip()
            receipt["container_id"] = cid
        if cid:
            try:
                info = current()
                if info is not None:
                    if info["State"]["Running"]:
                        required(["stop", "--time", "3", cid])
                    info = current()
                    assert info is not None and not info["State"]["Running"] and info["State"]["Pid"] == 0
                    (evidence / "stopped.json").write_text(json.dumps(info, indent=2) + "\n")
                    logs = docker_run(["logs", "--tail", "100", cid])
                    (evidence / "redis.log").write_text(logs.stdout + logs.stderr)
                    required(["rm", cid])
                assert current() is None
                receipt["container_absent"] = True
            except BaseException as cleanup_error:
                receipt["cleanup_failure_class"] = type(cleanup_error).__name__
                receipt["resource_disposition"] = "Retain exact recorded instance; ownership could not be verified/cleaned"
                save()
                raise
        save()


if __name__ == "__main__":
    main()
