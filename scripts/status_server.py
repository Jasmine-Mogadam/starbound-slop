#!/usr/bin/env python3
import http.server
import subprocess
import time
import os

PORT = int(os.environ.get("STATUS_PORT", "8080"))
GAME_PORT = int(os.environ.get("STARBOUND_PORT", "21025"))
FLY_APP = os.environ.get("FLY_APP_NAME", "starbound-server")
SERVER_HOST = os.environ.get("SERVER_HOST", f"{FLY_APP}.fly.dev")
START_TIME = time.time()

MARKER = "/tmp/starbound_started"
LOG_FILE = "/tmp/starbound_log"


def server_status():
    """Returns 'live', 'starting', or 'down'."""
    try:
        running = subprocess.run(
            ["pgrep", "-f", "starbound_server"], capture_output=True
        ).returncode == 0
    except Exception:
        running = False

    if running:
        return "live"
    if os.path.exists(MARKER):
        return "down"
    return "starting"


def format_uptime(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}h {m}m {s}s"


def recent_logs(n=6):
    try:
        with open(LOG_FILE) as f:
            lines = f.readlines()
        return [l.rstrip() for l in lines[-n:]]
    except OSError:
        return []


class StatusHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return

        status = server_status()
        uptime = format_uptime(time.time() - START_TIME)

        if status == "live":
            status_code, status_text, status_color = 200, "LIVE", "#22c55e"
            detail = f"Connect in-game to:"
            extra = f"""
    <div class="connect">
      <span class="addr">{SERVER_HOST}</span>
      <span class="port">port {GAME_PORT}</span>
    </div>"""
        elif status == "starting":
            status_code, status_text, status_color = 503, "STARTING", "#f59e0b"
            detail = "Server is installing or warming up — check back in a few minutes."
            logs = recent_logs()
            if logs:
                log_lines = "\n".join(logs)
                extra = f"""
    <div class="logs"><pre>{log_lines}</pre></div>"""
            else:
                extra = ""
        else:
            status_code, status_text, status_color = 503, "DOWN", "#ef4444"
            detail = "starbound_server process stopped or crashed."
            extra = ""

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="15">
  <title>Starbound Server Status</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }}
    .card {{ background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 2.5rem 3rem; text-align: center; max-width: 480px; width: 90%; }}
    h1 {{ font-size: 1.25rem; font-weight: 600; color: #94a3b8; margin-bottom: 1.5rem; letter-spacing: 0.05em; text-transform: uppercase; }}
    .badge {{ display: inline-block; padding: 0.5rem 1.5rem; border-radius: 999px; font-size: 1.75rem; font-weight: 700; letter-spacing: 0.1em; color: {status_color}; border: 2px solid {status_color}; margin-bottom: 1.25rem; }}
    .detail {{ color: #94a3b8; font-size: 0.9rem; margin-bottom: 0.75rem; }}
    .connect {{ background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 0.75rem 1.25rem; margin-bottom: 1.5rem; }}
    .connect .addr {{ display: block; font-family: monospace; font-size: 1.05rem; color: #e2e8f0; font-weight: 600; }}
    .connect .port {{ display: block; font-size: 0.8rem; color: #64748b; margin-top: 0.2rem; }}
    .logs {{ background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; text-align: left; }}
    .logs pre {{ font-family: monospace; font-size: 0.75rem; color: #94a3b8; white-space: pre-wrap; word-break: break-all; }}
    .meta {{ font-size: 0.8rem; color: #475569; border-top: 1px solid #334155; padding-top: 1rem; }}
    .meta span {{ display: block; margin-top: 0.25rem; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Starbound Server</h1>
    <div class="badge">{status_text}</div>
    <p class="detail">{detail}</p>{extra}
    <div class="meta">
      <span>Status container uptime: {uptime}</span>
      <span>Refreshes every 15s</span>
    </div>
  </div>
</body>
</html>"""

        body = html.encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # silence access logs


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), StatusHandler)
    print(f"Status server listening on port {PORT}", flush=True)
    server.serve_forever()
