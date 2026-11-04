#!/usr/bin/env python3
"""Synthetic OpenTelemetry data for DorisStack, written the way `dorisexporter` writes it.

Each record is the JSON line the exporter would send (same field names, time format
"YYYY-MM-DD HH:MM:SS.ffffff", trace duration in microseconds, is_root flag; span_kind and
status_code as the OTLP enum names SPAN_KIND_SERVER / STATUS_CODE_ERROR, checked against a
real collector run), loaded with the same Stream Load headers (format=json, read_json_by_line=true, a label unless
group commit is on). Logs carry the trace_id/span_id of the span that emitted them, so
log <-> trace correlation can be tested.

Usage:
  bench/otelgen.py --http 127.0.0.1:8030 --traces 20000 --batch-traces 2000
  bench/otelgen.py --traces 200000 --out-dir /data/gen      # files for bench/load.sh
Prints a JSON summary: rows sent per table, rows loaded per Stream Load response, seconds.
"""
import argparse
import base64
import http.client
import json
import random
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

TIME_FMT = "%Y-%m-%d %H:%M:%S.%f"

SERVICES = {
    "frontend": ["GET /", "GET /product/{id}", "POST /cart", "GET /checkout"],
    "cart": ["GetCart", "AddItem", "EmptyCart"],
    "checkout": ["PlaceOrder", "PrepareOrder"],
    "payment": ["Charge", "Refund"],
    "product-catalog": ["ListProducts", "GetProduct", "SearchProducts"],
    "shipping": ["GetQuote", "ShipOrder"],
}
CALLS = {
    "frontend": ["cart", "product-catalog", "checkout"],
    "checkout": ["cart", "payment", "shipping", "product-catalog"],
    "cart": [], "payment": [], "product-catalog": [], "shipping": [],
}
NAMESPACES = ["prod", "staging"]
LOG_TEMPLATES = [
    ("INFO", 9, "request completed in {ms} ms user_id={uid}"),
    ("INFO", 9, "cache hit for key product:{pid}"),
    ("DEBUG", 5, "loaded {n} items from catalog page {page}"),
    ("WARN", 13, "slow query on table orders took {ms} ms"),
    ("WARN", 13, "retrying call to {peer} attempt {n}"),
    ("ERROR", 17, "payment declined for order {oid}: card expired"),
    ("ERROR", 17, "upstream {peer} timeout after {ms} ms"),
    ("ERROR", 17, "connection refused to redis-{n}.cache:6379"),
]


def fmt(ts):
    return ts.strftime(TIME_FMT)


def rand_hex(rng, nbytes):
    return "%0*x" % (nbytes * 2, rng.getrandbits(nbytes * 8))


def resource(rng, svc):
    ns = rng.choice(NAMESPACES)
    pod = f"{svc}-{rng.randint(1, 4)}"
    return {
        "service.name": svc,
        "service.version": f"1.{rng.randint(0, 3)}.0",
        "deployment.environment": ns,
        "k8s.namespace.name": ns,
        "k8s.pod.name": pod,
        "k8s.node.name": f"node-{rng.randint(1, 6)}",
        "host.name": pod,
    }


class Gen:
    def __init__(self, seed, start, span_seconds):
        self.rng = random.Random(seed)
        self.start = start
        self.span_seconds = span_seconds

    def trace(self):
        """One trace: spans across services, logs per span. Returns (spans, logs)."""
        rng = self.rng
        trace_id = rand_hex(rng, 16)
        t0 = self.start + timedelta(seconds=rng.uniform(0, self.span_seconds))
        spans, logs = [], []
        error = rng.random() < 0.05

        def emit(svc, parent_id, t_start, depth):
            span_id = rand_hex(rng, 8)
            name = rng.choice(SERVICES[svc])
            children = []
            cursor = t_start + timedelta(microseconds=rng.randint(50, 500))
            if depth < 3:
                for peer in rng.sample(CALLS[svc], k=min(len(CALLS[svc]), rng.randint(0, 2))):
                    child_end = emit(peer, span_id, cursor, depth + 1)
                    children.append(child_end)
                    cursor = child_end + timedelta(microseconds=rng.randint(10, 200))
            self_us = int(rng.lognormvariate(7.5, 1.0))
            t_end = max([cursor] + children) + timedelta(microseconds=self_us)
            failed = error and depth == 0 or (error and rng.random() < 0.3)
            res = resource(rng, svc)
            kind = "SPAN_KIND_SERVER" if depth == 0 or rng.random() < 0.5 else "SPAN_KIND_INTERNAL"
            attrs = {"rpc.system": "grpc"} if svc != "frontend" else {
                "http.method": name.split(" ")[0] if " " in name else "GET",
                "http.route": name.split(" ")[-1],
                "http.status_code": 500 if failed else 200,
            }
            spans.append({
                "service_name": svc,
                "timestamp": fmt(t_start),
                "service_instance_id": res["k8s.pod.name"],
                "trace_id": trace_id,
                "span_id": span_id,
                "trace_state": "",
                "parent_span_id": parent_id,
                "span_name": name,
                "span_kind": kind,
                "end_time": fmt(t_end),
                "duration": int((t_end - t_start) / timedelta(microseconds=1)),
                "span_attributes": attrs,
                "events": [{"timestamp": fmt(t_end), "name": "exception",
                            "attributes": {"exception.type": "TimeoutError"}}] if failed else [],
                "links": [],
                "status_message": "deadline exceeded" if failed else "",
                "status_code": "STATUS_CODE_ERROR" if failed else "STATUS_CODE_UNSET",
                "resource_attributes": res,
                "scope_name": "io.opentelemetry.grpc",
                "scope_version": "1.36.0",
                "is_root": 1 if parent_id == "" else 0,
            })
            for _ in range(rng.randint(0, 3)):
                level, num, tpl = rng.choice(LOG_TEMPLATES[:5] if not failed else LOG_TEMPLATES)
                body = tpl.format(ms=rng.randint(1, 3000), uid=rng.randint(1, 50000),
                                  pid=rng.randint(1, 900), n=rng.randint(1, 9), page=rng.randint(1, 40),
                                  peer=rng.choice(list(SERVICES)), oid=uuid.UUID(int=rng.getrandbits(128)))
                logs.append({
                    "service_name": svc,
                    "timestamp": fmt(t_start + (t_end - t_start) * rng.random()),
                    "service_instance_id": res["k8s.pod.name"],
                    "trace_id": trace_id,
                    "span_id": span_id,
                    "severity_number": num,
                    "severity_text": level,
                    "body": body,
                    "resource_attributes": res,
                    "log_attributes": {"code.function": name, "thread.id": rng.randint(1, 64)},
                    "scope_name": svc,
                    "scope_version": "",
                })
            return t_end

        emit("frontend", "", t0, 0)
        return spans, logs

    def metrics(self, at):
        """Gauge, sum and histogram points for every service pod at one instant."""
        rng = self.rng
        gauge, total, hist = [], [], []
        for svc in SERVICES:
            for pod_n in range(1, 5):
                res = resource(rng, svc)
                res["k8s.pod.name"] = f"{svc}-{pod_n}"
                base = {
                    "service_name": svc, "timestamp": fmt(at), "service_instance_id": res["k8s.pod.name"],
                    "metric_description": "", "resource_attributes": res,
                    "scope_name": "otelcol/hostmetrics", "scope_version": "0.120.0",
                    "start_time": fmt(self.start), "exemplars": [],
                }
                gauge.append(dict(base, metric_name="process.cpu.utilization", metric_unit="1",
                                  attributes={"state": "user"}, value=rng.uniform(0.05, 0.9)))
                total.append(dict(base, metric_name="http.server.request.count", metric_unit="{request}",
                                  attributes={"http.route": "/"}, value=float(rng.randint(1000, 90000)),
                                  aggregation_temporality="Cumulative", is_monotonic=True))
                bounds = [5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0]
                counts = [rng.randint(0, 200) for _ in range(len(bounds) + 1)]
                hist.append(dict(base, metric_name="http.server.duration", metric_unit="ms",
                                 attributes={"http.route": "/"}, count=sum(counts),
                                 sum=float(sum(c * b for c, b in zip(counts, bounds + [2000.0]))),
                                 bucket_counts=counts, explicit_bounds=bounds,
                                 min=1.0, max=1900.0, aggregation_temporality="Cumulative"))
        return gauge, total, hist


def stream_load(host, port, auth, db, table, rows, group_commit):
    body = ("\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n").encode()
    headers = {
        "format": "json", "read_json_by_line": "true", "Expect": "100-continue",
        "Authorization": "Basic " + base64.b64encode(auth.encode()).decode(),
        "Content-Length": str(len(body)),
    }
    if group_commit:
        headers["group_commit"] = group_commit
    else:
        headers["label"] = f"dorisstack_{db}_{table}_{uuid.uuid4()}"
    conn = http.client.HTTPConnection(host, port, timeout=120)
    conn.request("PUT", f"/api/{db}/{table}/_stream_load", body=body, headers=headers)
    resp = conn.getresponse()
    if resp.status in (301, 302, 307):
        loc = resp.getheader("Location")
        conn.close()
        target = http.client.urlsplit(loc)
        conn = http.client.HTTPConnection(target.hostname, target.port, timeout=120)
        conn.request("PUT", target.path + ("?" + target.query if target.query else ""), body=body,
                     headers=headers)
        resp = conn.getresponse()
    result = json.loads(resp.read())
    conn.close()
    if result.get("Status") not in ("Success", "Publish Timeout"):
        raise RuntimeError(f"stream load to {table} failed: {result}")
    return result.get("NumberLoadedRows", 0), len(body)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--http", default="127.0.0.1:8030", help="FE or BE http address for Stream Load")
    ap.add_argument("--user", default="root")
    ap.add_argument("--password", default="")
    ap.add_argument("--db", default="otel")
    ap.add_argument("--traces", type=int, default=10000)
    ap.add_argument("--batch-traces", type=int, default=1000)
    ap.add_argument("--minutes", type=float, default=60.0, help="spread data over the last N minutes")
    ap.add_argument("--metric-interval", type=float, default=10.0, help="seconds between metric points")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--group-commit", default="", help="e.g. async_mode; empty sends a label instead")
    ap.add_argument("--out-dir", default="", help="write <table>.<n>.jsonl files instead of loading")
    args = ap.parse_args()

    host, port = args.http.rsplit(":", 1)
    auth = f"{args.user}:{args.password}"
    end = datetime.now(timezone.utc).replace(tzinfo=None)
    start = end - timedelta(minutes=args.minutes)
    gen = Gen(args.seed, start, args.minutes * 60)

    sent = {"otel_traces": 0, "otel_logs": 0, "otel_metrics_gauge": 0, "otel_metrics_sum": 0,
            "otel_metrics_histogram": 0}
    loaded = dict.fromkeys(sent, 0)
    nbytes = 0
    t_begin = time.time()

    file_no = dict.fromkeys(sent, 0)

    def push(table, rows):
        nonlocal nbytes
        if not rows:
            return
        if args.out_dir:
            body = "\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n"
            with open(f"{args.out_dir}/{table}.{file_no[table]:05d}.jsonl", "w") as f:
                f.write(body)
            file_no[table] += 1
            n, b = len(rows), len(body)
        else:
            n, b = stream_load(host, int(port), auth, args.db, table, rows, args.group_commit)
        sent[table] += len(rows)
        loaded[table] += n
        nbytes += b

    done = 0
    while done < args.traces:
        n = min(args.batch_traces, args.traces - done)
        spans, logs = [], []
        for _ in range(n):
            s, lg = gen.trace()
            spans.extend(s)
            logs.extend(lg)
        push("otel_traces", spans)
        push("otel_logs", logs)
        done += n

    at = start
    gauge, total, hist = [], [], []
    while at < end:
        g, s, h = gen.metrics(at)
        gauge += g
        total += s
        hist += h
        at += timedelta(seconds=args.metric_interval)
    for table, rows in (("otel_metrics_gauge", gauge), ("otel_metrics_sum", total),
                        ("otel_metrics_histogram", hist)):
        for i in range(0, len(rows), 20000):
            push(table, rows[i:i + 20000])

    secs = time.time() - t_begin
    print(json.dumps({"sent": sent, "loaded": loaded, "bytes": nbytes, "seconds": round(secs, 2),
                      "rows_per_second": round(sum(sent.values()) / secs)}, indent=2))
    if sent != loaded:
        print("row count mismatch between sent and loaded", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
