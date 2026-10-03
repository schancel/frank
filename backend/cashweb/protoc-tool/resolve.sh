#!/usr/bin/env bash
# Temporary local-build seam: remove with the last prost build input (#130/#132).
# Print one validated absolute executable path; never run or repair npm's CLI wrapper.
set -euo pipefail

repo_root="$1"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/frank-protoc.XXXXXX")"
trap 'rm -f -- "$probe_dir/probe.proto" "$probe_dir/probe.pb"; rmdir -- "$probe_dir"' EXIT
printf 'syntax = "proto3"; message Probe { string value = 1; }\n' >"$probe_dir/probe.proto"

canonical() {
    perl -MCwd=abs_path -e 'my $p = abs_path($ARGV[0]); print $p if defined $p' "$1"
}

usable() {
    local version major
    [[ -f "$1" && -x "$1" ]] || return 1
    # Reject line breaks rather than corrupt a pathname in the stdout record.
    [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]] || return 1
    version="$("$1" --version 2>/dev/null)" || return 1
    [[ "$version" =~ ^libprotoc\ ([0-9]+)\.[0-9]+(\.[0-9]+)?$ ]] || return 1
    major="${BASH_REMATCH[1]}"
    [[ "$major" -ge 3 ]] || return 1
    rm -f -- "$probe_dir/probe.pb"
    "$1" --proto_path="$probe_dir" --descriptor_set_out="$probe_dir/probe.pb" \
        "$probe_dir/probe.proto" >/dev/null 2>&1 && [[ -s "$probe_dir/probe.pb" ]]
}

is_npm_launcher() {
    [[ "$1" == */protoc/bin/protoc && -f "${1%/bin/protoc}/protoc.js" ]]
}

if [[ "${PROTOC+x}" == x ]]; then
    candidate="$PROTOC"
    if [[ "$candidate" != */* ]]; then
        candidate="$(type -P -- "$candidate" 2>/dev/null || true)"
    fi
    candidate="$(canonical "$candidate")"
    if ! is_npm_launcher "$candidate" && usable "$candidate"; then
        printf '%s\n' "$candidate"
        exit 0
    fi
    echo 'run-local-monad: PROTOC is unusable; set it to an executable native protoc (libprotoc 3+ with proto3 support), or unset it for automatic discovery. The npm CLI wrapper is not a compiler.' >&2
    exit 69
fi

# Prefer a working compiler anywhere on PATH over the known npm package payload.
# Walk every entry: Yarn prepends .bin, whose CRLF launcher can hide a native protoc.
npm_candidates=()
remaining="${PATH:-}"
while :; do
    directory="${remaining%%:*}"
    candidate="$(canonical "${directory:-.}/protoc")"
    if is_npm_launcher "$candidate"; then
        npm_candidates+=("${candidate%/bin/protoc}/protoc/bin/protoc")
    elif usable "$candidate"; then
        printf '%s\n' "$candidate"
        exit 0
    fi
    [[ "$remaining" == *:* ]] || break
    remaining="${remaining#*:}"
done

# protoc@1.x's protoc.js exposes this installed native payload. Using the fixed
# package layout needs neither Node nor execution of JavaScript from node_modules.
npm_candidates+=("$repo_root/node_modules/protoc/protoc/bin/protoc")
for candidate in "${npm_candidates[@]}"; do
    candidate="$(canonical "$candidate")"
    if usable "$candidate"; then
        printf '%s\n' "$candidate"
        exit 0
    fi
done
echo 'run-local-monad: no usable protoc found; install a native protoc (libprotoc 3+ with proto3 support) and put it on PATH, or set PROTOC to its executable path. CASHWEBD_BIN skips the source build.' >&2
exit 69
