#!/usr/bin/env python3
"""Serve the built MkDocs site on this machine's tailnet address only."""

from __future__ import annotations

import errno
import re
import socket
import struct
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
ROBOTS = ROOT / "docs" / "robots.txt"
ROBOTS_HEADER = (
    "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai"
)
CGNAT_BASE = 0x64400000
CGNAT_MASK = 0xFFC00000


def in_tailnet(ip: str) -> bool:
    try:
        packed = socket.inet_aton(ip)
    except OSError:
        return False
    number = struct.unpack("!I", packed)[0]
    return (number & CGNAT_MASK) == CGNAT_BASE


def command_ips(argv: list[str]) -> list[str]:
    try:
        result = subprocess.run(
            argv,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    found = []
    for line in result.stdout.splitlines():
        candidate = line.strip()
        if in_tailnet(candidate):
            found.append(candidate)
    return found


def interface_ips() -> list[str]:
    found: list[str] = []
    for argv in (["ifconfig"], ["ip", "-4", "-o", "addr", "show"]):
        try:
            result = subprocess.run(
                argv,
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode != 0:
            continue
        for match in re.finditer(r"\binet\s+(\d+\.\d+\.\d+\.\d+)\b", result.stdout):
            ip = match.group(1)
            if in_tailnet(ip) and ip not in found:
                found.append(ip)
        if found:
            return found
    return found


def discover_tailnet() -> str | None:
    for argv in (
        ["tailscale", "ip", "-4"],
        ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "ip", "-4"],
    ):
        for ip in command_ips(argv):
            return ip
    for ip in interface_ips():
        return ip
    return None


def crawler_names() -> list[str]:
    names: list[str] = []
    if not ROBOTS.is_file():
        return names
    for line in ROBOTS.read_text(encoding="utf-8").splitlines():
        if not line.lower().startswith("user-agent:"):
            continue
        name = line.split(":", 1)[1].strip()
        if name and name != "*" and name not in names:
            names.append(name)
    return names


CRAWLERS = crawler_names()


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Robots-Tag", ROBOTS_HEADER)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "private, no-store")
        super().end_headers()

    def _forbidden(self) -> bool:
        agent = self.headers.get("User-Agent", "")
        folded = agent.lower()
        if any(name.lower() in folded for name in CRAWLERS):
            body = b"forbidden\n"
            self.send_response(403)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return True
        return False

    def do_GET(self) -> None:
        if self._forbidden():
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if self._forbidden():
            return
        super().do_HEAD()


def bind(ip: str) -> ThreadingHTTPServer:
    if ip in {"0.0.0.0", "::", ""} or not in_tailnet(ip):
        raise SystemExit("Refusing to bind a non-tailnet address.")
    last: OSError | None = None
    ports = [80, *range(8765, 8781)]
    for port in ports:
        try:
            return ThreadingHTTPServer((ip, port), SiteHandler)
        except OSError as exc:
            last = exc
            if exc.errno in {errno.EACCES, errno.EPERM, errno.EADDRINUSE}:
                continue
            raise
    raise SystemExit(f"Could not bind a port on the tailnet address: {last}")


def main() -> int:
    if not SITE.is_dir():
        print("site/ is missing. Run: just docs-build", file=sys.stderr)
        return 1
    ip = discover_tailnet()
    if not ip:
        print(
            "No tailnet address found. Refusing to start. "
            "Checked tailscale ip -4, the Tailscale.app binary, "
            "and interface addresses in 100.64.0.0/10.",
            file=sys.stderr,
        )
        return 1
    httpd = bind(ip)
    host, port = httpd.server_address[:2]
    if host in {"0.0.0.0", "::"}:
        httpd.server_close()
        print("Refusing to serve on a wildcard address.", file=sys.stderr)
        return 1
    url = f"http://{host}/" if port == 80 else f"http://{host}:{port}/"
    print(url, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("", file=sys.stderr)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
