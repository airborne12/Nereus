"""Shared synthetic inputs and exporter selection for the integration clients."""

import argparse
import json
from pathlib import Path


def probe_attributes():
    return {
        "probe.multiline": "line one\nline two\tindent\rreturn",
        "probe.path": r"C:\logs\new.log",
        "probe.quote": 'say "hello" and \\ goodbye',
        "probe.unicode": "\u4e2d\u6587 \U0001f600",
        "probe.nul": "before\x00after",
    }


def arguments(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--transport", choices=["http", "grpc"], required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--out", required=True)
    return parser


def exporter_types(transport):
    if transport == "http":
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    else:
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
    return OTLPSpanExporter, OTLPLogExporter, OTLPMetricExporter


def exporter_options(transport, endpoint, signal):
    if transport == "http":
        return {"endpoint": f"{endpoint.rstrip('/')}/v1/{signal}", "timeout": 10}
    return {"endpoint": endpoint, "insecure": True, "timeout": 10}


def write_manifest(path, payload):
    Path(path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": path, "transport": payload["transport"]}))
