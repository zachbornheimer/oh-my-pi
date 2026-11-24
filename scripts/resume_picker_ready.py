#!/usr/bin/env python3
"""Observe the real installed resume picker in a login-shell PTY within 30 seconds."""
import contextlib
import fcntl
import os
import pty
import re
import select
import signal
import struct
import termios
import time


def main():
    pid, terminal = pty.fork()
    if pid == 0:
        os.execvp("zsh", ["zsh", "-lic", "omp --resume"])
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    started = time.monotonic()
    ready = False
    output = ""
    try:
        while time.monotonic() - started < 28:
            if not select.select([terminal], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(terminal, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", chunk.decode(errors="replace"))
            if "Resume Session (" in output:
                ready = True
                break
            output = output[-65536:]
    finally:
        # pty.fork creates this child's session/process group; never touch a peer session.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGKILL)
        os.close(terminal)
        os.waitpid(pid, os.WNOHANG)
    print(f"Resume picker {'ready' if ready else 'not ready'} in {time.monotonic() - started:.3f}s", flush=True)
    if not ready:
        print(output[-4000:], flush=True)
    # Bun's descendants can inherit output handles; do not wait for interpreter cleanup.
    os._exit(0 if ready else 1)


if __name__ == "__main__":
    main()
