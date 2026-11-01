#!/usr/bin/env python3
"""Opt-in, eight-GET regression of the local nginx/Hyper close/reuse boundary.

Requires the cached pinned nginx image and a compiled cashweb-registry test binary.
All native listeners and the published nginx port bind loopback. No cluster is started.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import time

from jsonschema import Draft202012Validator, FormatChecker

IMAGE = "sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de"
TEST = "http::server::spa_tests::nginx_connection_reuse_fixture"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


async def command(*args, timeout=5, merge_stderr=False):
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise RuntimeError(f"{args[0]} exited {process.returncode}: {err.decode().strip()}")
    return (out + (err if merge_stderr else b"")).decode().strip()


async def read_head(reader):
    head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 3)
    assert len(head) < 16384
    return head


async def read_response(reader):
    head = await read_head(reader)
    headers = {}
    for line in head.split(b"\r\n")[1:]:
        if b":" in line:
            name, value = line.split(b":", 1)
            headers[name.lower()] = value.strip()
    # /chains and nginx's fixed error page have explicit, small content lengths.
    size = int(headers[b"content-length"])
    assert 0 <= size < 65536
    body = await asyncio.wait_for(reader.readexactly(size), 3)
    return head + body, int(head.split(b" ", 2)[1]), headers


async def run(args):
    record_path = args.workspace_record.resolve()
    record = json.loads(record_path.read_text())
    workspace = record["workspace_id"]
    repo = Path(record["repository"])
    worktree = Path(record["worktree"])
    schema = json.loads((repo / ".agents/schemas/local-workspace-state.v1.schema.json").read_text())
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    validator.validate(record)
    assert args.test_binary.is_file()
    directory = args.fixture_dir.resolve()
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    (directory / "owner").write_text(workspace + "\n")
    token = directory / "owner"
    resource = {"kind": "external-output", "locator": str(directory),
                "instance_id": workspace, "ownership_token": str(token)}

    # This is a per-record writer lock, not an ownership claim. Never steal an existing lock.
    lock = record_path.with_suffix(".lock")
    descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump({"machine_id": record["machine_id"], "worker": record["worker"],
                   "harness": "codex", "pid": os.getpid(), "started_at": now()}, stream)

    def save():
        record["updated_at"] = now()
        validator.validate(record)
        temporary = record_path.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump(record, stream, indent=2)
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, record_path)

    record["resources"].append(resource)
    save()
    native = None
    native_log = None
    container = None
    container_resource = None
    shim_servers = []
    connections = []
    handlers = set()
    events = []
    cleanup = {}
    result = {"image": IMAGE, "workspace": workspace, "requests": 0, "events": events}
    started = time.monotonic()

    async def shim(peer, reader, writer):
        task = asyncio.current_task()
        handlers.add(task)
        connections.append(writer)
        upstream_writer = None
        generation = len(connections)
        try:
            upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", native_port)
            first = await read_head(reader)
            assert first.startswith(b"GET /chains HTTP/1.1\r\n")
            old = b"connection: close\r\n" in first.lower()
            events.append({"peer": peer, "generation": generation, "phase": "first_request", "requested_close": old})
            upstream_writer.write(first)
            await upstream_writer.drain()
            response, status, headers = await read_response(upstream_reader)
            assert status == 200
            assert b"close" not in headers.get(b"connection", b"").lower()
            writer.write(response)
            await writer.drain()
            if old:
                assert await asyncio.wait_for(upstream_reader.read(1), 3) == b""
                events.append({"peer": peer, "generation": generation, "phase": "actual_hyper_eof"})
                # Deliberately withhold only EOF delivery to nginx. Response bytes are unchanged.
                second = await read_head(reader)
                assert second.startswith(b"GET /chains HTTP/1.1\r\n")
                events.append({"peer": peer, "generation": generation, "phase": "nginx_reused_after_hyper_eof"})
                writer.close()
                await writer.wait_closed()
            else:
                while True:
                    try:
                        second = await read_head(reader)
                    except asyncio.IncompleteReadError as error:
                        if not error.partial:
                            break  # Normal nginx shutdown after the bounded proof.
                        raise
                    assert second.startswith(b"GET /chains HTTP/1.1\r\n")
                    upstream_writer.write(second)
                    await upstream_writer.drain()
                    response, status, _ = await read_response(upstream_reader)
                    assert status == 200
                    events.append({"peer": peer, "generation": generation,
                                   "phase": "second_actual_hyper_response", "status": status})
                    writer.write(response)
                    await writer.drain()
        except BaseException as error:
            if not isinstance(error, asyncio.CancelledError):
                events.append({"generation": generation, "phase": "fixture_error", "class": type(error).__name__})
            raise
        finally:
            if upstream_writer is not None:
                upstream_writer.close()
                await upstream_writer.wait_closed()
            writer.close()
            handlers.discard(task)

    try:
        native_log = (directory / "native.log").open("wb")
        environment = dict(os.environ, FRANK_LOCAL_HTTP_FIXTURE_DIR=str(directory),
                           FRANK_LOCAL_HTTP_FIXTURE_OWNER=workspace)
        native = subprocess.Popen([str(args.test_binary.resolve()), TEST, "--ignored", "--exact",
                                   "--nocapture", "--test-threads=1"],
                                  env=environment, stdout=native_log, stderr=subprocess.STDOUT)
        observed_start = subprocess.check_output(["ps", "-p", str(native.pid), "-o", "lstart="], text=True).strip()
        native_start = datetime.datetime.strptime(observed_start, "%a %b %d %H:%M:%S %Y").astimezone()
        process_record = {"pid": native.pid, "started_at": native_start.isoformat(),
                          "role": "Synthetic router HTTP fixture, automatic 25-second lifetime",
                          "cwd": str(Path.cwd().resolve())}
        record["processes"].append(process_record)
        save()
        for _ in range(100):
            if (directory / "address").exists():
                break
            assert native.poll() is None, "native fixture exited before listening"
            await asyncio.sleep(0.025)
        address = (directory / "address").read_text()
        host, port = address.split(":")
        assert host == "127.0.0.1"
        native_port = int(port)
        for peer in range(3):
            server = await asyncio.start_server(
                lambda reader, writer, peer=peer: shim(peer, reader, writer), "127.0.0.1", 0)
            shim_servers.append(server)
        shim_ports = [server.sockets[0].getsockname()[1] for server in shim_servers]
        result["native_port"] = native_port
        result["shim_ports"] = shim_ports
        source = (worktree / "backend/labs/cluster/nginx.conf").read_text()
        baseline = subprocess.check_output(["git", "-C", str(worktree), "show",
            record["base"] + ":backend/labs/cluster/nginx.conf"], text=True)
        baseline_hash = hashlib.sha256(baseline.encode()).hexdigest()
        assert baseline_hash == "44fb52e16c49f4986c19ff768d9d3270c3a33a07c2782e8ee3ea2ebfcaf5d024"

        def mapping(document):
            return re.search(r"map\s+\$http_upgrade\s+\$connection_upgrade\s*\{([^}]+)\}", document).group(1)

        baseline_mapping = mapping(baseline)
        candidate_mapping = mapping(source)
        assert re.search(r"default\s+upgrade\s*;", baseline_mapping)
        assert re.search(r"''\s+close\s*;", baseline_mapping)
        assert re.search(r"default\s+upgrade\s*;", candidate_mapping)
        assert re.search(r"''\s+\"\"\s*;", candidate_mapping)
        result["baseline_producer_sha256"] = baseline_hash
        result["candidate_producer_sha256"] = hashlib.sha256(source.encode()).hexdigest()
        result["baseline_mapping"] = baseline_mapping.strip()
        result["candidate_mapping"] = candidate_mapping.strip()
        result["barrier"] = "Delay only actual Hyper EOF delivery; three actual nginx peers with shared zones and default exclusion/retry policy"
        peers = "\n".join(f"        server host.docker.internal:{port};" for port in shim_ports)
        configuration = f'''pid /tmp/nginx.pid;
error_log stderr notice;
events {{}}
http {{
    access_log off;
    client_body_temp_path /tmp/client;
    proxy_temp_path /tmp/proxy;
    fastcgi_temp_path /tmp/fastcgi;
    uwsgi_temp_path /tmp/uwsgi;
    scgi_temp_path /tmp/scgi;
    map $http_upgrade $old_connection {{{baseline_mapping}}}
    map $http_upgrade $candidate_connection {{{candidate_mapping}}}
    upstream old_relay {{
        zone old_relay 64k;
{peers}
    }}
    upstream candidate_relay {{
        zone candidate_relay 64k;
{peers}
    }}
    server {{
        listen 8080;
        location /old/ {{
            proxy_pass http://old_relay/;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $old_connection;
            proxy_read_timeout 1h;
            proxy_next_upstream error timeout;
        }}
        location /candidate/ {{
            proxy_pass http://candidate_relay/;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $candidate_connection;
            proxy_read_timeout 1h;
            proxy_next_upstream error timeout;
        }}
    }}
}}
'''
        config = directory / "nginx.conf"
        config.write_text(configuration)
        config.chmod(0o644)
        create = ["docker", "create", "--pull=never", "--label", f"frank.workspace={workspace}",
                  "--name", f"frank-nginx-close-{workspace}", "--memory", "64m", "--memory-swap", "64m",
                  "--cpus", "0.25", "--pids-limit", "32", "--read-only", "--cap-drop", "ALL",
                  "--security-opt", "no-new-privileges", "--user", "101:101",
                  "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m", "--publish", "127.0.0.1::8080",
                  "--mount", f"type=bind,source={config},target=/etc/nginx/nginx.conf,readonly",
                  "--entrypoint", "/bin/busybox", IMAGE, "timeout", "25", "nginx", "-c",
                  "/etc/nginx/nginx.conf", "-g", "daemon off;"]
        (directory / "create-command.json").write_text(json.dumps(create, indent=2) + "\n")
        container = await command(*create)
        assert re.fullmatch(r"[0-9a-f]{64}", container)
        # Record the immutable ID immediately after create, before start or any other lifecycle call.
        container_resource = {"kind": "container", "locator": container,
                              "instance_id": container, "ownership_token": workspace}
        record["resources"].append(container_resource)
        save()
        identity = json.loads(await command("docker", "inspect", container))[0]
        assert identity["Id"] == container and identity["Image"] == IMAGE
        assert identity["Config"]["Labels"]["frank.workspace"] == workspace
        result["container_id"] = container
        await command("docker", "start", container)
        running = json.loads(await command("docker", "inspect", container))[0]
        result["container_started_at"] = running["State"]["StartedAt"]
        published = running["NetworkSettings"]["Ports"].get("8080/tcp")
        result["published_ports_immediately_after_start"] = published
        if published:
            assert len(published) == 1 and published[0]["HostIp"] == "127.0.0.1"
            proxy_port = int(published[0]["HostPort"])
            result["proxy_port"] = proxy_port
        assert running["State"]["Running"]
        assert published, "running owned nginx has no loopback publish mapping"
        # Docker Desktop's published TCP proxy can accept before nginx has bound its socket.
        # Wait for nginx's own worker-start observation instead of consuming a proof request.
        for _ in range(40):
            logs = await command("docker", "logs", container, merge_stderr=True)
            if "start worker process" in logs:
                result["nginx_ready"] = "observed worker-start notice before first GET"
                break
            state = json.loads(await command("docker", "inspect", container))[0]["State"]
            assert state["Running"], "owned nginx exited before readiness"
            await asyncio.sleep(0.05)
        else:
            raise AssertionError("owned nginx readiness was not observed")

        async def prove():
            for _ in range(80):
                try:
                    reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
                    break
                except OSError:
                    await asyncio.sleep(0.025)
            else:
                raise AssertionError("owned nginx did not start")
            connections_to_close = [writer]
            try:
                statuses = []
                for path in ["/old/chains"] * 4 + ["/candidate/chains"] * 4:
                    writer.write(f"GET {path} HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n".encode())
                    await writer.drain()
                    result["requests"] += 1
                    _, status, headers = await read_response(reader)
                    statuses.append(status)
                    assert headers[b"server"] == b"nginx/1.29.8"
                    if len(statuses) == 1:
                        assert status == 200, "loopback host.docker.internal reachability precondition failed"
                result["statuses"] = statuses
                assert statuses == [200, 200, 200, 502, 200, 200, 200, 200], statuses
                old = [event for event in events if event["phase"] == "first_request" and event["requested_close"]]
                live = [event for event in events if event["phase"] == "first_request" and not event["requested_close"]]
                eof = [event for event in events if event["phase"] == "actual_hyper_eof"]
                reused = [event for event in events if event["phase"] == "nginx_reused_after_hyper_eof"]
                actual = [event for event in events if event["phase"] == "second_actual_hyper_response"]
                assert len(old) == len(live) == len(eof) == len(reused) == 3, events
                assert {event["peer"] for event in old} == {0, 1, 2}
                assert {event["peer"] for event in live} == {0, 1, 2}
                assert {event["generation"] for event in old} == {event["generation"] for event in eof}
                assert {event["generation"] for event in old} == {event["generation"] for event in reused}
                assert len(actual) == 1 and actual[0]["generation"] in {event["generation"] for event in live}
                assert not [event for event in events if event["phase"] == "fixture_error"]
                assert len(connections) == 6, "three native generations per mapping, no fresh retry bypass"
                logs = await command("docker", "logs", container, merge_stderr=True)
                assert logs.count("upstream prematurely closed connection") == 3, logs
                assert logs.count("upstream server temporarily disabled") == 3, logs
                assert "no live upstreams" in logs, logs
                result["mechanism_reproduced"] = True
                result["historical_unique_cause_proved"] = False
            finally:
                for stream in connections_to_close:
                    stream.close()
                    await stream.wait_closed()

        await asyncio.wait_for(prove(), 12)
        result["nginx_logs"] = await command("docker", "logs", container, merge_stderr=True)
    finally:
        failures = []
        try:
            if container is not None:
                # Revalidate immutable identity + ownership marker before stopping/removing.
                identity = json.loads(await command("docker", "inspect", container))[0]
                assert identity["Id"] == container and identity["Config"]["Labels"]["frank.workspace"] == workspace
                result["terminal_state_before_cleanup"] = identity["State"]
                result["nginx_logs"] = await command("docker", "logs", container, merge_stderr=True)
                await command("docker", "stop", "--time", "1", container)
                stopped = json.loads(await command("docker", "inspect", container))[0]
                assert not stopped["State"]["Running"]
                cleanup["container_finished_at"] = stopped["State"]["FinishedAt"]
                await command("docker", "rm", container)
                remaining = await command("docker", "ps", "-aq", "--no-trunc", "--filter", f"id={container}")
                assert container not in remaining.splitlines()
                record["resources"].remove(container_resource)
                cleanup["container_absence_verified"] = True
        except Exception as error:
            failures.append("container cleanup: " + type(error).__name__)
        try:
            for server in shim_servers:
                server.close()
                await server.wait_closed()
            for writer in connections:
                writer.close()
            pending = list(handlers)
            for handler in pending:
                handler.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        except Exception as error:
            failures.append("shim cleanup: " + type(error).__name__)
        try:
            if native is not None:
                (directory / "stop").write_text("stop\n")
                await asyncio.to_thread(native.wait, 5)
                assert native.returncode == 0, "native fixture failed; inspect its synthetic log"
                record["processes"].remove(process_record)
                cleanup["native_exit"] = native.returncode
        except Exception as error:
            failures.append("native fixture cleanup: " + type(error).__name__)
        if native_log is not None:
            native_log.close()
        ports = [(role, result[role]) for role in ["native_port", "proxy_port"] if role in result]
        ports.extend((f"shim_{peer}_port", port) for peer, port in enumerate(result.get("shim_ports", [])))
        for role, port in ports:
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), 1)
            except OSError:
                cleanup[role + "_closed"] = True
            else:
                writer.close()
                await writer.wait_closed()
                failures.append(role + " still accepts connections")
        result["cleanup"] = cleanup
        result["cleanup_failures"] = failures
        result["host_elapsed_seconds"] = time.monotonic() - started
        (directory / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        record["resume"]["last_gate"] = "Pinned nginx connection-reuse fixture disposition in owned result.json"
        if failures:
            record["state"] = "cleanup_blocked"
            record["cleanup_owner"] = record["coordinator"]
            record["cleanup_blocker"] = "; ".join(failures)
        save()
        lock.unlink()
        if failures:
            raise RuntimeError("; ".join(failures))
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace-record", type=Path, required=True)
    parser.add_argument("--fixture-dir", type=Path, required=True)
    parser.add_argument("--test-binary", type=Path, required=True)
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
