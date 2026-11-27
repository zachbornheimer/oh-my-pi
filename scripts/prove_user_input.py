#!/usr/bin/env python3
"""Prove actual CLI-initial, print and composer submissions without a provider call."""
import argparse
import json
import os
import pty
import select
import shlex
import signal
import subprocess
import tempfile
import time
import uuid
from pathlib import Path


def exercise(command, kind, fixture, directory):
    marker = f"submission-proof-{kind}-{uuid.uuid4().hex}"
    receipt = directory / f"{kind}.jsonl"
    env = dict(os.environ)
    env.pop("SESSIONS_DB_URL", None)
    env["OMP_SUBMISSION_RECEIPT"] = str(receipt)
    env["OMP_SUBMISSION_MARKER"] = marker
    env["OMP_NO_SPLASH"] = "1"
    flags = ["--no-extensions", "--extension", str(fixture), "--no-skills", "--no-rules", "--no-context-files", "--no-tools", "--no-lsp", "--no-session", "--no-title", "--cwd", str(directory)]
    args = command + flags + (["-p", marker] if kind == "print" else [marker] if kind == "cli" else [])
    master, slave = pty.openpty()
    proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    output = bytearray()
    sent = False
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if kind == "composer" and not sent and (b"Type" in output or b"help" in output.lower() or time.monotonic() > deadline - 55):
                os.write(master, marker.encode() + b"\r")
                sent = True
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                output.extend(chunk)
            if receipt.exists() and receipt.stat().st_size:
                rows = [json.loads(line) for line in receipt.read_text().splitlines()]
                if len(rows) != 1 or rows[0]["text"] != marker or not rows[0]["requestId"] or not rows[0]["sessionId"]:
                    raise RuntimeError(f"{kind}: invalid capture {rows!r}")
                expected = {"cli": "cli", "print": "print", "composer": "interactive"}[kind]
                if rows[0]["source"] != expected:
                    raise RuntimeError(f"{kind}: wrong source {rows[0]!r}")
                if kind == "print":
                    proc.wait(timeout=10)
                    if proc.returncode != 0:
                        raise RuntimeError(f"print exited {proc.returncode}: {output.decode(errors='replace')[-4000:]}")
                print(json.dumps({"path": kind, "captured": True, **rows[0]}), flush=True)
                return
            if proc.poll() is not None:
                break
        raise RuntimeError(f"{kind}: no submission receipt; exit={proc.poll()}\n{output.decode(errors='replace')[-6000:]}")
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        os.close(master)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", default=os.environ.get("OMP_PROOF_COMMAND", "omp"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    fixture = root / "packages/coding-agent/test/fixtures/user-submission-capture.ts"
    command = shlex.split(args.command)
    with tempfile.TemporaryDirectory(prefix="omp-user-input-proof-") as name:
        directory = Path(name)
        for kind in ["cli", "print", "composer"]:
            exercise(command, kind, fixture, directory)
    print("PASS: one shared hook capture for CLI initial prompt, -p, and composer")


if __name__ == "__main__":
    main()
