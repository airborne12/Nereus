"""Send native Jaeger Thrift/UDP spans from an OpenTracing client."""

import argparse
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from jaeger_client import Config
from opentracing import Format

from common import write_manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-host", required=True)
    parser.add_argument("--agent-port", required=True, type=int)
    parser.add_argument("--requests", type=int, default=20)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.requests < 1:
        parser.error("--requests must be positive")
    names = {"frontend": "integration-jaeger-frontend", "checkout": "integration-jaeger-checkout"}
    tracers = {role: Config(config={
        "sampler": {"type": "const", "param": 1},
        "local_agent": {"reporting_host": args.agent_host, "reporting_port": args.agent_port},
        "reporter_batch_size": 10, "reporter_queue_size": 1000, "reporter_flush_interval": 1,
        "generate_128bit_trace_id": True,
        "tags": {"test.run_id": args.run_id, "test.transport": "jaeger-udp"},
    }, service_name=name).new_tracer() for role, name in names.items()}
    server_spans = {}

    class Checkout(BaseHTTPRequestHandler):
        def do_POST(self):
            order = int(self.headers["x-order-index"])
            context = tracers["checkout"].extract(Format.HTTP_HEADERS, {k.lower(): v for k, v in self.headers.items()})
            with tracers["checkout"].start_active_span("POST /checkout", child_of=context) as scope:
                span = scope.span
                for key, value in {"span.kind": "server", "http.status_code": 503,
                                   "order.index": order, "checkout.failed": True, "error": True}.items():
                    span.set_tag(key, value)
                span.log_kv({"event": "error", "message": "Payment processor unavailable"})
                server_spans[order] = {"trace_id": format(span.context.trace_id, "032x"),
                                       "span_id": format(span.context.span_id, "016x")}
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
            with tracers["frontend"].start_active_span("POST /checkout") as scope:
                span = scope.span
                for key, value in {"span.kind": "client", "http.status_code": 503,
                                   "order.index": order, "checkout.failed": True, "error": True}.items():
                    span.set_tag(key, value)
                headers = {"x-order-index": str(order)}
                tracers["frontend"].inject(span.context, Format.HTTP_HEADERS, headers)
                try:
                    urlopen(Request(f"http://127.0.0.1:{server.server_port}/checkout",
                                    data=b"{}", headers=headers), timeout=15)
                    raise AssertionError("The simulated checkout must return HTTP 503")
                except HTTPError as error:
                    assert error.code == 503
                    error.close()
                trace_id = format(span.context.trace_id, "032x")
                assert server_spans[order]["trace_id"] == trace_id
                traces.append({"order": order, "trace_id": trace_id,
                               "root_span_id": format(span.context.span_id, "016x"),
                               "server_span_id": server_spans[order]["span_id"],
                               "propagation": headers["uber-trace-id"]})
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
        for tracer in tracers.values():
            flushed = tracer.close()
            deadline = time.monotonic() + 15
            while not flushed.done() and time.monotonic() < deadline:
                time.sleep(0.01)
            assert flushed.done(), "The Jaeger reporter must finish flushing"
            flushed.result()
    write_manifest(args.out, {
        "transport": "jaeger-udp", "run_id": args.run_id,
        "frontend": names["frontend"], "backend": names["checkout"], "traces": traces,
        "expected": {"spans": 2 * args.requests, "logs": 0},
    })


if __name__ == "__main__":
    main()
