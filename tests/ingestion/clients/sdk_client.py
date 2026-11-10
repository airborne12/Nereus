"""Send traces, logs, metrics and exemplars from official OpenTelemetry SDKs."""

import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from opentelemetry.metrics import Observation
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import SimpleLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.metrics.view import View
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from common import arguments, exporter_options, exporter_types, probe_attributes, write_manifest


def main():
    parser = arguments(__doc__)
    parser.add_argument("--requests", type=int, default=20)
    args = parser.parse_args()
    if args.requests < 1:
        parser.error("--requests must be positive")
    trace_exporter, log_exporter, metric_exporter = exporter_types(args.transport)
    providers, log_providers, services = [], [], {}
    for role in ["frontend", "checkout"]:
        name = f"integration-sdk-{args.transport}-{role}"
        resource = Resource.create({
            "service.name": name, "service.version": "integration-test",
            "test.run_id": args.run_id, "test.transport": args.transport,
        })
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(SimpleSpanProcessor(trace_exporter(
            **exporter_options(args.transport, args.endpoint, "traces"))))
        log_provider = LoggerProvider(resource=resource)
        log_provider.add_log_record_processor(SimpleLogRecordProcessor(log_exporter(
            **exporter_options(args.transport, args.endpoint, "logs"))))
        logger = logging.getLogger(name)
        logger.setLevel(logging.ERROR)
        logger.propagate = False
        logger.addHandler(LoggingHandler(logger_provider=log_provider))
        providers.append(provider)
        log_providers.append(log_provider)
        services[role] = {"name": name, "resource": resource, "logger": logger,
                          "tracer": provider.get_tracer("nereus-integration", "1.0")}

    reader = PeriodicExportingMetricReader(metric_exporter(
        **exporter_options(args.transport, args.endpoint, "metrics")),
        export_interval_millis=3600_000)
    metrics = MeterProvider(resource=services["checkout"]["resource"], metric_readers=[reader], views=[
        View(instrument_name="checkout.requests", attribute_keys={"route", "outcome"}),
        View(instrument_name="checkout.duration", attribute_keys={"route"}),
    ])
    meter = metrics.get_meter("nereus-integration", "1.0")
    requests = meter.create_counter("checkout.requests", unit="1")
    duration = meter.create_histogram("checkout.duration", unit="ms")
    meter.create_observable_gauge("checkout.queue.depth", unit="1", callbacks=[
        lambda options: [Observation(7, {"queue": "checkout"})],
    ])
    propagation = TraceContextTextMapPropagator()
    server_spans = {}
    probes = probe_attributes()

    class Checkout(BaseHTTPRequestHandler):
        def do_POST(self):
            order = int(self.headers["x-order-index"])
            with services["checkout"]["tracer"].start_as_current_span(
                "POST /checkout", context=propagation.extract(self.headers), kind=SpanKind.SERVER,
            ) as span:
                span.set_attributes({"http.method": "POST", "http.route": "/checkout",
                                     "http.status_code": 503, "order.index": order, "checkout.failed": True})
                span.record_exception(ValueError("Payment processor unavailable"))
                span.set_status(Status(StatusCode.ERROR, "Payment processor unavailable"))
                services["checkout"]["logger"].error("Checkout rejected for order %s", order)
                requests.add(1, {"route": "/checkout", "outcome": "error", **probes})
                duration.record(12.5 + order, {"route": "/checkout", **probes})
                value = span.get_span_context()
                server_spans[order] = {"trace_id": format(value.trace_id, "032x"),
                                       "span_id": format(value.span_id, "016x")}
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"Payment processor unavailable")

        def log_message(self, *items):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Checkout)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    traces = []
    try:
        for order in range(args.requests):
            with services["frontend"]["tracer"].start_as_current_span("POST /checkout", kind=SpanKind.CLIENT) as span:
                span.set_attributes({"http.method": "POST", "http.status_code": 503,
                                     "order.index": order, "checkout.failed": True})
                headers = {"x-order-index": str(order)}
                propagation.inject(headers)
                try:
                    urlopen(Request(f"http://127.0.0.1:{server.server_port}/checkout",
                                    data=b"{}", headers=headers), timeout=15)
                    raise AssertionError("The simulated checkout must return HTTP 503")
                except HTTPError as error:
                    assert error.code == 503
                    error.close()
                span.set_status(Status(StatusCode.ERROR, "Checkout returned HTTP 503"))
                services["frontend"]["logger"].error("Checkout returned HTTP 503 for order %s", order)
                value = span.get_span_context()
                assert server_spans[order]["trace_id"] == format(value.trace_id, "032x")
                traces.append({"order": order, "trace_id": format(value.trace_id, "032x"),
                               "root_span_id": format(value.span_id, "016x"),
                               "server_span_id": server_spans[order]["span_id"],
                               "propagation": headers["traceparent"]})
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
        metrics.shutdown()
        for provider in log_providers + providers:
            provider.shutdown()

    write_manifest(args.out, {
        "transport": args.transport, "run_id": args.run_id,
        "frontend": services["frontend"]["name"], "backend": services["checkout"]["name"],
        "traces": traces, "exemplar_attributes": probes,
        "expected": {"spans": 2 * args.requests, "logs": 2 * args.requests,
                     "counter": args.requests, "histogram_count": args.requests,
                     "histogram_sum": sum(12.5 + n for n in range(args.requests)),
                     "histogram_min": 12.5, "histogram_max": 12.5 + args.requests - 1, "gauge": 7},
    })


if __name__ == "__main__":
    main()
