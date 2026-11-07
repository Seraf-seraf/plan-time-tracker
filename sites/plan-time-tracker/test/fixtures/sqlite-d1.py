"""Execute captured Worker reads against SQLite with D1-compatible query limits."""
import json
from pathlib import Path
import sqlite3
import sys

request = json.load(sys.stdin)
database = sqlite3.connect(Path(request["databasePath"]).resolve().as_uri() + "?mode=ro", uri=True)
database.row_factory = sqlite3.Row
database.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 5)
database.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 100)
steps = 0
budget = request.get("maxVmSteps", 50_000_000)


def progress():
    global steps
    steps += 1000
    return int(steps > budget)


try:
    query, parameters = request["sql"], request.get("parameters", [])
    plan = [row[3] for row in database.execute("EXPLAIN QUERY PLAN " + query, parameters)]
    database.set_progress_handler(progress, 1000)
    rows = [dict(row) for row in database.execute(query, parameters)]
    result = {"ok": True, "rows": rows, "plan": plan, "vmSteps": steps}
except sqlite3.Error as error:
    result = {"ok": False, "error": str(error), "vmSteps": steps}
finally:
    database.close()
print(json.dumps(result))
