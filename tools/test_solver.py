"""Локальная проверка solver_core.py (без браузера)."""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from assets.lib.solver_core import solve_problem

CASES = [
    {
        "name": "линейное 1-го порядка",
        "rhsSympy": "(x - y)",
        "rhsNumeric": "(x - y)",
        "order": 1,
        "x0": 0,
        "y0": 1,
        "x_end": 5,
        "method": "auto",
    },
    {
        "name": "гармонический осциллятор",
        "rhsSympy": "(-4 * y)",
        "rhsNumeric": "(-4 * y)",
        "order": 2,
        "x0": 0,
        "y0": 1,
        "dy0": 0,
        "x_end": 6.283,
        "method": "RK45",
    },
    {
        "name": "логистическое",
        "rhsSympy": "(y * (1 - y))",
        "rhsNumeric": "(y * (1 - y))",
        "order": 1,
        "x0": 0,
        "y0": 0.1,
        "x_end": 12,
        "method": "auto",
    },
    {
        "name": "без элементарного решения",
        "rhsSympy": "(x**2 + y**2)",
        "rhsNumeric": "(x**2 + y**2)",
        "order": 1,
        "x0": 0,
        "y0": 0,
        "x_end": 1,
        "method": "auto",
    },
    {
        "name": "линейное с особенностью в x=0",
        "rhsSympy": "((x**2 - y) / x)",
        "rhsNumeric": "((x**2 - y) / x)",
        "order": 1,
        "x0": 1,
        "y0": 1,
        "x_end": 4,
        "method": "auto",
    },
    {
        "name": "затухающие колебания",
        "rhsSympy": "(-y - 0.4 * D1)",
        "rhsNumeric": "(-y - 0.4 * d1)",
        "order": 2,
        "x0": 0,
        "y0": 1,
        "dy0": 0,
        "x_end": 15,
        "method": "BDF",
    },
    {
        "name": "y' = sin(y) (был баг с зависанием)",
        "rhsSympy": "sin(y)",
        "rhsNumeric": "sin(y)",
        "order": 1,
        "x0": 0,
        "y0": 0.5,
        "x_end": 3,
        "method": "auto",
    },
    {
        "name": "y' = y*cos(x) (неявное решение)",
        "rhsSympy": "(y * cos(x))",
        "rhsNumeric": "(y * cos(x))",
        "order": 1,
        "x0": 0,
        "y0": 1,
        "x_end": 4,
        "method": "auto",
    },
    {
        "name": "y' = y^2 (разрыв при x=1)",
        "rhsSympy": "(y ** 2)",
        "rhsNumeric": "(y ** 2)",
        "order": 1,
        "x0": 0,
        "y0": 1,
        "x_end": 2,
        "method": "auto",
    },
]

failures = 0
for case in CASES:
    name = case.pop("name")
    payload = json.dumps(case)
    started = time.perf_counter()
    raw = solve_problem(payload)
    elapsed = (time.perf_counter() - started) * 1000
    result = json.loads(raw)

    symbolic = result.get("symbolic")
    numeric = result.get("numeric") or {}
    print(f"\n=== {name} ({elapsed:.0f} ms) ===")
    if not result.get("ok"):
        failures += 1
        print("  FAIL:", result.get("error"))
        continue

    if symbolic:
        print("  symbolic :", symbolic.get("latex"))
        print("  explicit :", symbolic.get("explicit"), "| verified:", symbolic.get("verified"))
        print("  curve    :", len((symbolic.get("curve") or {}).get("t", [])), "точек")
        for note in symbolic.get("notes", []):
            print("  note     :", note)
    else:
        print("  symbolic : нет —", result.get("symbolic_error"), "|", result.get("symbolic_detail"))

    if numeric.get("ok"):
        stats = numeric["stats"]
        print("  numeric  :", stats["method"], "| точек:", stats["points"],
              "| nfev:", stats["nfev"], "| partial:", numeric["partial"])
        print("  y_end    :", stats["y_end"])
    else:
        print("  numeric  : FAIL —", numeric.get("error"))

    hints = ", ".join(item["label"] for item in result.get("classification", []))
    print("  class    :", hints or "—")
    for warning in result.get("warnings", []):
        print("  warning  :", warning)

print("\nГотово, ошибок:", failures)
sys.exit(1 if failures else 0)
