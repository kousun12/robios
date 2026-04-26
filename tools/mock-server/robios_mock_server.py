#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RobiosHandler(BaseHTTPRequestHandler):
    server_version = "robios-mock/0.1"

    @property
    def data_root(self) -> Path:
        return self.server.data_root  # type: ignore[attr-defined]

    @property
    def token(self) -> str:
        return self.server.token  # type: ignore[attr-defined]

    def _auth_ok(self) -> bool:
        auth = self.headers.get("Authorization", "")
        expected = f"Bearer {self.token}"
        return auth == expected

    def _json_response(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length)

    def do_GET(self) -> None:  # noqa: N802
        if not self._auth_ok():
            self._json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        if self.path == "/v1/status":
            self._json_response(
                HTTPStatus.OK,
                {"status": "ok", "serverTime": now_iso(), "version": "mock-1"},
            )
            return

        self._json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._auth_ok():
            self._json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        if self.path == "/v1/devices/register":
            payload = json.loads(self._read_body() or b"{}")
            if not payload.get("deviceId") or not payload.get("installationId"):
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "invalid_registration"})
                return

            out = self.data_root / "devices" / f"{payload['deviceId']}.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            self._json_response(HTTPStatus.OK, {"accepted": True, "deviceToken": payload["deviceId"]})
            return

        if self.path == "/v1/ingest":
            payload = json.loads(self._read_body() or b"{}")
            points = payload.get("points", [])
            if not isinstance(points, list):
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "invalid_points"})
                return

            results = []
            accepted = duplicates = rejected = 0
            ingested_dir = self.data_root / "ingested"
            ingested_dir.mkdir(parents=True, exist_ok=True)

            for point in points:
                point_id = point.get("pointId")
                point_payload = point.get("payload", "")
                point_hash = point.get("payloadHashSHA256", "")
                expected_hash = hashlib.sha256(point_payload.encode("utf-8")).hexdigest()
                if point_hash != expected_hash:
                    rejected += 1
                    results.append({"pointId": point_id, "status": "rejected", "message": "payload hash mismatch"})
                    continue

                path = ingested_dir / f"{point_id}.json"
                if path.exists():
                    duplicates += 1
                    results.append({"pointId": point_id, "status": "duplicate", "message": None})
                    continue

                accepted += 1
                path.write_text(json.dumps(point, indent=2), encoding="utf-8")
                results.append({"pointId": point_id, "status": "accepted", "message": None})

            batch_file = self.data_root / "batches" / f"batch-{datetime.now().timestamp()}.json"
            batch_file.parent.mkdir(parents=True, exist_ok=True)
            batch_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")

            self._json_response(
                HTTPStatus.OK,
                {
                    "acceptedCount": accepted,
                    "duplicateCount": duplicates,
                    "rejectedCount": rejected,
                    "results": results,
                },
            )
            return

        self._json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_HEAD(self) -> None:  # noqa: N802
        if not self._auth_ok():
            self.send_response(HTTPStatus.UNAUTHORIZED)
            self.end_headers()
            return

        if self.path.startswith("/v1/files/blobs/"):
            sha256 = self.path.split("/")[-1]
            path = self.data_root / "blobs" / sha256
            self.send_response(HTTPStatus.OK if path.exists() else HTTPStatus.NOT_FOUND)
            self.end_headers()
            return

        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    def do_PUT(self) -> None:  # noqa: N802
        if not self._auth_ok():
            self._json_response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        if self.path.startswith("/v1/files/blobs/"):
            sha256 = self.path.split("/")[-1]
            if len(sha256) != 64:
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "invalid_hash"})
                return
            body = self._read_body()
            digest = hashlib.sha256(body).hexdigest()
            if digest != sha256:
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "blob hash mismatch"})
                return

            blob_path = self.data_root / "blobs" / sha256
            blob_path.parent.mkdir(parents=True, exist_ok=True)
            blob_path.write_bytes(body)
            self._json_response(HTTPStatus.OK, {"stored": True, "size": len(body)})
            return

        self._json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})


def main() -> None:
    parser = argparse.ArgumentParser(description="robios mock sync server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--token", default=os.environ.get("ROBIOS_TOKEN", "dev-secret"))
    parser.add_argument("--data-dir", default="./tools/mock-server/.data")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), RobiosHandler)
    server.token = args.token  # type: ignore[attr-defined]
    server.data_root = Path(args.data_dir)  # type: ignore[attr-defined]
    server.data_root.mkdir(parents=True, exist_ok=True)

    print(f"robios mock server listening on http://{args.host}:{args.port}")
    print(f"data dir: {server.data_root}")
    server.serve_forever()


if __name__ == "__main__":
    main()
