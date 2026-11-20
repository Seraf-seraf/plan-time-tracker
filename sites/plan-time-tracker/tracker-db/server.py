"""Authenticated SQLite statement transport behind the local nginx proxy."""
import hmac
import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from result_parts import CacheFull, PART_BYTES, ResultParts

PARTS = ResultParts()
TOKEN = os.environ["DB_TOKEN"]
if len(TOKEN) < 32:
    raise ValueError("DB_TOKEN is too short")
DATABASE = os.environ["DB_FILE"]
MAX_BODY_BYTES = 64 * 1024 * 1024
BUSY_TIMEOUT_SECONDS = 5
SAFE_ERRORS = ("ATLM_CLIENT_RETIRED", "ASSESSMENT_SCHEMA_RETIRED",
               "WORK_INTERVAL_OVERLAP", "CHECK constraint failed")
ALLOWED = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_INSERT,
           sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE, sqlite3.SQLITE_RECURSIVE,
           sqlite3.SQLITE_FUNCTION}


def authorize(action, table, field, database, trigger):
    if action == sqlite3.SQLITE_FUNCTION and field.lower() in ("load_extension", "readfile", "writefile"):
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK if action in ALLOWED else sqlite3.SQLITE_DENY


def encode(data):
    return json.dumps(data, separators=(",", ":"), allow_nan=False).encode()


def execute(request, allow_parts=False):
    mode, statements = request["mode"], request["statements"]
    if mode not in ("first", "all", "run", "batch") or not isinstance(statements, list):
        raise ValueError("Invalid request")
    if mode != "batch" and len(statements) != 1:
        raise ValueError("Expected one statement")
    db = sqlite3.connect(DATABASE, timeout=BUSY_TIMEOUT_SECONDS, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE" if mode in ("batch", "run") else "BEGIN")
        # Initialize JSON virtual tables before authorizing application statements.
        db.execute("SELECT value FROM json_each('[]')").fetchall()
        db.set_authorizer(authorize)
        results = []
        for statement in statements:
            before = db.total_changes
            cursor = db.execute(statement["sql"], statement["args"])
            rows = [dict(row) for row in cursor]
            changes = db.execute("SELECT changes()").fetchone()[0] if db.total_changes != before else 0
            results.append({"success": True, "results": rows[:1] if mode == "first" else rows,
                            "meta": {"changes": changes, "last_row_id": cursor.lastrowid}})
        db.set_authorizer(None)
        body = encode({"results": results})
        if allow_parts and len(body) > PART_BYTES:
            body = encode(PARTS.put(body))
        db.commit()
        return body
    finally:
        db.close()  # Closing an uncommitted transaction rolls it back.


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body=b"{}", part_index=None):
        self.send_response(status)
        if part_index is None:
            self.send_header("Content-Type", "application/json")
        else:
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("X-Part-Index", str(part_index))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        is_part = self.path == "/_tracker-db/parts"
        if not is_part and self.path != "/_tracker-db/":
            return self.respond(404)
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(),
                                   ("Bearer " + TOKEN).encode()):
            return self.respond(403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= (1024 if is_part else MAX_BODY_BYTES):
                return self.respond(413)
            request = json.loads(self.rfile.read(length))
            if is_part:
                index = request["index"]
                try:
                    body = PARTS.part(request["id"], index)
                except KeyError:
                    return self.respond(410)
                return self.respond(200, body, index)
            body = execute(request, self.headers.get("X-Result-Parts") == "1")
        except CacheFull:
            return self.respond(503)
        except (ValueError, TypeError, KeyError):
            return self.respond(400)
        except sqlite3.Error as exc:
            error = next((code for code in SAFE_ERRORS if code in str(exc)), "SQLITE_ERROR")
            print("sqlite request failed:", getattr(exc, "sqlite_errorname", "SQLITE_ERROR"), flush=True)
            body = encode({"error": error})
        self.respond(200, body)


class Server(ThreadingHTTPServer):
    def service_actions(self):
        super().service_actions()
        PARTS.expire()


if __name__ == "__main__":
    connection = sqlite3.connect(DATABASE)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.close()
    Server(("127.0.0.1", int(os.environ.get("DB_PORT", "18643"))), Handler).serve_forever()
