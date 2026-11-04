#!/usr/bin/env python3
"""Send otelgen's synthetic data as real OTLP/HTTP JSON to a collector (default :4318).

This exercises the full path application -> OTLP -> Collector -> doris exporter -> Doris,
and prints how many spans, log records and metric points were sent so they can be compared
with the rows that land in Doris.

Usage: bench/otlp_send.py --endpoint http://127.0.0.1:4318 --traces 2000
"""
import argparse
import http.client
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from otelgen import TIME_FMT, Gen  # noqa: E402

KIND = {"SPAN_KIND_INTERNAL": 1, "SPAN_KIND_SERVER": 2, "SPAN_KIND_CLIENT": 3}


def nanos(s):
    dt = datetime.strptime(s, TIME_FMT).replace(tzinfo=timezone.utc)
    return str(int(dt.timestamp()) * 1_000_000_000 + dt.microsecond * 1000)


def any_value(v):
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    return {"stringValue": str(v)}


def attrs(d):
    return [{"key": k, "value": any_value(v)} for k, v in d.items()]


def group(records, scope_of):
    """Group records by (resource, scope) as OTLP nests them."""
    out = defaultdict(list)
    for r in records:
        out[(json.dumps(r["resource_attributes"], sort_keys=True), scope_of(r))].append(r)
    return out


def traces_payload(spans):
    resource_spans = []
    for (res, (scope, version)), rows in group(spans, lambda r: (r["scope_name"], r["scope_version"])).items():
        otlp_spans = []
        for s in rows:
            span = {
                "traceId": s["trace_id"], "spanId": s["span_id"], "name": s["span_name"],
                "kind": KIND[s["span_kind"]],
                "startTimeUnixNano": nanos(s["timestamp"]), "endTimeUnixNano": nanos(s["end_time"]),
                "attributes": attrs(s["span_attributes"]),
                "events": [{"timeUnixNano": nanos(e["timestamp"]), "name": e["name"],
                            "attributes": attrs(e["attributes"])} for e in s["events"]],
                "status": {"code": 2, "message": s["status_message"]} if s["status_code"] == "STATUS_CODE_ERROR" else {},
            }
            if s["parent_span_id"]:
                span["parentSpanId"] = s["parent_span_id"]
            otlp_spans.append(span)
        resource_spans.append({"resource": {"attributes": attrs(json.loads(res))},
                               "scopeSpans": [{"scope": {"name": scope, "version": version}, "spans": otlp_spans}]})
    return {"resourceSpans": resource_spans}


def logs_payload(logs):
    resource_logs = []
    for (res, (scope, version)), rows in group(logs, lambda r: (r["scope_name"], r["scope_version"])).items():
        records = [{
            "timeUnixNano": nanos(r["timestamp"]), "observedTimeUnixNano": nanos(r["timestamp"]),
            "severityNumber": r["severity_number"], "severityText": r["severity_text"],
            "body": {"stringValue": r["body"]}, "attributes": attrs(r["log_attributes"]),
            "traceId": r["trace_id"], "spanId": r["span_id"],
        } for r in rows]
        resource_logs.append({"resource": {"attributes": attrs(json.loads(res))},
                              "scopeLogs": [{"scope": {"name": scope, "version": version}, "logRecords": records}]})
    return {"resourceLogs": resource_logs}


def metrics_payload(gauge, total, hist):
    by_res = defaultdict(list)
    for kind, rows in (("gauge", gauge), ("sum", total), ("histogram", hist)):
        for r in rows:
            by_res[(json.dumps(r["resource_attributes"], sort_keys=True), r["scope_name"], r["scope_version"],
                    kind, r["metric_name"], r["metric_unit"])].append(r)
    resource_metrics = []
    for (res, scope, version, kind, name, unit), rows in by_res.items():
        points = []
        for r in rows:
            p = {"timeUnixNano": nanos(r["timestamp"]), "startTimeUnixNano": nanos(r["start_time"]),
                 "attributes": attrs(r["attributes"])}
            if kind == "histogram":
                p.update(count=str(r["count"]), sum=r["sum"], bucketCounts=[str(c) for c in r["bucket_counts"]],
                         explicitBounds=r["explicit_bounds"], min=r["min"], max=r["max"])
            else:
                p["asDouble"] = r["value"]
            points.append(p)
        body = {"dataPoints": points}
        if kind != "gauge":
            body["aggregationTemporality"] = 2  # cumulative
        if kind == "sum":
            body["isMonotonic"] = True
        resource_metrics.append({"resource": {"attributes": attrs(json.loads(res))},
                                 "scopeMetrics": [{"scope": {"name": scope, "version": version},
                                                   "metrics": [{"name": name, "unit": unit, kind: body}]}]})
    return {"resourceMetrics": resource_metrics}


def post(endpoint, path, payload):
    u = urlsplit(endpoint)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=60)
    conn.request("POST", path, body=json.dumps(payload), headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    text = resp.read()
    conn.close()
    if resp.status != 200:
        raise RuntimeError(f"{path}: HTTP {resp.status} {text[:300]!r}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--endpoint", default="http://127.0.0.1:4318")
    ap.add_argument("--traces", type=int, default=2000)
    ap.add_argument("--batch-traces", type=int, default=200)
    ap.add_argument("--minutes", type=float, default=30.0)
    ap.add_argument("--metric-interval", type=float, default=30.0)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    end = datetime.now(timezone.utc).replace(tzinfo=None)
    start = end - timedelta(minutes=args.minutes)
    gen = Gen(args.seed, start, args.minutes * 60)
    sent = {"spans": 0, "logs": 0, "gauge": 0, "sum": 0, "histogram": 0}
    done = 0
    while done < args.traces:
        spans, logs = [], []
        for _ in range(min(args.batch_traces, args.traces - done)):
            s, lg = gen.trace()
            spans += s
            logs += lg
        post(args.endpoint, "/v1/traces", traces_payload(spans))
        post(args.endpoint, "/v1/logs", logs_payload(logs))
        sent["spans"] += len(spans)
        sent["logs"] += len(logs)
        done += args.batch_traces
    at = start
    while at < end:
        g, s, h = gen.metrics(at)
        post(args.endpoint, "/v1/metrics", metrics_payload(g, s, h))
        sent["gauge"] += len(g)
        sent["sum"] += len(s)
        sent["histogram"] += len(h)
        at += timedelta(seconds=args.metric_interval)
    print(json.dumps(sent))


if __name__ == "__main__":
    main()
