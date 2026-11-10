/*
 * solver-worker.js — изолированный поток, в котором живёт Python (Pyodide).
 * Тяжёлые вычисления не блокируют интерфейс.
 */

/* global importScripts */

const PYODIDE_VERSION = '0.29.5';
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const CORE_URL = new URL('./solver_core.py', self.location.href).toString();

let pyodide = null;
let coreSource = '';
let initPromise = null;

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function friendlyError(error) {
  const text = String(error?.message || error || '').trim();
  if (/Failed to fetch|NetworkError|Load failed|network error/i.test(text)) {
    return 'Не удалось скачать пакеты Pyodide с CDN. Проверьте интернет-соединение и попробуйте снова.';
  }
  if (/ModuleNotFoundError|not installed/i.test(text)) {
    return 'Не удалось установить математические пакеты. Попробуйте перезапустить движок.';
  }
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || 'Неизвестная ошибка инициализации.';
  return firstLine.length > 260 ? `${firstLine.slice(0, 257)}…` : firstLine;
}

async function loadPackageWithRetry(runtime, name) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await runtime.loadPackage(name);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Не удалось загрузить пакет ${name}.`);
}

async function init() {
  if (pyodide) return pyodide;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const started = Date.now();

    post('progress', { stage: 'runtime', message: 'Загружаю Pyodide — Python для браузера…' });
    if (!self.loadPyodide) {
      importScripts(`${INDEX_URL}pyodide.js`);
    }
    if (!self.loadPyodide) {
      throw new Error('Не удалось загрузить загрузчик Pyodide с CDN.');
    }

    const runtime = await self.loadPyodide({ indexURL: INDEX_URL });

    post('progress', { stage: 'sympy', message: 'Устанавливаю SymPy (символьные вычисления)…' });
    await loadPackageWithRetry(runtime, 'sympy');

    post('progress', { stage: 'scipy', message: 'Устанавливаю SciPy (численное интегрирование)…' });
    await loadPackageWithRetry(runtime, 'scipy');

    post('progress', { stage: 'core', message: 'Готовлю решатель…' });
    const response = await fetch(CORE_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Не удалось загрузить solver_core.py (HTTP ${response.status}).`);
    }
    coreSource = await response.text();

    runtime.runPython(coreSource);
    pyodide = runtime;

    post('ready', {
      python: runtime.version,
      ms: Date.now() - started,
    });
    return runtime;
  })().catch((error) => {
    initPromise = null;
    pyodide = null;
    throw error;
  });

  return initPromise;
}

self.onmessage = async (event) => {
  const message = event.data || {};

  if (message.type === 'init') {
    try {
      await init();
    } catch (error) {
      post('init-error', {
        error: friendlyError(error),
      });
    }
    return;
  }

  if (message.type === 'solve') {
    const { id, payload } = message;
    try {
      await init();
      post('progress', { id, stage: 'solving', message: 'Решаю уравнение…' });

      const started = Date.now();
      pyodide.globals.set('PAYLOAD_JSON', JSON.stringify(payload));
      const raw = pyodide.runPython('solve_problem(PAYLOAD_JSON)');
      const data = JSON.parse(String(raw));
      data.client = { solve_ms: Date.now() - started, core_bytes: coreSource.length };
      post('result', { id, data });
    } catch (error) {
      post('result', {
        id,
        data: {
          ok: false,
          error: friendlyError(error),
        },
      });
    }
  }
};
