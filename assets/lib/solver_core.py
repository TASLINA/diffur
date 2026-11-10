"""Ядро решателя дифференциальных уравнений.

Этот файл исполняется внутри Pyodide в браузере и локально при тестировании.
На вход приходит JSON, на выход — JSON (строка).

Вход:
{
  "rhsSympy": "<выражение>",   # x, y, D1 (символьный режим)
  "rhsNumeric": "<выражение>", # x, y, d1 (численный режим)
  "order": 1 | 2,
  "x0": 0, "y0": 1, "dy0": 0, "x_end": 5,
  "method": "RK45" | "Radau" | "BDF" | "LSODA" | "DOP853" | "auto",
  "rtol": 1e-6, "atol": 1e-9
}
"""

import json
import time
import warnings

import numpy as np
import sympy as sp
from scipy.integrate import solve_ivp


# --------------------------------------------------------------------------
# Символы и таблица допустимых имён
# --------------------------------------------------------------------------

X = sp.Symbol("x", real=True)
Y_FUNC = sp.Function("y")
Y = Y_FUNC(X)
D1_EXPR = sp.Derivative(Y, X)
D2_EXPR = sp.Derivative(Y, X, 2)

NUM_Y = sp.Symbol("y", real=True)
NUM_D1 = sp.Symbol("d1", real=True)
NUM_D2 = sp.Symbol("d2", real=True)

_COMMON = {
    "pi": sp.pi,
    "E": sp.E,
    "oo": sp.oo,
    "sin": sp.sin,
    "cos": sp.cos,
    "tan": sp.tan,
    "cot": sp.cot,
    "sec": sp.sec,
    "csc": sp.csc,
    "asin": sp.asin,
    "acos": sp.acos,
    "atan": sp.atan,
    "atan2": sp.atan2,
    "sinh": sp.sinh,
    "cosh": sp.cosh,
    "tanh": sp.tanh,
    "asinh": sp.asinh,
    "acosh": sp.acosh,
    "atanh": sp.atanh,
    "exp": sp.exp,
    "log": sp.log,
    "sqrt": sp.sqrt,
    "Abs": sp.Abs,
    "sign": sp.sign,
    "floor": sp.floor,
    "ceiling": sp.ceiling,
    "Min": sp.Min,
    "Max": sp.Max,
    "gamma": sp.gamma,
    "erf": sp.erf,
    "Mod": sp.Mod,
    "factorial": sp.factorial,
}

_SYM_LOCALS = dict(_COMMON, x=X, y=Y, D1=D1_EXPR, D2=D2_EXPR)
_NUM_LOCALS = dict(_COMMON, x=X, y=NUM_Y, d1=NUM_D1, d2=NUM_D2)

_METHODS = {
    "RK45": "RK45",
    "RK23": "RK23",
    "DOP853": "DOP853",
    "RADAU": "Radau",
    "BDF": "BDF",
    "LSODA": "LSODA",
}

_HINT_RU = {
    "separable": "с разделяющимися переменными",
    "1st_homogeneous_coeff_best": "однородное",
    "1st_homogeneous_coeff_subs_indep_div_dep": "однородное",
    "1st_homogeneous_coeff_subs_dep_div_indep": "однородное",
    "1st_linear": "линейное 1-го порядка",
    "1st_linear_Integral": "линейное 1-го порядка",
    "Bernoulli": "уравнение Бернулли",
    "Riccati_special_minus2": "уравнение Риккати",
    "1st_rational_riccati": "уравнение Риккати",
    "1st_exact": "в полных дифференциалах",
    "1st_exact_Integral": "в полных дифференциалах",
    "1st_power_series": "степенной ряд",
    "factorable": "допускает понижение порядка",
    "nth_order_reducible": "допускает понижение порядка",
    "nth_linear_constant_coeff_homogeneous": "линейное, постоянные коэффициенты",
    "nth_linear_constant_coeff_undetermined_coefficients": "линейное, постоянные коэффициенты",
    "nth_linear_constant_coeff_variation_of_parameters": "линейное, постоянные коэффициенты",
    "nth_linear_euler_eq_homogeneous": "уравнение Эйлера",
    "nth_linear_euler_eq_nonhomogeneous_variation_of_parameters": "уравнение Эйлера",
    "2nd_linear_airy": "линейное 2-го порядка",
    "2nd_linear_bessel": "уравнение Бесселя",
    "2nd_linear_constant_coeff": "линейное, постоянные коэффициенты",
    "default": "общий метод",
}


# --------------------------------------------------------------------------
# Вспомогательные функции
# --------------------------------------------------------------------------

def _short_error(exc):
    text = str(exc).strip() or exc.__class__.__name__
    text = " ".join(text.split())
    return text[:400]


def _fail(message, **extra):
    payload = {"ok": False, "error": message}
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False, allow_nan=False)


def _parse_expr(source, local_dict):
    return sp.parse_expr(source, local_dict=local_dict, evaluate=True)


def _to_number(value, default=0.0):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if not np.isfinite(out):
        return default
    return out


def _clean_float(value):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def _clean_list(values):
    """Список float, где нечисловые значения заменены на None (валидный JSON)."""
    out = []
    for value in values:
        out.append(_clean_float(value))
    return out


def _simplify(expr):
    for func in (sp.simplify, sp.trigsimp, sp.factor):
        try:
            candidate = func(expr)
            if candidate is not None:
                return candidate
        except Exception:
            continue
    return expr


def _latex(expr):
    try:
        return sp.latex(expr)
    except Exception:
        return sp.latex(sp.sympify(expr))


# --------------------------------------------------------------------------
# Символьное решение
# --------------------------------------------------------------------------

def _apply_ics(solution, order, x0, y0, dy0):
    constants = [
        s for s in sorted(solution.free_symbols, key=lambda v: str(v))
        if getattr(s, "name", "").startswith("C")
    ]
    if not constants:
        return solution

    if solution.lhs == Y:
        equations = [sp.Eq(solution.rhs.subs(X, x0), y0)]
        if order >= 2:
            equations.append(sp.Eq(sp.diff(solution.rhs, X).subs(X, x0), dy0))
    else:
        relation = solution.lhs - solution.rhs
        equations = [sp.Eq(relation.subs({X: x0, Y: y0}), 0)]
        if order >= 2:
            return solution

    solved = sp.solve(equations, constants, dict=True)
    if not solved:
        raise ValueError("не удалось определить постоянные интегрирования")
    return solution.subs(solved[0])


def _matches_ics(expr, x0, y0):
    try:
        value = complex(expr.subs(X, x0).evalf())
    except Exception:
        return False
    return abs(value.imag) < 1e-6 and abs(value.real - y0) <= 1e-6 * max(1.0, abs(y0))


def _try_explicitize(solution, x0, y0, order):
    """Пытается выразить y из неявного решения. Только для простых случаев."""
    if order != 1:
        return None
    # sp.solve на уравнениях с sin(y)/cos(y) может считаться десятки секунд
    # и выдавать громоздкий acos(...). Для таких задач лучше оставить
    # аккуратную неявную запись, а график взять из численного решения.
    if any(
        isinstance(term, (sp.sin, sp.cos, sp.tan, sp.cot, sp.sec, sp.csc,
                          sp.sinh, sp.cosh, sp.tanh))
        and term.has(Y)
        for term in solution.atoms(sp.Function)
    ):
        return None
    try:
        operations = sp.count_ops(solution.lhs) + sp.count_ops(solution.rhs)
    except Exception:
        return None
    if operations > 80:
        return None
    try:
        solved = sp.solve(solution, Y)
    except Exception:
        return None

    if isinstance(solved, dict):
        solved = list(solved.values())
    if not isinstance(solved, list):
        solved = [solved]
    solved = [candidate for candidate in solved if candidate is not None]
    if not solved:
        return None

    matching = [candidate for candidate in solved if _matches_ics(candidate, x0, y0)]
    if len(matching) == 1:
        return matching[0]
    if len(solved) == 1:
        return solved[0]
    return None



def _sample_curve(expr, x_start, x_end, points=600):
    try:
        func = sp.lambdify(X, expr, modules=["numpy"])
        ts = np.linspace(float(x_start), float(x_end), points)
        raw = func(ts)
        array = np.asarray(raw)
        if array.dtype == object:
            array = np.array([complex(v) for v in array])
        if np.iscomplexobj(array):
            if np.max(np.abs(array.imag)) > 1e-7:
                array = array.real
            else:
                array = array.real
        array = array.astype(float)
        array[~np.isfinite(array)] = np.nan
        array[np.abs(array) > 1e15] = np.nan
        if np.isfinite(array).sum() < 2:
            return None
        return {
            "t": [float(v) for v in ts],
            "y": _clean_list(array),
        }
    except Exception:
        return None


_HINT_PRIORITY = {
    "линейное 1-го порядка": 1,
    "линейное, постоянные коэффициенты": 1,
    "с разделяющимися переменными": 2,
    "однородное": 3,
    "уравнение Эйлера": 3,
    "в полных дифференциалах": 4,
    "допускает понижение порядка": 4,
    "уравнение Бернулли": 5,
    "уравнение Риккати": 6,
    "уравнение Бесселя": 6,
    "линейное 2-го порядка": 6,
    "степенной ряд": 9,
    "общий метод": 10,
}


def _classification(rhs_sym, order):
    ode = sp.Eq(sp.Derivative(Y, X, order), rhs_sym)
    try:
        hints = sp.classify_ode(ode, Y)
    except Exception:
        return []

    result = []
    seen = set()
    for hint in hints:
        if not isinstance(hint, str):
            continue
        label = _HINT_RU.get(hint)
        if not label or label in seen:
            continue
        seen.add(label)
        result.append({"id": hint, "label": label})

    result.sort(key=lambda item: _HINT_PRIORITY.get(item["label"], 8))
    return result[:3]


def _solve_symbolic(rhs_sym, order, params, x_end):
    x0_num = _to_number(params.get("x0", 0))
    y0_num = _to_number(params.get("y0", 0))
    dy0_num = _to_number(params.get("dy0", 0))

    x0 = sp.nsimplify(x0_num, rational=True)
    y0 = sp.nsimplify(y0_num, rational=True)
    dy0 = sp.nsimplify(dy0_num, rational=True)

    ode = sp.Eq(sp.Derivative(Y, X, order), rhs_sym)
    ics = {Y.subs(X, x0): y0}
    if order >= 2:
        ics[sp.Derivative(Y, X).subs(X, x0)] = dy0

    notes = []
    used_ics = True
    try:
        solution = sp.dsolve(ode, Y, ics=ics, simplify=False)
    except Exception as first_error:
        used_ics = False
        notes.append("Начальные условия пришлось применять отдельно.")
        try:
            solution = sp.dsolve(ode, Y, simplify=False)
            if isinstance(solution, list):
                solution = solution[0]
            if isinstance(solution, sp.Eq):
                solution = _apply_ics(solution, order, x0, y0, dy0)
        except Exception as second_error:
            return {
                "ok": False,
                "error": "SymPy не смог найти аналитическое решение.",
                "detail": _short_error(second_error),
                "notes": notes,
            }

    if isinstance(solution, list):
        solution = solution[0]
    if not isinstance(solution, sp.Eq):
        return {"ok": False, "error": "SymPy вернул неожиданный формат решения.", "notes": notes}

    explicit = solution.lhs == Y
    expr = solution.rhs if explicit else None

    if not explicit:
        candidate = _try_explicitize(solution, x0_num, y0_num, order)
        if candidate is not None:
            expr = candidate
            explicit = True
            notes.append("Неявное решение удалось выразить явно.")

    if explicit:
        latex = _latex(expr)
        text = str(expr)
        curve = _sample_curve(expr, x0_num, x_end)
    else:
        latex = f"{sp.latex(solution.lhs)} = {sp.latex(solution.rhs)}"
        text = str(solution)
        curve = None

    verified = None
    residual_latex = None
    target = sp.Eq(Y, expr) if explicit else solution
    try:
        check = sp.checkodesol(ode, target, solve_for_func=False)
        if isinstance(check, tuple) and len(check) >= 2:
            verified = bool(check[0])
            residual = _simplify(check[1])
            residual_latex = sp.latex(residual)
    except Exception:
        verified = None

    endpoint = None
    if explicit:
        try:
            value = complex(expr.subs(X, sp.nsimplify(x_end, rational=True)).evalf())
            if abs(value.imag) < 1e-7:
                endpoint = _clean_float(value.real)
        except Exception:
            endpoint = None

    return {
        "ok": True,
        "explicit": explicit,
        "latex": latex,
        "text": text,
        "verified": verified,
        "residual_latex": residual_latex,
        "ics_applied": used_ics,
        "notes": notes,
        "endpoint": endpoint,
        "curve": curve,
    }


# --------------------------------------------------------------------------
# Численное решение
# --------------------------------------------------------------------------

def _resolve_method(raw, is_auto):
    key = str(raw or "auto").strip().upper()
    if key == "AUTO":
        return "RK45", True
    return _METHODS.get(key, "RK45"), is_auto or key == "RK45"


def _run_solver(rhs_num, order, method, x0, x_end, y0, dy0, rtol, atol):
    if order == 1:
        func = sp.lambdify((X, NUM_Y), rhs_num, modules=["numpy"])

        def rhs(t, state):
            value = func(t, state[0])
            return np.atleast_1d(np.asarray(value, dtype=float)).ravel()[:1]

        initial = [y0]
    else:
        func = sp.lambdify((X, NUM_Y, NUM_D1), rhs_num, modules=["numpy"])

        def rhs(t, state):
            value = func(t, state[0], state[1])
            second = np.atleast_1d(np.asarray(value, dtype=float)).ravel()[0]
            return np.array([state[1], second], dtype=float)

        initial = [y0, dy0]

    span = (x0, x_end)
    n_out = 600
    t_eval = np.linspace(x0, x_end, n_out)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        solution = solve_ivp(
            rhs,
            span,
            initial,
            method=method,
            t_eval=t_eval,
            rtol=rtol,
            atol=atol,
        )

    messages = []
    for item in caught:
        text = " ".join(str(item.message).split())
        if text and text not in messages:
            messages.append(text)
    return solution, messages


def _solve_numeric(rhs_num, order, params):
    x0 = _to_number(params.get("x0", 0))
    x_end = _to_number(params.get("x_end", 5))
    y0 = _to_number(params.get("y0", 0))
    dy0 = _to_number(params.get("dy0", 0))
    rtol = _to_number(params.get("rtol", 1e-6), 1e-6)
    atol = _to_number(params.get("atol", 1e-9), 1e-9)

    if not np.isfinite([x0, x_end, y0, dy0]).all():
        raise ValueError("начальные значения должны быть конечными числами")
    if x_end == x0:
        raise ValueError("интервал должен иметь ненулевую длину")

    method, auto = _resolve_method(params.get("method"), bool(params.get("auto")))
    solution, messages = _run_solver(rhs_num, order, method, x0, x_end, y0, dy0, rtol, atol)

    if not solution.success and auto:
        fallback_method = "Radau"
        if method != fallback_method:
            fallback_solution, fallback_messages = _run_solver(
                rhs_num, order, fallback_method, x0, x_end, y0, dy0, rtol, atol
            )
            if fallback_solution.success or len(fallback_solution.t) > len(solution.t):
                solution = fallback_solution
                method = fallback_method
                messages = messages + [
                    f"Метод RK45 не справился, применён {fallback_method}."
                ] + fallback_messages

    t = np.asarray(solution.t, dtype=float)
    if t.size == 0:
        raise ValueError(_short_error(solution.message) or "решение не найдено")

    y = np.asarray(solution.y[0], dtype=float)
    dy = np.asarray(solution.y[1], dtype=float) if order >= 2 and solution.y.shape[0] > 1 else None

    mask = np.isfinite(t) & np.isfinite(y)
    t = t[mask]
    y = y[mask]
    if dy is not None:
        dy = dy[mask]

    if t.size < 2:
        raise ValueError(_short_error(solution.message) or "решение не найдено")

    partial = bool(not solution.success or t[-1] < x_end - 1e-9)

    stats = {
        "method": method,
        "status": int(solution.status),
        "success": bool(solution.success),
        "message": _short_error(solution.message),
        "points": int(t.size),
        "nfev": int(getattr(solution, "nfev", 0) or 0),
        "njev": int(getattr(solution, "njev", 0) or 0),
        "nlu": int(getattr(solution, "nlu", 0) or 0),
        "t_end": float(t[-1]),
        "y_end": float(y[-1]),
    }

    return {
        "ok": True,
        "t": [float(v) for v in t],
        "y": [float(v) for v in y],
        "dy": [float(v) for v in dy] if dy is not None else None,
        "stats": stats,
        "partial": partial,
        "warnings": messages,
    }


# --------------------------------------------------------------------------
# Точка входа
# --------------------------------------------------------------------------

def solve_problem(payload_json):
    started = time.perf_counter()
    try:
        params = json.loads(payload_json)
    except Exception as exc:
        return _fail(f"Некорректные входные данные: {exc}")

    order = int(params.get("order", 1))
    if order not in (1, 2):
        return _fail("Поддерживаются уравнения первого и второго порядка.")

    x_end = _to_number(params.get("x_end", 5), 5.0)

    try:
        rhs_sym = _parse_expr(params["rhsSympy"], _SYM_LOCALS)
        rhs_num = _parse_expr(params["rhsNumeric"], _NUM_LOCALS)
    except Exception as exc:
        return _fail(f"Не удалось разобрать уравнение: {_short_error(exc)}")

    result = {
        "ok": True,
        "order": order,
        "rhs_latex": _latex(rhs_sym),
        "classification": [],
        "symbolic": None,
        "symbolic_error": None,
        "symbolic_detail": None,
        "numeric": None,
        "timing": {},
        "warnings": [],
    }

    started_symbolic = time.perf_counter()
    try:
        result["symbolic"] = _solve_symbolic(rhs_sym, order, params, x_end)
        if result["symbolic"] and not result["symbolic"].get("ok"):
            result["symbolic_error"] = result["symbolic"].get("error")
            result["symbolic_detail"] = result["symbolic"].get("detail")
            result["symbolic"] = None
    except Exception as exc:
        result["symbolic"] = None
        result["symbolic_error"] = "SymPy не смог найти аналитическое решение."
        result["symbolic_detail"] = _short_error(exc)
    result["timing"]["symbolic_ms"] = round((time.perf_counter() - started_symbolic) * 1000)

    try:
        result["classification"] = _classification(rhs_sym, order)
    except Exception:
        result["classification"] = []

    started_numeric = time.perf_counter()
    try:
        result["numeric"] = _solve_numeric(rhs_num, order, params)
    except Exception as exc:
        result["numeric"] = {"ok": False, "error": _short_error(exc)}
    result["timing"]["numeric_ms"] = round((time.perf_counter() - started_numeric) * 1000)
    result["timing"]["total_ms"] = round((time.perf_counter() - started) * 1000)

    if result["numeric"] and not result["numeric"].get("ok"):
        result["warnings"].append(
            "Численное интегрирование не удалось: " + str(result["numeric"].get("error", ""))
        )

    try:
        return json.dumps(result, ensure_ascii=False, allow_nan=False)
    except Exception as exc:
        return _fail(f"Не удалось сериализовать результат: {_short_error(exc)}")
