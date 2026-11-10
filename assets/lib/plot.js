/*
 * plot.js — лёгкий интерактивный график на SVG без внешних библиотек.
 * Умеет: несколько серий, поле направлений, наведение, зум колесом,
 * панорамирование мышью, сброс вида и экспорт в SVG.
 */

const NS = 'http://www.w3.org/2000/svg';
const MARGIN = { l: 62, r: 22, t: 26, b: 46 };

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  return node;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-3) {
    return value.toExponential(1).replace('e+', 'e').replace('.', ',');
  }
  const fixed = abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

function niceTicks(min, max, count) {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [min];
  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  let step;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 2.5) step = 2.5;
  else if (normalized <= 5) step = 5;
  else step = 10;
  step *= magnitude;

  const ticks = [];
  const start = Math.ceil(min / step) * step;
  for (let value = start; value <= max + step * 1e-9; value += step) {
    const rounded = Number(value.toFixed(12));
    ticks.push(rounded === 0 ? 0 : rounded);
  }
  return ticks;
}

function pathFromPoints(points, sx, sy) {
  let d = '';
  let open = false;
  for (const point of points) {
    const x = point[0];
    const y = point[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      open = false;
      continue;
    }
    const px = clamp(sx(x), -1e5, 1e5);
    const py = clamp(sy(y), -1e5, 1e5);
    d += `${open ? 'L' : 'M'}${px.toFixed(2)} ${py.toFixed(2)} `;
    open = true;
  }
  return d;
}

export function computeViewFromSeries(seriesList) {
  const xs = [];
  const ys = [];
  for (const series of seriesList || []) {
    for (const point of series.points || []) {
      if (Number.isFinite(point[0]) && Number.isFinite(point[1])) {
        xs.push(point[0]);
        ys.push(point[1]);
      }
    }
  }
  if (!xs.length) {
    return { x0: 0, x1: 1, y0: -1, y1: 1 };
  }

  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);

  const pick = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)];
  const rawX0 = xs[0];
  const rawX1 = xs[xs.length - 1];
  let rawY0 = ys[0];
  let rawY1 = ys[ys.length - 1];

  // Отсекаем редкие выбросы (сингулярности), иначе график «схлопывается».
  const qy0 = pick(ys, 0.01);
  const qy1 = pick(ys, 0.99);
  if (Number.isFinite(qy0) && Number.isFinite(qy1) && qy1 > qy0) {
    const fullSpan = rawY1 - rawY0;
    const coreSpan = qy1 - qy0;
    if (fullSpan > coreSpan * 6) {
      rawY0 = qy0;
      rawY1 = qy1;
    }
  }

  let x0 = rawX0;
  let x1 = rawX1;
  let y0 = rawY0;
  let y1 = rawY1;

  if (!(x1 > x0)) {
    const pad = Math.max(1, Math.abs(x0) * 0.1);
    x0 -= pad;
    x1 += pad;
  }
  if (!(y1 > y0)) {
    const pad = Math.max(1, Math.abs(y0) * 0.1);
    y0 -= pad;
    y1 += pad;
  }

  const padX = (x1 - x0) * 0.04;
  const padY = (y1 - y0) * 0.1;
  return {
    x0: x0 - padX,
    x1: x1 + padX,
    y0: y0 - padY,
    y1: y1 + padY,
  };
}

export class Plot {
  constructor(container) {
    this.container = container;
    this.container.classList.add('plot-host');
    this.svg = svgEl('svg', { role: 'img', 'aria-label': 'График решения' });
    this.svg.style.display = 'block';
    this.svg.style.width = '100%';
    this.svg.style.touchAction = 'none';
    this.container.appendChild(this.svg);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'plot-tooltip';
    this.tooltip.hidden = true;
    this.container.appendChild(this.tooltip);

    this.data = null;
    this.view = null;
    this.autoView = null;
    this.colors = this.readColors();
    this.lastRender = null;
    this.drag = null;
    this.frame = null;
    this.clipId = `plot-clip-${Math.random().toString(36).slice(2, 8)}`;

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(this.container);
  }

  readColors() {
    const styles = getComputedStyle(this.container);
    const get = (name, fallback) => (styles.getPropertyValue(name) || '').trim() || fallback;
    return {
      bg: get('--plot-bg', '#0e1422'),
      grid: get('--plot-grid', '#1c2942'),
      axis: get('--plot-axis', '#4d5f85'),
      text: get('--plot-text', '#8b9ab9'),
      strong: get('--plot-strong', '#e8ecf6'),
      field: get('--plot-field', '#3a4f78'),
      accent: get('--accent', '#7c9cff'),
      accent2: get('--accent-2', '#a78bfa'),
      success: get('--success', '#4ade80'),
    };
  }

  bindEvents() {
    this.svg.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.svg.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.svg.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.svg.addEventListener('pointercancel', () => { this.drag = null; });
    this.svg.addEventListener('pointerleave', () => {
      this.tooltip.hidden = true;
      this.clearOverlay();
    });
    this.svg.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.svg.addEventListener('dblclick', () => this.resetView());
  }

  setData(data) {
    this.data = data;
    this.colors = this.readColors();
    this.autoView = this.computeView(data);
    this.view = { ...this.autoView };
    this.render();
  }

  computeView(data) {
    return computeViewFromSeries(data.series || []);
  }

  resetView() {
    if (!this.autoView) return;
    this.view = { ...this.autoView };
    this.render();
  }

  scheduleRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  render() {
    const colors = this.colors;
    const accessibleLabel = this.data?.phase
      ? 'Фазовый портрет: y по горизонтали, y′ по вертикали'
      : this.data?.field?.length
        ? 'График решения и поле направлений'
        : 'График решения';
    this.svg.setAttribute('aria-label', accessibleLabel);
    const width = Math.max(320, this.container.clientWidth || 640);
    const height = Math.max(300, Math.min(520, Math.round(width * 0.52)));
    const innerWidth = Math.max(40, width - MARGIN.l - MARGIN.r);
    const innerHeight = Math.max(40, height - MARGIN.t - MARGIN.b);

    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.setAttribute('height', height);
    this.svg.setAttribute('width', width);
    this.svg.setAttribute('font-family', 'Inter, "Segoe UI", system-ui, sans-serif');
    this.svg.replaceChildren();

    const view = this.view || this.computeView(this.data || { series: [] });
    const sx = (x) => MARGIN.l + ((x - view.x0) / (view.x1 - view.x0)) * innerWidth;
    const sy = (y) => MARGIN.t + ((view.y1 - y) / (view.y1 - view.y0)) * innerHeight;

    this.lastRender = { width, height, innerWidth, innerHeight, sx, sy, view };

    const defs = svgEl('defs');
    const clip = svgEl('clipPath', { id: this.clipId });
    clip.appendChild(svgEl('rect', {
      x: MARGIN.l,
      y: MARGIN.t,
      width: innerWidth,
      height: innerHeight,
    }));
    defs.appendChild(clip);
    this.svg.appendChild(defs);

    this.svg.appendChild(svgEl('rect', {
      x: 0,
      y: 0,
      width,
      height,
      fill: colors.bg,
      rx: 0,
      'pointer-events': 'all',
    }));

    const plot = svgEl('g', { 'clip-path': `url(#${this.clipId})` });
    this.svg.appendChild(plot);

    // Сетка
    const xTicks = niceTicks(view.x0, view.x1, Math.max(4, Math.round(innerWidth / 90)));
    const yTicks = niceTicks(view.y0, view.y1, Math.max(4, Math.round(innerHeight / 64)));

    for (const tick of xTicks) {
      const x = sx(tick);
      plot.appendChild(svgEl('line', {
        x1: x, y1: MARGIN.t, x2: x, y2: MARGIN.t + innerHeight,
        stroke: colors.grid, 'stroke-width': 1,
      }));
    }
    for (const tick of yTicks) {
      const y = sy(tick);
      plot.appendChild(svgEl('line', {
        x1: MARGIN.l, y1: y, x2: MARGIN.l + innerWidth, y2: y,
        stroke: colors.grid, 'stroke-width': 1,
      }));
    }

    // Оси координат
    if (view.y0 < 0 && view.y1 > 0) {
      plot.appendChild(svgEl('line', {
        x1: MARGIN.l, y1: sy(0), x2: MARGIN.l + innerWidth, y2: sy(0),
        stroke: colors.axis, 'stroke-width': 1.4,
      }));
    }
    if (view.x0 < 0 && view.x1 > 0) {
      plot.appendChild(svgEl('line', {
        x1: sx(0), y1: MARGIN.t, x2: sx(0), y2: MARGIN.t + innerHeight,
        stroke: colors.axis, 'stroke-width': 1.4,
      }));
    }

    // Подписи делений
    for (const tick of xTicks) {
      const x = sx(tick);
      if (x < MARGIN.l - 1 || x > MARGIN.l + innerWidth + 1) continue;
      this.svg.appendChild(svgEl('text', {
        x, y: MARGIN.t + innerHeight + 22,
        fill: colors.text, 'font-size': 11, 'text-anchor': 'middle',
      })).textContent = formatNumber(tick);
    }
    for (const tick of yTicks) {
      const y = sy(tick);
      if (y < MARGIN.t - 1 || y > MARGIN.t + innerHeight + 1) continue;
      this.svg.appendChild(svgEl('text', {
        x: MARGIN.l - 12, y: y + 3.5,
        fill: colors.text, 'font-size': 11, 'text-anchor': 'end',
      })).textContent = formatNumber(tick);
    }

    // Подписи осей
    this.svg.appendChild(svgEl('text', {
      x: MARGIN.l + innerWidth, y: height - 10,
      fill: colors.text, 'font-size': 12, 'text-anchor': 'end',
    })).textContent = this.data?.xLabel || 'x';

    this.svg.appendChild(svgEl('text', {
      x: 14, y: MARGIN.t + 12,
      fill: colors.text, 'font-size': 12, 'text-anchor': 'start',
    })).textContent = this.data?.yLabel || 'y';

    // Поле направлений
    if (this.data?.field?.length) {
      let d = '';
      for (const [x1, y1, x2, y2] of this.data.field) {
        d += `M${clamp(sx(x1), -1e5, 1e5).toFixed(1)} ${clamp(sy(y1), -1e5, 1e5).toFixed(1)}`;
        d += `L${clamp(sx(x2), -1e5, 1e5).toFixed(1)} ${clamp(sy(y2), -1e5, 1e5).toFixed(1)}`;
      }
      plot.appendChild(svgEl('path', {
        d,
        stroke: colors.field,
        'stroke-width': 1.2,
        'stroke-linecap': 'round',
        fill: 'none',
        opacity: 0.75,
      }));
    }

    // Серии
    const legend = [];
    for (const series of this.data?.series || []) {
      const d = pathFromPoints(series.points || [], sx, sy);
      if (!d) continue;

      plot.appendChild(svgEl('path', {
        d,
        fill: 'none',
        stroke: series.color,
        'stroke-width': 7,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        opacity: 0.16,
      }));
      plot.appendChild(svgEl('path', {
        d,
        fill: 'none',
        stroke: series.color,
        'stroke-width': series.dashed ? 1.8 : 2.3,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': series.dashed ? '7 6' : null,
      }));

      legend.push({ name: series.name, color: series.color });

      const first = (series.points || []).find((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
      if (first) {
        plot.appendChild(svgEl('circle', {
          cx: sx(first[0]), cy: sy(first[1]), r: 4.5,
          fill: colors.bg, stroke: series.color, 'stroke-width': 2.5,
        }));
      }
    }

    // Легенда
    let legendX = MARGIN.l + 10;
    const legendY = MARGIN.t + 14;
    for (const item of legend) {
      this.svg.appendChild(svgEl('line', {
        x1: legendX, y1: legendY - 4, x2: legendX + 18, y2: legendY - 4,
        stroke: item.color, 'stroke-width': 2.5, 'stroke-linecap': 'round',
      }));
      const label = svgEl('text', {
        x: legendX + 24, y: legendY,
        fill: colors.text, 'font-size': 11.5,
      });
      label.textContent = item.name;
      this.svg.appendChild(label);
      legendX += 24 + Math.max(34, item.name.length * 7) + 22;
    }

    this.overlay = svgEl('g');
    this.svg.appendChild(this.overlay);
  }

  clearOverlay() {
    if (this.overlay) this.overlay.replaceChildren();
  }

  svgPoint(event) {
    const rect = this.svg.getBoundingClientRect();
    const width = this.lastRender?.width || rect.width;
    const height = this.lastRender?.height || rect.height;
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    };
  }

  onWheel(event) {
    if (!this.view || !this.lastRender) return;
    event.preventDefault();
    const point = this.svgPoint(event);
    const view = this.view;

    const anchorX = view.x0 + ((point.x - MARGIN.l) / this.lastRender.innerWidth) * (view.x1 - view.x0);
    const anchorY = view.y1 - ((point.y - MARGIN.t) / this.lastRender.innerHeight) * (view.y1 - view.y0);

    const factor = Math.exp(event.deltaY * 0.0012);
    const next = {
      x0: anchorX + (view.x0 - anchorX) * factor,
      x1: anchorX + (view.x1 - anchorX) * factor,
      y0: anchorY + (view.y0 - anchorY) * factor,
      y1: anchorY + (view.y1 - anchorY) * factor,
    };

    if (!(next.x1 - next.x0 > 1e-12) || !(next.y1 - next.y0 > 1e-12)) return;
    if ((next.x1 - next.x0) > 1e10 || (next.y1 - next.y0) > 1e10) return;

    this.view = next;
    this.tooltip.hidden = true;
    this.clearOverlay();
    this.scheduleRender();
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    this.svg.setPointerCapture(event.pointerId);
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      view: { ...this.view },
    };
    this.tooltip.hidden = true;
  }

  onPointerMove(event) {
    if (this.drag) {
      const dxPixels = event.clientX - this.drag.lastX;
      const dyPixels = event.clientY - this.drag.lastY;
      if (Math.abs(event.clientX - this.drag.startX) + Math.abs(event.clientY - this.drag.startY) > 3) {
        this.drag.moved = true;
      }
      this.drag.lastX = event.clientX;
      this.drag.lastY = event.clientY;

      if (this.drag.moved && this.lastRender) {
        const { innerWidth, innerHeight, width } = this.lastRender;
        const view = this.drag.view;
        const rect = this.svg.getBoundingClientRect();
        const scale = width / (rect.width || width);
        const dataDx = (dxPixels * scale * (view.x1 - view.x0)) / innerWidth;
        const dataDy = (dyPixels * scale * (view.y1 - view.y0)) / innerHeight;

        this.view = {
          x0: view.x0 - dataDx,
          x1: view.x1 - dataDx,
          y0: view.y0 + dataDy,
          y1: view.y1 + dataDy,
        };
        this.drag.view = { ...this.view };
        this.clearOverlay();
        this.scheduleRender();
      }
      return;
    }
    this.updateHover(event);
  }

  onPointerUp(event) {
    if (this.drag) {
      try {
        this.svg.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer уже отпущен */
      }
      const dragged = this.drag.moved;
      this.drag = null;
      if (!dragged) this.updateHover(event);
    }
  }

  updateHover(event) {
    if (!this.lastRender || !this.data) return;
    const point = this.svgPoint(event);
    const { sx, sy, view, innerWidth, innerHeight } = this.lastRender;

    const inside = point.x >= MARGIN.l && point.x <= MARGIN.l + innerWidth
      && point.y >= MARGIN.t && point.y <= MARGIN.t + innerHeight;
    if (!inside) {
      this.tooltip.hidden = true;
      this.clearOverlay();
      return;
    }

    const dataX = view.x0 + ((point.x - MARGIN.l) / innerWidth) * (view.x1 - view.x0);

    if (this.data.phase) {
      this.hoverPhase(point, dataX);
      return;
    }

    const rows = [];
    let guideX = null;
    for (const series of this.data.series || []) {
      const sample = sampleSeries(series.points || [], dataX);
      if (!sample) continue;
      rows.push({ name: series.name, value: sample[1], color: series.color });
      guideX = sample[0];
    }
    if (!rows.length) {
      this.tooltip.hidden = true;
      this.clearOverlay();
      return;
    }

    this.clearOverlay();
    const gx = sx(guideX);
    this.overlay.appendChild(svgEl('line', {
      x1: gx, y1: MARGIN.t, x2: gx, y2: MARGIN.t + innerHeight,
      stroke: this.colors.accent, 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.8,
    }));

    for (const row of rows) {
      this.overlay.appendChild(svgEl('circle', {
        cx: gx, cy: sy(row.value), r: 4,
        fill: row.color, stroke: this.colors.bg, 'stroke-width': 2,
      }));
    }

    const html = [
      `<div class="plot-tooltip-x">${this.data.xLabel || 'x'} = ${formatNumber(guideX)}</div>`,
      ...rows.map((row) => (
        `<div class="plot-tooltip-row"><span class="plot-tooltip-dot" style="background:${row.color}"></span>`
        + `<span>${row.name}</span><b>${formatNumber(row.value)}</b></div>`
      )),
    ].join('');

    this.positionTooltip(event, html);
  }

  hoverPhase(point, dataX) {
    // В фазовом портрете ищем ближайшую точку траектории в координатах (y, y').
    const series = this.data.series?.[0];
    if (!series) return;
    const { sx, sy, view, innerWidth, innerHeight } = this.lastRender;
    const dataY = view.y1 - ((point.y - MARGIN.t) / innerHeight) * (view.y1 - view.y0);

    let best = null;
    let bestDistance = Infinity;
    for (const [x, y] of series.points || []) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const distance = ((sx(x) - sx(dataX)) ** 2) + ((sy(y) - sy(dataY)) ** 2);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [x, y];
      }
    }
    if (!best) return;

    this.clearOverlay();
    this.overlay.appendChild(svgEl('circle', {
      cx: sx(best[0]), cy: sy(best[1]), r: 5,
      fill: series.color, stroke: this.colors.bg, 'stroke-width': 2,
    }));

    const html = [
      `<div class="plot-tooltip-x">точка траектории</div>`,
      `<div class="plot-tooltip-row"><span>${this.data.xLabel || 'y'}</span><b>${formatNumber(best[0])}</b></div>`,
      `<div class="plot-tooltip-row"><span>${this.data.yLabel || "y\u2032"}</span><b>${formatNumber(best[1])}</b></div>`,
    ].join('');
    this.positionTooltip(event, html);
  }

  positionTooltip(event, html) {
    const rect = this.container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    this.tooltip.innerHTML = html;
    this.tooltip.hidden = false;
    const tipRect = this.tooltip.getBoundingClientRect();
    const left = x + 16 + tipRect.width > rect.width ? x - tipRect.width - 16 : x + 16;
    const top = Math.max(8, Math.min(rect.height - tipRect.height - 8, y - tipRect.height / 2));
    this.tooltip.style.left = `${Math.max(8, left)}px`;
    this.tooltip.style.top = `${top}px`;
  }

  exportSvg() {
    if (!this.lastRender) return null;
    const clone = this.svg.cloneNode(true);
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('width', String(this.lastRender.width));
    clone.setAttribute('height', String(this.lastRender.height));
    const background = svgEl('rect', {
      x: 0,
      y: 0,
      width: this.lastRender.width,
      height: this.lastRender.height,
      fill: this.colors.bg,
    });
    clone.insertBefore(background, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.svg.remove();
    this.tooltip.remove();
  }
}

function sampleSeries(points, targetX) {
  if (!points.length) return null;
  let previous = null;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    if (point[0] >= targetX) {
      if (!previous) return point;
      const span = point[0] - previous[0];
      if (span <= 0) return point;
      const ratio = (targetX - previous[0]) / span;
      return [targetX, previous[1] + (point[1] - previous[1]) * ratio];
    }
    previous = point;
  }
  return previous;
}
