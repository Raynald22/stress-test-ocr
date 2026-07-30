#!/usr/bin/env python3
"""Semi-automated chaos / resilience probe for the OCR service.

This does NOT stop your infrastructure for you — it can't know whether RabbitMQ,
Postgres, MinIO, or the workers run as docker containers, systemd units, or
something else on your environment. Instead it AUTOMATES THE OBSERVATION half:
for each scenario it tells you exactly what to stop, waits for you, then probes
the service and reports PASS/FAIL against the expected graceful behaviour.

Run one scenario or all of them:
  python chaos_probe.py rabbitmq  --base-url https://dev-backend.insw.go.id/kepabeanan-ocr --token XXX
  python chaos_probe.py database  --base-url ...  --token XXX
  python chaos_probe.py minio     --base-url ...  --token XXX
  python chaos_probe.py worker    --base-url ...  --token XXX   # needs a real key
  python chaos_probe.py ollama    --base-url ...  --token XXX   # needs a real key
  python chaos_probe.py all       --base-url ...  --token XXX

Job-based scenarios (worker, ollama) need one valid min_io_key. By default it's
read from keys.json (produced by seed_min_io_keys.py); override with --key.

Zero dependencies — standard library only.
"""
from __future__ import annotations

import argparse
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

_GROUP = {"invoice": "invoices", "packing_list": "packing_lists",
          "bill_of_lading": "bill_of_lading"}


class Ctx:
    def __init__(self, base_url: str, token: str, insecure: bool, key: dict | None):
        self.base = base_url.rstrip("/")
        self.token = token
        self.key = key
        self.ssl = ssl._create_unverified_context() if insecure else None

    def _req(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=30, context=self.ssl) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read() or b"{}")
            except Exception:
                payload = {}
            return e.code, payload
        except Exception as e:                       # connection refused, timeout, etc.
            return None, {"_error": str(e)}

    def create(self, key: dict):
        group = _GROUP.get(key.get("doc_type", "invoice"), "invoices")
        body = {"invoices": [], "packing_lists": [], "bill_of_lading": []}
        body[group].append({"filename": key["filename"], "min_io_key": key["min_io_key"]})
        return self._req("POST", "/ocr/create", body)

    def get_data(self, job_id: str):
        return self._req("GET", f"/ocr/getData/{job_id}")

    def health(self):
        return self._req("GET", "/health")


def _pause(msg: str) -> None:
    input(f"\n>>> {msg}\n    (do it now, then press Enter) ")


def _report(name: str, ok: bool, detail: str) -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    return ok


def _poll_until_terminal(ctx: Ctx, job_id: str, max_wait_s: int = 300):
    start = time.time()
    last = None
    while time.time() - start < max_wait_s:
        time.sleep(3)
        status, body = ctx.get_data(job_id)
        if status != 200:
            continue
        last = (body.get("data") or {}).get("status")
        if last in ("SUCCESS", "FAILED"):
            return last
    return last  # None or non-terminal => effectively a hang/timeout


# ---- scenarios --------------------------------------------------------------
def scen_rabbitmq(ctx: Ctx) -> bool:
    _pause("STOP RabbitMQ (the message queue).")
    status, body = ctx.create(ctx.key or {"filename": "probe.pdf",
                                          "min_io_key": "probe/none.pdf", "doc_type": "invoice"})
    ok = status == 503
    _pause("RESTART RabbitMQ.")
    return _report("rabbitmq-down", ok,
                   f"POST /ocr/create -> {status} (expected 503, not a hang). body={body}")


def scen_database(ctx: Ctx) -> bool:
    _pause("STOP Postgres (the database).")
    h_status, _ = ctx.health()
    g_status, g_body = ctx.get_data("00000000-0000-0000-0000-000000000000")
    ok = h_status == 200 and g_status == 503
    _pause("RESTART Postgres.")
    return _report("database-down", ok,
                   f"/health -> {h_status} (expected 200, service still alive); "
                   f"getData -> {g_status} (expected 503, not a crash)")


def scen_minio(ctx: Ctx) -> bool:
    _pause("STOP MinIO (the blob storage).")
    key = ctx.key or {"filename": "probe.pdf", "min_io_key": "probe/none.pdf", "doc_type": "invoice"}
    status, body = ctx.create(key)
    ok = status in (503, 404)
    _pause("RESTART MinIO.")
    return _report("minio-down", ok,
                   f"POST /ocr/create -> {status} (expected 503/404, not a hang). body={body}")


def scen_worker(ctx: Ctx) -> bool:
    if not ctx.key:
        return _report("worker-kill", False, "needs a valid --key / keys.json (skipped)")
    status, body = ctx.create(ctx.key)
    if status != 202:
        return _report("worker-kill", False, f"could not submit probe job (create -> {status})")
    job_id = (body.get("data") or {}).get("job_id")
    print(f"    submitted job {job_id}")
    _pause(f"KILL one worker process WHILE it's processing job {job_id} "
           "(e.g. `docker kill <worker>` or SIGKILL the PID).")
    final = _poll_until_terminal(ctx, job_id)
    ok = final == "SUCCESS"
    print("    NOTE: also check the DB for DUPLICATE rows for this job_id — "
          "redelivery can double-process (manual check).")
    return _report("worker-kill", ok,
                   f"job {job_id} finished as {final} after the kill "
                   "(expected SUCCESS via redelivery, not lost/stuck)")


def scen_ollama(ctx: Ctx) -> bool:
    if not ctx.key:
        return _report("ollama-down", False, "needs a valid --key / keys.json (skipped)")
    _pause("Make Ollama (the LLM) unreachable (stop it / block its port).")
    status, body = ctx.create(ctx.key)
    if status != 202:
        _pause("RESTART Ollama.")
        return _report("ollama-down", False, f"could not submit probe job (create -> {status})")
    job_id = (body.get("data") or {}).get("job_id")
    print(f"    submitted job {job_id}; waiting for it to fail...")
    final = _poll_until_terminal(ctx, job_id)
    _pause("RESTART Ollama.")
    ok = final == "FAILED"
    return _report("ollama-down", ok,
                   f"job {job_id} finished as {final} (expected FAILED with a clear "
                   "error, not a hang; other jobs should stay unaffected)")


SCENARIOS = {
    "rabbitmq": scen_rabbitmq, "database": scen_database, "minio": scen_minio,
    "worker": scen_worker, "ollama": scen_ollama,
}


def _load_key(keys_file: str, explicit: str | None) -> dict | None:
    if explicit:
        return {"filename": Path(explicit).name, "min_io_key": explicit, "doc_type": "invoice"}
    p = Path(keys_file)
    if p.exists():
        try:
            arr = json.loads(p.read_text())
            if arr:
                return arr[0]
        except Exception:
            pass
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenario", choices=list(SCENARIOS) + ["all"])
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--token", default="")
    ap.add_argument("--key", help="a valid min_io_key for job-based scenarios")
    ap.add_argument("--keys-file", default="keys.json")
    ap.add_argument("--insecure", action="store_true", help="skip TLS cert verification")
    args = ap.parse_args()

    key = _load_key(args.keys_file, args.key)
    ctx = Ctx(args.base_url, args.token, args.insecure, key)

    names = list(SCENARIOS) if args.scenario == "all" else [args.scenario]
    print(f"Target: {ctx.base}")
    print("Each scenario pauses for you to stop/restart a dependency by hand.\n")
    results = {name: SCENARIOS[name](ctx) for name in names}

    print("\n==== SUMMARY ====")
    for name, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
