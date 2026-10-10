"""Fake JSON-RPC bridge for hermetic client tests. Never talks to the network.

Run as ``[sys.executable, fake_bridge.py, <mode>]``. Reads newline-delimited
JSON requests on stdin and writes replies on stdout, the same wire format as
bridge/server.mjs. Each request is answered on its own thread, so a slow call
does not hold up a fast one (replies can come back out of order).

Methods:
  health   -> {"ok": true, "libVersion": "4.0.0", "node": "fake", "hasCredentials": false}
  echo     -> the params as they came (mode "env": the sorted keys of os.environ)
  sleep    -> waits params["s"] seconds, then replies
  fail     -> error {"code": params["code"], "message": params["message"]}
  crash    -> exits with status 1 without replying
  stderr   -> writes params["text"] to stderr, then replies {}
Anything else gets an INVALID_PARAMETER error, as the real bridge does.
"""
import json
import os
import sys
import threading
import time


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "default"
    out_lock = threading.Lock()
    workers = []

    def reply(req_id, body):
        line = json.dumps({"id": req_id, **body}) + "\n"
        with out_lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    def handle(req_id, method, params):
        if method == "health":
            reply(req_id, {"result": {
                "ok": True, "libVersion": "4.0.0", "node": "fake", "hasCredentials": False,
            }})
        elif method == "echo":
            if mode == "env":
                reply(req_id, {"result": {"keys": sorted(os.environ.keys())}})
            else:
                reply(req_id, {"result": params})
        elif method == "sleep":
            seconds = float(params.get("s", 0))
            time.sleep(seconds)
            reply(req_id, {"result": {"slept": seconds}})
        elif method == "fail":
            reply(req_id, {"error": {"code": params.get("code"), "message": params.get("message")}})
        elif method == "stderr":
            sys.stderr.write(f"{params.get('text', '')}\n")
            sys.stderr.flush()
            reply(req_id, {"result": {}})
        else:
            reply(req_id, {"error": {"code": "INVALID_PARAMETER", "message": "unknown method"}})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        request = json.loads(line)
        method = request.get("method")
        if method == "crash":
            # On the main thread on purpose: sys.exit here really ends the process.
            sys.exit(1)
        params = request.get("params") or {}
        worker = threading.Thread(target=handle, args=(request.get("id"), method, params))
        worker.start()
        workers.append(worker)

    for worker in workers:
        worker.join()


if __name__ == "__main__":
    main()
