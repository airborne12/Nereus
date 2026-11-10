"""Capture exported protobuf and send escaped strings through the real Collector."""

import logging

import requests
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import Link, SpanContext, TraceFlags

from common import arguments, exporter_options, exporter_types, probe_attributes, write_manifest


def main():
    args = arguments(__doc__).parse_args()
    trace_exporter, log_exporter, _ = exporter_types(args.transport)
    captured = []

    class CaptureHttp(requests.Session):
        def send(self, request, **kwargs):
            message = ExportTraceServiceRequest.FromString(request.body)
            captured.append(MessageToDict(message))
            return super().send(request, **kwargs)

    class CaptureGrpc(trace_exporter):
        def _translate_data(self, data):
            message = super()._translate_data(data)
            captured.append(MessageToDict(message))
            return message

    options = exporter_options(args.transport, args.endpoint, "traces")
    exporter = trace_exporter(**options, session=CaptureHttp()) if args.transport == "http" else CaptureGrpc(**options)
    service = f"integration-fidelity-{args.transport}"
    resource = Resource.create({"service.name": service, "test.run_id": args.run_id})
    traces = TracerProvider(resource=resource)
    traces.add_span_processor(SimpleSpanProcessor(exporter))
    logs = LoggerProvider(resource=resource)
    logs.add_log_record_processor(SimpleLogRecordProcessor(log_exporter(
        **exporter_options(args.transport, args.endpoint, "logs"))))
    logger = logging.getLogger(service)
    logger.setLevel(logging.ERROR)
    logger.propagate = False
    logger.addHandler(LoggingHandler(logger_provider=logs))
    probes = probe_attributes()
    link_context = SpanContext(trace_id=int("1" * 32, 16), span_id=int("2" * 16, 16),
                               is_remote=True, trace_flags=TraceFlags.SAMPLED)
    event_name = 'probe "quoted"\nnext'
    text = probes["probe.multiline"]
    body = f'{text} {probes["probe.path"]} {probes["probe.unicode"]}'
    try:
        with traces.get_tracer("nereus-fidelity").start_as_current_span(
            "string fidelity", links=[Link(link_context, attributes=probes)],
        ) as span:
            span.set_attributes({k: v for k, v in probes.items() if k != "probe.nul"})
            span.add_event(event_name, probes)
            span.record_exception(ValueError(text))
            logger.error("%s", body)
            trace_id = format(span.get_span_context().trace_id, "032x")
    finally:
        traces.shutdown()
        logs.shutdown()
    assert captured, "The official exporter must serialize a trace request"
    write_manifest(args.out, {
        "transport": args.transport, "run_id": args.run_id, "service": service,
        "trace_id": trace_id, "wire": captured[-1], "attributes": probes,
        "event_name": event_name, "log_body": body,
        "link_trace_id": format(link_context.trace_id, "032x"),
        "link_span_id": format(link_context.span_id, "016x"),
    })


if __name__ == "__main__":
    main()
