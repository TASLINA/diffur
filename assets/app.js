import { parseEquation, ParseError } from './lib/parser.js';
import { SolverClient } from './lib/solver-client.js';
import { rk4, directionField } from './lib/numeric.js';
import { Plot, computeViewFromSeries } from './lib/plot.js';
import { EXAMPLES } from './lib/examples.js';

const HISTORY_KEY = 'diffur.history.v1';
const THEME_KEY = 'diffur.theme.v1';
const MAX_HISTORY = 8;

const $ = (id) => document.getElementById(id);

const dom = {};
const state = {
  parsed: null,
  result: null,
  params: null,
  engine: 'idle',
  engineDisabled: false,
  engineError: null,
  loading: false,
  plotMode: 'solution',
  showField: true,
  history: [],
  theme: 'dark',
  copyLatex: '',
};

const solver = new SolverClient();
let plot = null;
let parseTimer = 0;
let toastTimer = 0;

/* ------------------------------------------------------------------ */
/* Вспомогательные функции                                             */
/* ------------------------------------------------------------------ */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) {
    return value.toExponential(2).replace('.', ',');
  }
  const fixed = Number(value.toFixed(digits));
  return String(fixed).replace('.', ',');
}

function parseNumberInput(value) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  if (!normalized) return Number.NaN;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : Number.NaN;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  return `${(ms / 1000).toFixed(2).replace('.', ',')} с`;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function renderTex(element, tex, displayMode = true) {
  element.replaceChildren();
  if (window.katex) {
    try {
      window.katex.render(tex, element, {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      });
      return;
    } catch {
      /* покажем исходный текст */
    }
  }
  element.textContent = tex;
}

function toast(message, tone = 'ok') {
  let element = $('toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'toast';
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 2800);
}

async function copyText(text, message) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast(message);
    } catch {
      toast('Не удалось скопировать', 'warn');
    }
    area.remove();
  }
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function waitForGlobal(name, timeout = 20000) {
  return new Promise((resolve, reject) => {
    if (window[name]) {
      resolve(window[name]);
      return;
    }
    const started = performance.now();
    const tick = () => {
      if (window[name]) {
        resolve(window[name]);
        return;
      }
      if (performance.now() - started > timeout) {
        reject(new Error(`Не удалось загрузить «${name}» с CDN.`));
        return;
      }
      setTimeout(tick, 60);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ */
/* Тема                                                                */
/* ------------------------------------------------------------------ */

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  state.theme = saved || (prefersLight ? 'light' : 'dark');
  applyTheme(state.theme);
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const button = dom.themeToggle;
  if (button) {
    button.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
    button.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* приватный режим */
  }
  if (plot?.data) {
    plot.colors = plot.readColors();
    plot.render();
  }
}

/* ------------------------------------------------------------------ */
/* Парсинг и предпросмотр                                              */
/* ------------------------------------------------------------------ */

function parseCurrent({ silent = false } = {}) {
  const raw = dom.equationInput.value;
  if (!raw.trim()) {
    state.parsed = null;
    dom.orderBadge.textContent = '—';
    dom.dy0Field.hidden = true;
    dom.equationPreview.replaceChildren();
    if (!silent) setEquationError('Введите уравнение.', '');
    return null;
  }

  try {
    const parsed = parseEquation(raw);
    state.parsed = parsed;
    dom.orderBadge.textContent = `${parsed.order}-й порядок`;
    dom.dy0Field.hidden = parsed.order < 2;
    renderPreview(parsed);
    clearEquationError();
    return parsed;
  } catch (error) {
    state.parsed = null;
    dom.orderBadge.textContent = '—';
    dom.dy0Field.hidden = true;
    dom.equationPreview.replaceChildren();
    if (!silent) {
      if (error instanceof ParseError) setEquationError(error.message, error.detail);
      else {
        console.error(error);
        setEquationError('Не удалось разобрать уравнение.', String(error?.message || error));
      }
    } else {
      clearEquationError();
    }
    return null;
  }
}

function renderPreview(parsed) {
  renderTex(dom.equationPreview, parsed.equationTex, true);
}

function setEquationError(message, detail = '') {
  dom.equationError.textContent = detail ? `${message} ${detail}` : message;
  dom.equationError.hidden = false;
  dom.equationWrap.classList.add('is-invalid');
}

function clearEquationError() {
  dom.equationError.textContent = '';
  dom.equationError.hidden = true;
  dom.equationWrap.classList.remove('is-invalid');
}

/* ------------------------------------------------------------------ */
/* Параметры задачи                                                    */
/* ------------------------------------------------------------------ */

function readParams(parsed) {
  const x0 = parseNumberInput(dom.x0.value);
  const y0 = parseNumberInput(dom.y0.value);
  const xEnd = parseNumberInput(dom.xEnd.value);
  const dy0 = parseNumberInput(dom.dy0.value);

  if (!Number.isFinite(x0) || !Number.isFinite(y0)) {
    throw new Error('Заполните начальные условия x₀ и y(x₀) числами.');
  }
  if (!Number.isFinite(xEnd)) {
    throw new Error('Укажите конечную точку интервала x.');
  }
  if (xEnd === x0) {
    throw new Error('Начало и конец интервала совпадают.');
  }
  if (parsed.order >= 2 && !Number.isFinite(dy0)) {
    throw new Error('Для уравнения второго порядка нужно задать y′(x₀).');
  }

  return {
    equation: dom.equationInput.value,
    order: parsed.order,
    x0,
    y0,
    dy0: parsed.order >= 2 ? dy0 : 0,
    xEnd,
    method: dom.method.value,
  };
}

/* ------------------------------------------------------------------ */
/* Движок                                                              */
/* ------------------------------------------------------------------ */

function updateEngineBadge(status, message = '') {
  const labels = {
    idle: 'движок не загружен',
    loading: message ? 'загружаю движок…' : 'загрузка…',
    ready: 'движок готов',
    failed: 'движок недоступен',
  };
  dom.engineBadge.dataset.state = status;
  dom.engineText.textContent = labels[status] || labels.idle;
  dom.engineBadge.title = status === 'idle'
    ? 'Нажмите, чтобы загрузить SymPy и SciPy заранее'
    : message || labels[status];
}

async function ensureEngine() {
  if (state.engine === 'ready') return true;
  if (state.engineDisabled) return false;
  try {
    await solver.init();
    return true;
  } catch (error) {
    state.engineDisabled = true;
    state.engineError = error;
    console.warn('Движок недоступен:', error);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Основной сценарий                                                   */
/* ------------------------------------------------------------------ */

async function solve() {
  if (state.loading) return;

  const parsed = parseCurrent({ silent: false });
  if (!parsed) {
    showError('Проверьте уравнение', dom.equationError.textContent || 'Не удалось разобрать уравнение.');
    return;
  }

  let params;
  try {
    params = readParams(parsed);
  } catch (error) {
    showError('Проверьте параметры', error.message);
    return;
  }

  state.loading = true;
  setBusy(true);
  showLoading(true, 'Готовлю решатель…');

  const payload = {
    rhsSympy: parsed.rhsSympy,
    rhsNumeric: parsed.rhsNumeric,
    order: parsed.order,
    x0: params.x0,
    y0: params.y0,
    dy0: params.dy0,
    x_end: params.xEnd,
    method: params.method,
    auto: params.method === 'auto',
    rtol: 1e-6,
    atol: 1e-9,
  };

  const started = performance.now();
  const engineReady = await Promise.all([ensureEngine(), delay(260)]).then(([ready]) => ready);

  if (!engineReady) {
    const result = runFallback(parsed, params, state.engineError);
    result.client = { solve_ms: Math.round(performance.now() - started) };
    finishSolve(result, parsed, params);
    return;
  }

  showLoading(true, 'Решаю уравнение…');
  try {
    const result = await solver.solve(payload, {
      onProgress: (message) => {
        if (message.message) showLoading(true, message.message);
      },
    });
    if (!result.ok) throw new Error(result.error || 'Решатель вернул ошибку.');
    result.client = result.client || { solve_ms: Math.round(performance.now() - started) };
    finishSolve(result, parsed, params);
  } catch (error) {
    console.warn('Основной решатель не справился:', error);
    const result = runFallback(parsed, params, error);
    result.client = { solve_ms: Math.round(performance.now() - started) };
    finishSolve(result, parsed, params);
  }
}

function finishSolve(result, parsed, params) {
  state.result = result;
  state.params = params;
  state.loading = false;

  saveHistory(params);
  renderResult(result, parsed, params);
  updateShareUrl(params);

  showLoading(false);
  setBusy(false);

  // Прокрутить к результату на узких экранах
  if (window.matchMedia('(max-width: 980px)').matches) {
    dom.resultBody.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function runFallback(parsed, params, reason) {
  const numeric = rk4({
    rhs: parsed.evaluate,
    x0: params.x0,
    y0: params.y0,
    dy0: params.dy0,
    xEnd: params.xEnd,
    order: parsed.order,
  });

  const warnings = [
    'Символьный движок недоступен, поэтому показано только приближённое решение.',
  ];
  if (reason?.message) warnings.push(`Причина: ${reason.message}`);
  if (numeric.message) warnings.push(numeric.message);

  return {
    ok: true,
    order: parsed.order,
    rhs_latex: parsed.rhsTex,
    classification: [],
    symbolic: null,
    symbolic_error: 'Точное решение недоступно в резервном режиме.',
    symbolic_detail: reason?.message || '',
    numeric: numeric.ok ? {
      ok: true,
      t: numeric.t,
      y: numeric.y,
      dy: numeric.dy,
      stats: {
        method: 'RK4 · JS',
        status: numeric.partial ? 1 : 0,
        success: !numeric.partial,
        message: numeric.message || '',
        points: numeric.t.length,
        nfev: numeric.t.length * 4,
        t_end: numeric.t[numeric.t.length - 1],
        y_end: numeric.y[numeric.y.length - 1],
      },
      partial: numeric.partial,
      warnings: numeric.message ? [numeric.message] : [],
    } : { ok: false, error: numeric.error },
    warnings,
    fallback: true,
  };
}

/* ------------------------------------------------------------------ */
/* Состояния панели результата                                         */
/* ------------------------------------------------------------------ */

function setBusy(busy) {
  dom.solveBtn.disabled = busy;
  dom.solveBtn.classList.toggle('is-busy', busy);
  dom.solveBtnText.textContent = busy ? 'Считаю…' : 'Решить';
}

function showLoading(visible, message) {
  if (visible) {
    dom.resultEmpty.hidden = true;
    dom.resultError.hidden = true;
    dom.resultBody.hidden = true;
  }
  dom.resultLoading.hidden = !visible;
  if (message) dom.loadingMessage.textContent = message;
  setBusy(state.loading);
}

function showError(title, message, detail = '') {
  state.loading = false;
  setBusy(false);
  dom.resultEmpty.hidden = true;
  dom.resultLoading.hidden = true;
  dom.resultBody.hidden = true;
  dom.resultError.hidden = false;
  dom.errorTitle.textContent = title;
  dom.errorMessage.textContent = message;
  if (detail) {
    dom.errorDetail.hidden = false;
    dom.errorDetail.textContent = detail;
  } else {
    dom.errorDetail.hidden = true;
    dom.errorDetail.textContent = '';
  }
}

/* ------------------------------------------------------------------ */
/* Отрисовка результата                                                */
/* ------------------------------------------------------------------ */

function renderResult(result, parsed, params) {
  dom.resultEmpty.hidden = true;
  dom.resultError.hidden = true;
  dom.resultLoading.hidden = true;
  dom.resultBody.hidden = false;

  renderStatus(result, parsed, params);
  renderWarnings(result);
  renderSymbolic(result, params);
  renderNumeric(result, params);
  renderPlotArea(result, parsed);
  renderSteps(result, parsed, params);
}

function addChip(container, text, tone = '') {
  const chip = document.createElement('span');
  chip.className = `chip${tone ? ` chip-${tone}` : ''}`;
  chip.textContent = text;
  container.appendChild(chip);
  return chip;
}

function renderStatus(result, parsed, params) {
  dom.statusRow.replaceChildren();
  addChip(dom.statusRow, `${parsed.order}-й порядок`, 'accent');

  const method = result.numeric?.stats?.method;
  if (method) addChip(dom.statusRow, method);

  const ms = result.client?.solve_ms ?? result.timing?.total_ms;
  if (Number.isFinite(ms)) addChip(dom.statusRow, formatDuration(ms));

  if (result.symbolic) addChip(dom.statusRow, 'точное решение', 'ok');
  else addChip(dom.statusRow, 'только численно', 'muted');

  if (result.fallback) addChip(dom.statusRow, 'резервный режим', 'warn');
  if (params.method === 'auto') addChip(dom.statusRow, 'метод авто');
}

function renderWarnings(result) {
  const banner = dom.warningBanner;
  const title = dom.warningTitle;
  const text = dom.warningText;
  const retry = dom.retryEngine;

  title.textContent = '';
  text.textContent = '';
  retry.hidden = true;
  banner.hidden = true;
  banner.dataset.tone = 'warn';

  if (result.fallback) {
    banner.hidden = false;
    title.textContent = 'Символьный движок недоступен';
    text.textContent = result.symbolic_detail
      ? `Показано приближённое численное решение. ${result.symbolic_detail}`
      : 'Показано приближённое численное решение: SymPy и SciPy не загрузились.';
    retry.hidden = false;
    return;
  }

  const messages = [];
  if (result.numeric?.partial) {
    messages.push('Интегрирование остановлено раньше конца интервала — вероятно, решение имеет особенность.');
  }
  for (const warning of result.warnings || []) {
    if (!messages.includes(warning)) messages.push(warning);
  }

  if (messages.length) {
    banner.hidden = false;
    banner.dataset.tone = result.numeric?.partial ? 'warn' : 'info';
    title.textContent = result.numeric?.partial ? 'Решение оборвалось' : 'Замечания';
    text.textContent = messages.join(' ');
  }
}

function renderSymbolic(result, params) {
  const symbolic = result.symbolic;
  const badge = dom.verifyBadge;
  const chips = dom.classificationChips;

  chips.replaceChildren();
  dom.symbolicCard.classList.toggle('is-empty', !symbolic);

  if (!symbolic) {
    dom.symbolicTex.innerHTML = `<p class="muted">${escapeHtml(result.symbolic_error || 'Точное решение не найдено.')}</p>`;
    dom.symbolicNote.textContent = 'Точное решение в элементарных функциях не найдено — смотрите численное решение ниже.';
    badge.hidden = true;
    dom.copyLatexBtn.disabled = true;
    state.copyLatex = '';
    return;
  }

  const tex = symbolic.explicit
    ? `y\\left(x\\right) = ${symbolic.latex}`
    : symbolic.latex;

  state.copyLatex = tex;
  renderTex(dom.symbolicTex, tex, true);
  dom.copyLatexBtn.disabled = false;

  if (symbolic.verified === true) {
    badge.hidden = false;
    badge.className = 'verify-badge is-ok';
    badge.textContent = '✓ проверено подстановкой';
  } else if (symbolic.verified === false) {
    badge.hidden = false;
    badge.className = 'verify-badge is-warn';
    badge.textContent = 'проверка не пройдена';
  } else {
    badge.hidden = false;
    badge.className = 'verify-badge is-muted';
    badge.textContent = 'проверка недоступна';
  }

  for (const item of result.classification || []) {
    addChip(chips, item.label);
  }
  if (!symbolic.explicit) addChip(chips, 'неявное решение', 'muted');

  const notes = [];
  if (!symbolic.explicit) {
    notes.push('Точное решение записано в неявном виде; для графика используется численное решение.');
  }
  for (const note of symbolic.notes || []) notes.push(note);
  const numericPartial = Boolean(result.numeric?.ok && result.numeric.partial);
  if (Number.isFinite(symbolic.endpoint) && !numericPartial) {
    notes.push(`y(${formatNumber(params.xEnd)}) ≈ ${formatNumber(symbolic.endpoint)}.`);
  }
  dom.symbolicNote.textContent = notes.join(' ');
}

function renderNumeric(result, params) {
  const numeric = result.numeric;
  dom.numericStats.replaceChildren();
  dom.numericNote.textContent = '';
  dom.numericMethod.textContent = '';

  if (!numeric || !numeric.ok) {
    const message = numeric?.error || 'Численное решение недоступно.';
    const paragraph = document.createElement('p');
    paragraph.className = 'muted';
    paragraph.textContent = message;
    dom.numericStats.appendChild(paragraph);
    return;
  }

  const stats = numeric.stats || {};
  dom.numericMethod.textContent = stats.method || '';

  const endLabel = numeric.partial
    ? `y(${formatNumber(stats.t_end)})`
    : `y(${formatNumber(params.xEnd)})`;

  const items = [
    ['метод', stats.method || '—'],
    ['точек', Number.isFinite(stats.points) ? String(stats.points) : String(numeric.t?.length ?? '—')],
    ['вычислений f', Number.isFinite(stats.nfev) ? String(stats.nfev) : '—'],
    [endLabel, formatNumber(stats.y_end)],
  ];

  for (const [label, value] of items) {
    const box = document.createElement('div');
    box.className = 'stat';
    const caption = document.createElement('span');
    caption.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    box.append(caption, strong);
    dom.numericStats.appendChild(box);
  }

  const notes = [];
  if (numeric.partial) {
    notes.push(`Решение оборвалось на x = ${formatNumber(stats.t_end)}: дальше функция уходит в бесконечность или теряет гладкость.`);
  }
  for (const warning of numeric.warnings || []) {
    if (!notes.includes(warning)) notes.push(warning);
  }
  if (result.fallback) {
    notes.push('Резервный метод Рунге–Кутты 4-го порядка: без адаптивного контроля точности.');
  }
  dom.numericNote.textContent = notes.join(' ');
}

/* ------------------------------------------------------------------ */
/* График                                                              */
/* ------------------------------------------------------------------ */

function getPlotSource(result) {
  const numeric = result.numeric;
  if (numeric?.ok && Array.isArray(numeric.t) && numeric.t.length) {
    const points = numeric.t.map((x, index) => [x, numeric.y[index]]);
    const dyPoints = Array.isArray(numeric.dy)
      ? numeric.t.map((x, index) => [x, numeric.dy[index]])
      : null;
    return { points, dyPoints };
  }

  const curve = result.symbolic?.curve;
  if (curve?.t?.length) {
    return {
      points: curve.t.map((x, index) => [x, curve.y[index]]),
      dyPoints: null,
    };
  }
  return null;
}

function renderPlotArea(result, parsed) {
  const source = getPlotSource(result);
  if (!source?.points?.length) {
    dom.plotCard.hidden = true;
    return;
  }
  dom.plotCard.hidden = false;

  const phaseAvailable = parsed.order === 2 && Array.isArray(source.dyPoints);
  if (!phaseAvailable) state.plotMode = 'solution';

  dom.plotModeSwitch.hidden = !phaseAvailable;
  for (const button of dom.plotModeSwitch.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.mode === state.plotMode);
  }
  dom.fieldToggleWrap.hidden = parsed.order !== 1 || state.plotMode === 'phase';

  let series;
  if (state.plotMode === 'phase' && phaseAvailable) {
    series = [{
      name: 'фаз. траектория',
      color: '#b18cff',
      points: source.points.map((point, index) => [point[1], source.dyPoints[index][1]]),
    }];
    dom.plotTitle.textContent = 'Фазовый портрет (y, y′)';
  } else {
    series = [{ name: 'y(x)', color: '#7c9cff', points: source.points }];
    if (Array.isArray(source.dyPoints)) {
      series.push({
        name: 'y′(x)',
        color: '#56d4c4',
        points: source.dyPoints,
        dashed: true,
      });
    }
    dom.plotTitle.textContent = parsed.order === 1 && state.showField
      ? 'Решение и поле направлений'
      : 'График решения';
  }

  let field = null;
  if (parsed.order === 1 && state.showField && state.plotMode === 'solution') {
    const view = computeViewFromSeries(series);
    field = directionField(parsed.evaluate, view, 26, 18);
  }

  plot.setData({
    series,
    field,
    phase: state.plotMode === 'phase',
    xLabel: state.plotMode === 'phase' ? 'y' : 'x',
    yLabel: state.plotMode === 'phase' ? "y\u2032" : 'y',
  });
}

/* ------------------------------------------------------------------ */
/* Шаги решения                                                        */
/* ------------------------------------------------------------------ */

function renderSteps(result, parsed, params) {
  const steps = [];

  steps.push({
    title: 'Исходная запись',
    code: parsed.cleaned,
  });

  steps.push({
    title: 'Приведено к явному виду',
    tex: parsed.equationTex,
  });

  if (result.classification?.length) {
    steps.push({
      title: 'Тип уравнения',
      text: result.classification.map((item) => item.label).join(', '),
    });
  }

  if (result.symbolic) {
    steps.push({
      title: 'Точное решение',
      tex: result.symbolic.explicit
        ? `y\\left(x\\right) = ${result.symbolic.latex}`
        : result.symbolic.latex,
    });
    if (result.symbolic.verified === true) {
      steps.push({
        title: 'Проверка',
        text: 'Подстановка в исходное уравнение даёт тождественный ноль — решение верно.',
      });
    } else if (result.symbolic.verified === false) {
      steps.push({
        title: 'Проверка',
        text: 'Подстановка не дала тождества. Решение стоит воспринимать с осторожностью.',
      });
    } else {
      steps.push({
        title: 'Проверка',
        text: 'Автоматическую проверку выполнить не удалось.',
      });
    }
  } else {
    steps.push({
      title: 'Точное решение',
      text: result.symbolic_error || 'SymPy не нашёл решение в элементарных функциях.',
    });
  }

  if (result.numeric?.ok) {
    const stats = result.numeric.stats || {};
    steps.push({
      title: 'Численное интегрирование',
      text: `${stats.method || 'RK45'}, ${stats.points || '—'} точек вывода, `
        + `относительная точность 10⁻⁶.`,
    });
  } else {
    steps.push({
      title: 'Численное интегрирование',
      text: result.numeric?.error || 'Недоступно.',
    });
  }

  dom.stepsList.replaceChildren();
  const texJobs = [];

  for (const step of steps) {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = step.title;

    const body = document.createElement('div');
    body.className = 'step-body';

    if (step.code) {
      const code = document.createElement('code');
      code.textContent = step.code;
      body.appendChild(code);
    } else if (step.tex) {
      const texNode = document.createElement('div');
      texNode.className = 'step-tex';
      body.appendChild(texNode);
      texJobs.push({ node: texNode, tex: step.tex });
    } else {
      body.textContent = step.text || '';
    }

    item.append(title, body);
    dom.stepsList.appendChild(item);
  }

  for (const job of texJobs) renderTex(job.node, job.tex, true);
}

/* ------------------------------------------------------------------ */
/* История                                                             */
/* ------------------------------------------------------------------ */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const data = raw ? JSON.parse(raw) : [];
    state.history = Array.isArray(data) ? data.slice(0, MAX_HISTORY) : [];
  } catch {
    state.history = [];
  }
  renderHistory();
}

function saveHistory(params) {
  const item = {
    equation: params.equation,
    x0: params.x0,
    y0: params.y0,
    dy0: params.dy0,
    xEnd: params.xEnd,
    method: params.method,
    order: params.order,
    ts: Date.now(),
  };

  state.history = [
    item,
    ...state.history.filter((entry) => !(entry.equation === item.equation
      && entry.x0 === item.x0 && entry.y0 === item.y0
      && entry.dy0 === item.dy0 && entry.xEnd === item.xEnd
      && entry.method === item.method)),
  ].slice(0, MAX_HISTORY);

  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  } catch {
    /* приватный режим */
  }
  renderHistory();
}

function renderHistory() {
  dom.historySection.hidden = state.history.length === 0;
  dom.historyList.replaceChildren();

  for (const item of state.history) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';

    const equation = document.createElement('code');
    equation.textContent = item.equation;

    const meta = document.createElement('span');
    meta.textContent = `x₀ = ${formatNumber(item.x0)}, y₀ = ${formatNumber(item.y0)}`;

    button.append(equation, meta);
    button.addEventListener('click', () => restoreHistory(item));
    dom.historyList.appendChild(button);
  }
}

function restoreHistory(item) {
  dom.equationInput.value = item.equation;
  dom.x0.value = item.x0;
  dom.y0.value = item.y0;
  dom.dy0.value = item.dy0 ?? 0;
  dom.xEnd.value = item.xEnd;
  dom.method.value = item.method || 'auto';
  parseCurrent({ silent: true });
  solve();
}

/* ------------------------------------------------------------------ */
/* Ссылка на задачу                                                    */
/* ------------------------------------------------------------------ */

function updateShareUrl(params) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('eq', params.equation);
    url.searchParams.set('x0', String(params.x0));
    url.searchParams.set('y0', String(params.y0));
    url.searchParams.set('xEnd', String(params.xEnd));
    url.searchParams.set('run', '1');
    if (params.order >= 2) url.searchParams.set('dy0', String(params.dy0));
    else url.searchParams.delete('dy0');
    if (params.method && params.method !== 'auto') url.searchParams.set('method', params.method);
    else url.searchParams.delete('method');
    window.history.replaceState(null, '', url);
  } catch {
    /* например, file:// */
  }
}

function loadFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const equation = params.get('eq');
  if (!equation) return { loaded: false, run: false };

  dom.equationInput.value = equation;
  if (params.has('x0')) dom.x0.value = params.get('x0');
  if (params.has('y0')) dom.y0.value = params.get('y0');
  if (params.has('dy0')) dom.dy0.value = params.get('dy0');
  if (params.has('xEnd')) dom.xEnd.value = params.get('xEnd');
  if (params.has('method')) {
    const method = params.get('method');
    const allowed = Array.from(dom.method.options).some((option) => option.value === method);
    if (allowed) dom.method.value = method;
  }

  return { loaded: true, run: params.get('run') === '1' };
}

async function shareCurrent() {
  const parsed = parseCurrent({ silent: true });
  if (parsed) {
    try {
      const params = readParams(parsed);
      updateShareUrl(params);
    } catch {
      /* оставим ссылку без параметров */
    }
  }
  await copyText(window.location.href, 'Ссылка скопирована');
}

/* ------------------------------------------------------------------ */
/* Экспорт                                                             */
/* ------------------------------------------------------------------ */

function exportCsv() {
  const numeric = state.result?.numeric;
  if (!numeric?.ok) {
    toast('Нет численных данных для экспорта', 'warn');
    return;
  }

  const hasDerivative = Array.isArray(numeric.dy);
  const header = hasDerivative ? 'x,y,dy_dx' : 'x,y';
  const lines = [header];

  for (let index = 0; index < numeric.t.length; index += 1) {
    const row = [numeric.t[index], numeric.y[index]];
    if (hasDerivative) row.push(numeric.dy[index]);
    lines.push(row.join(','));
  }

  download(`diffur-${Date.now()}.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
  toast('CSV сохранён');
}

function exportSvg() {
  const svg = plot?.exportSvg();
  if (!svg) {
    toast('График ещё не построен', 'warn');
    return;
  }
  download(`diffur-${Date.now()}.svg`, svg, 'image/svg+xml;charset=utf-8');
  toast('SVG сохранён');
}

/* ------------------------------------------------------------------ */
/* События                                                             */
/* ------------------------------------------------------------------ */

function bindEvents() {
  dom.problemForm.addEventListener('submit', (event) => {
    event.preventDefault();
    solve();
  });

  dom.equationInput.addEventListener('input', () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => parseCurrent({ silent: true }), 220);
  });

  dom.equationInput.addEventListener('blur', () => {
    if (dom.equationInput.value.trim()) parseCurrent({ silent: false });
  });

  dom.equationInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      solve();
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      solve();
    }
  });

  dom.themeToggle.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  dom.engineBadge.addEventListener('click', async () => {
    if (state.engine === 'ready') {
      toast('SymPy и SciPy уже загружены');
      return;
    }
    if (state.engine === 'loading') return;
    state.engineDisabled = false;
    try {
      await solver.init();
      toast('Математический движок готов');
    } catch (error) {
      toast('Не удалось загрузить движок', 'warn');
      console.warn(error);
    }
  });

  dom.retryEngine.addEventListener('click', async () => {
    state.engineDisabled = false;
    state.engineError = null;
    solver.terminate();
    updateEngineBadge('idle');
    await solve();
  });

  dom.plotModeSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    state.plotMode = button.dataset.mode;
    if (state.params && state.parsed && state.result) {
      renderPlotArea(state.result, state.parsed);
    }
  });

  dom.fieldToggle.addEventListener('change', () => {
    state.showField = dom.fieldToggle.checked;
    if (state.result && state.parsed) renderPlotArea(state.result, state.parsed);
  });

  dom.resetViewBtn.addEventListener('click', () => plot.resetView());
  dom.exportSvgBtn.addEventListener('click', exportSvg);
  dom.exportCsvBtn.addEventListener('click', exportCsv);
  dom.copyLatexBtn.addEventListener('click', () => {
    if (!state.copyLatex) return;
    copyText(state.copyLatex, 'LaTeX скопирован');
  });
  dom.shareBtn.addEventListener('click', shareCurrent);

  dom.clearHistory.addEventListener('click', () => {
    state.history = [];
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* приватный режим */
    }
    renderHistory();
    toast('История очищена');
  });

  solver.onStatus(({ status, message }) => {
    state.engine = status;
    updateEngineBadge(status, message);
    if (state.loading && status === 'loading' && message) {
      dom.loadingMessage.textContent = message;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

function cacheDom() {
  const ids = [
    'engineBadge', 'engineText', 'themeToggle',
    'problemForm', 'equationInput', 'equationWrap', 'equationPreview',
    'equationError', 'equationHelp', 'orderBadge', 'x0', 'y0', 'dy0',
    'dy0Field', 'xEnd', 'method', 'solveBtn', 'solveBtnText', 'shareBtn',
    'exampleGrid', 'historySection', 'historyList', 'clearHistory',
    'resultEmpty', 'resultLoading', 'loadingMessage', 'resultError',
    'errorTitle', 'errorMessage', 'errorDetail', 'resultBody', 'statusRow',
    'warningBanner', 'warningTitle', 'warningText', 'retryEngine',
    'symbolicCard', 'symbolicTex', 'verifyBadge', 'classificationChips',
    'symbolicNote', 'copyLatexBtn', 'numericCard', 'numericMethod',
    'numericStats', 'numericNote', 'plotCard', 'plotTitle', 'plotModeSwitch',
    'fieldToggleWrap', 'fieldToggle', 'resetViewBtn', 'exportSvgBtn',
    'exportCsvBtn', 'plot', 'stepsCard', 'stepsList', 'resultSub',
  ];
  for (const id of ids) dom[id] = $(id);
}

function renderExamples() {
  dom.exampleGrid.replaceChildren();
  for (const example of EXAMPLES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example-item';

    const title = document.createElement('strong');
    title.textContent = example.title;

    const equation = document.createElement('code');
    equation.textContent = example.equation;

    const note = document.createElement('span');
    note.textContent = example.note;

    button.append(title, equation, note);
    button.addEventListener('click', () => {
      dom.equationInput.value = example.equation;
      dom.x0.value = example.x0;
      dom.y0.value = example.y0;
      dom.dy0.value = example.dy0 ?? 0;
      dom.xEnd.value = example.xEnd;
      dom.method.value = 'auto';
      parseCurrent({ silent: true });
      solve();
    });
    dom.exampleGrid.appendChild(button);
  }
}

async function init() {
  cacheDom();
  initTheme();
  renderExamples();
  loadHistory();

  plot = new Plot(dom.plot);
  bindEvents();

  const fromUrl = loadFromUrl();

  try {
    await Promise.all([waitForGlobal('math'), waitForGlobal('katex')]);
  } catch (error) {
    console.error(error);
    showError(
      'Не загрузились библиотеки',
      'Не удалось получить math.js или KaTeX с CDN. Проверьте интернет-соединение и обновите страницу.',
      String(error?.message || error),
    );
    return;
  }

  parseCurrent({ silent: true });

  if (fromUrl.loaded && fromUrl.run) {
    solve();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
