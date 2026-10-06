#!/usr/bin/env python3
"""
nlsql-testbed eval harness. Needs only `psql` on PATH and PyYAML.

  # 1. verify every gold / must_not query and write expected results
  python3 eval/harness.py gold  --db "postgresql://localhost/nlsql_test"

  # 2. score a composer run
  python3 eval/harness.py check --db ... results.jsonl

results.jsonl has one line per case:
  {"id": "A01", "outcome": "execute", "sql": "SELECT ..."}       # execute
  {"id": "D02", "outcome": "clarify", "about": "join_path"}       # clarify
  {"id": "I01", "outcome": "decline"}                             # decline

A case passes when the outcome is in `outcomes`, and for execute the result
matches some gold answer (per `compare`) and matches no `must_not` answer.
"""
import argparse
import csv
import io
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
PRELUDE = "SET search_path = shop; SET TIME ZONE 'UTC'; SET IntervalStyle = 'postgres';"


def run_sql(db, sql):
    p = subprocess.run(
        ["psql", db, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-c", PRELUDE, "-c", sql],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip())
    rows = list(csv.reader(io.StringIO(p.stdout)))
    return rows[0], rows[1:]


INTERVAL = re.compile(
    r"^(?:(-?\d+) years? ?)?(?:(-?\d+) mons? ?)?(?:(-?\d+) days? ?)?(?:(-?)(\d+):(\d\d):(\d\d(?:\.\d+)?))?$")
TS_MIDNIGHT = re.compile(r"^(\d{4}-\d\d-\d\d)(?: 00:00:00(?:\+00)?)?$")


def norm(v):
    if v == "":
        return None
    try:
        return round(float(v), 2)
    except ValueError:
        pass
    m = TS_MIDNIGHT.match(v)
    if m:
        return m.group(1)
    m = INTERVAL.match(v)
    if m and any(m.groups()):
        y, mo, d, neg, hh, mm, ss = m.groups()
        secs = (int(y or 0) * 365 + int(mo or 0) * 30 + int(d or 0)) * 86400
        if hh:
            t = int(hh) * 3600 + int(mm) * 60 + float(ss)
            secs += -t if neg else t
        return round(secs, 0)
    return v


def norm_rows(rows):
    return [tuple(norm(v) for v in r) for r in rows]


def match(case, gold_cols, gold_rows, cols, rows):
    mode = case.get("compare", "unordered")
    if mode == "keys":
        key = case["key"]
        want = sorted(map(str, (r[gold_cols.index(key)] for r in gold_rows)))
        for j in range(len(cols)):
            if sorted(map(str, (r[j] for r in rows))) == want:
                return True
        return False
    if mode == "ordered":
        return rows == gold_rows
    return sorted(map(repr, rows)) == sorted(map(repr, gold_rows))


def load_cases():
    return yaml.safe_load((HERE / "cases.yaml").read_text())["cases"]


def cmd_gold(a):
    cases = load_cases()
    expected, problems = {}, 0
    ids = set()
    for c in cases:
        if c["id"] in ids:
            print(f"{c['id']}: duplicate id"); problems += 1
        ids.add(c["id"])
        if "execute" in c["outcomes"] and not c.get("gold"):
            print(f"{c['id']}: execute is acceptable but no gold"); problems += 1
        golds = []
        for i, g in enumerate(c.get("gold", [])):
            try:
                cols, rows = run_sql(a.db, g)
            except RuntimeError as e:
                print(f"{c['id']} gold[{i}] ERROR: {e}"); problems += 1; continue
            rows = norm_rows(rows)
            if not rows or all(v is None for r in rows for v in r):
                print(f"{c['id']} gold[{i}] returned no data"); problems += 1
            golds.append({"columns": cols, "rows": rows})
        for i, bad in enumerate(c.get("must_not", [])):
            try:
                bcols, brows = run_sql(a.db, bad)
            except RuntimeError as e:
                print(f"{c['id']} must_not[{i}] ERROR: {e}"); problems += 1; continue
            brows = norm_rows(brows)
            for g in golds:
                if match(c, g["columns"], g["rows"], bcols, brows):
                    print(f"{c['id']} must_not[{i}] is indistinguishable from a gold answer"); problems += 1
        expected[c["id"]] = golds
        summary = "; ".join(f"{len(g['rows'])} rows" + (f" e.g. {g['rows'][0]}" if len(g['rows']) == 1 else "") for g in golds)
        print(f"{c['id']:4} {'/'.join(c['outcomes']):24} {summary}")
    (HERE / "expected.json").write_text(json.dumps(expected, indent=1, default=str))
    print(f"\n{len(cases)} cases, {problems} problems. Wrote eval/expected.json")
    return 1 if problems else 0


def cmd_check(a):
    cases = {c["id"]: c for c in load_cases()}
    expected = json.loads((HERE / "expected.json").read_text())
    results = [json.loads(l) for l in Path(a.results).read_text().splitlines() if l.strip()]
    passed, by_block = 0, {}
    for r in results:
        c = cases[r["id"]]
        ok, why = False, ""
        if r["outcome"] not in c["outcomes"]:
            why = f"outcome {r['outcome']} not in {c['outcomes']}"
        elif r["outcome"] == "clarify":
            ok = c.get("clarify_on") in (None, r.get("about")) or "execute" in c["outcomes"]
            why = "" if ok else f"clarified about {r.get('about')}, expected {c.get('clarify_on')}"
        elif r["outcome"] == "decline":
            ok = True
        else:
            try:
                cols, rows = run_sql(a.db, r["sql"])
                rows = norm_rows(rows)
                bad = any(match(c, *run_bad(a.db, b), cols, rows) for b in c.get("must_not", []))
                good = any(match(c, g["columns"], [tuple(x) for x in g["rows"]], cols, rows) for g in expected[c["id"]])
                ok = good and not bad
                why = "matches a known-wrong answer" if bad else ("" if good else "result differs from gold")
            except RuntimeError as e:
                why = f"SQL error: {e}"
        passed += ok
        for b in c["blocks"]:
            t = by_block.setdefault(b, [0, 0]); t[0] += ok; t[1] += 1
        print(f"{'PASS' if ok else 'FAIL'} {r['id']:4} {why}")
    print(f"\n{passed}/{len(results)} passed")
    weak = sorted((v[0] / v[1], k, v) for k, v in by_block.items() if v[0] < v[1])
    if weak:
        print("blocks with failures:", ", ".join(f"{k} {v[0]}/{v[1]}" for _, k, v in weak))
    return 0 if passed == len(results) else 1


def run_bad(db, sql):
    cols, rows = run_sql(db, sql)
    return cols, norm_rows(rows)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["gold", "check"])
    ap.add_argument("results", nargs="?")
    ap.add_argument("--db", required=True)
    a = ap.parse_args()
    sys.exit(cmd_gold(a) if a.cmd == "gold" else cmd_check(a))
