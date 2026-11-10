/*
 * numeric.js — резервный численный решатель на чистом JS (метод Рунге–Кутты 4-го
 * порядка). Используется, если Pyodide/SciPy недоступны (нет сети, CDN заблокирован).
 */

function safeEval(rhs, x, y, dy) {
  try {
    const value = rhs(x, y, dy, 0);
    return Number.isFinite(value) ? value : NaN;
  } catch {
    return NaN;
  }
}

export function rk4({ rhs, x0, y0, dy0 = 0, xEnd, order, steps }) {
  const span = xEnd - x0;
  if (!Number.isFinite(span) || span === 0) {
    return { ok: false, error: 'Интервал должен иметь ненулевую длину.' };
  }

  const count = Math.min(
    8000,
    Math.max(400, Number.isFinite(steps) ? steps : Math.round(Math.abs(span) * 220)),
  );
  const h = span / count;

  const t = [];
  const y = [];
  const dy = order >= 2 ? [] : null;

  let x = x0;
  let u = y0;
  let v = order >= 2 ? dy0 : 0;
  let partial = false;
  let message = '';

  const push = () => {
    t.push(x);
    y.push(u);
    if (dy) dy.push(v);
  };

  push();

  for (let i = 0; i < count; i += 1) {
    if (order === 1) {
      const k1 = safeEval(rhs, x, u, 0);
      const k2 = safeEval(rhs, x + h / 2, u + (h * k1) / 2, 0);
      const k3 = safeEval(rhs, x + h / 2, u + (h * k2) / 2, 0);
      const k4 = safeEval(rhs, x + h, u + h * k3, 0);

      if (![k1, k2, k3, k4].every(Number.isFinite)) {
        partial = true;
        message = 'Обнаружена особенность: решение не удалось продолжить.';
        break;
      }
      u += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    } else {
      const k1u = v;
      const k1v = safeEval(rhs, x, u, v);
      const k2u = v + (h * k1v) / 2;
      const k2v = safeEval(rhs, x + h / 2, u + (h * k1u) / 2, v + (h * k1v) / 2);
      const k3u = v + (h * k2v) / 2;
      const k3v = safeEval(rhs, x + h / 2, u + (h * k2u) / 2, v + (h * k2v) / 2);
      const k4u = v + h * k3v;
      const k4v = safeEval(rhs, x + h, u + h * k3u, v + h * k3v);

      if (![k1u, k1v, k2u, k2v, k3u, k3v, k4u, k4v].every(Number.isFinite)) {
        partial = true;
        message = 'Обнаружена особенность: решение не удалось продолжить.';
        break;
      }
      u += (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
      v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    }

    x += h;

    if (!Number.isFinite(u) || Math.abs(u) > 1e12) {
      partial = true;
      message = 'Решение уходит в бесконечность — интегрирование остановлено.';
      break;
    }
    push();
  }

  if (t.length < 2) {
    return { ok: false, error: message || 'Не удалось построить численное решение.' };
  }

  return { ok: true, t, y, dy, partial, message, steps: t.length };
}

/** Небольшие отрезки, показывающие наклон поля направлений. */
export function directionField(rhs, bounds, cols = 26, rows = 18) {
  const { x0, x1, y0, y1 } = bounds;
  const segments = [];
  if (![x0, x1, y0, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return segments;

  const cellX = (x1 - x0) / cols;
  const cellY = (y1 - y0) / rows;

  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      const x = x0 + (i + 0.5) * cellX;
      const y = y0 + (j + 0.5) * cellY;
      const slope = safeEval(rhs, x, y, 0);
      if (!Number.isFinite(slope)) continue;

      const length = 0.42;
      const norm = Math.hypot(1, slope);
      if (!Number.isFinite(norm) || norm === 0) continue;

      const ux = (cellX * length) / norm;
      const uy = (cellY * length * slope) / norm;
      if (!Number.isFinite(ux) || !Number.isFinite(uy)) continue;

      segments.push([x - ux, y - uy, x + ux, y + uy]);
    }
  }
  return segments;
}

/** Процентиль по уже отсортированному массиву. */
export function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
