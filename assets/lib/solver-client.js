/*
 * solver-client.js — управляет Web Worker'ом с Pyodide.
 * Умеет: ленивую инициализацию, прогресс, таймауты, перезапуск после сбоя.
 */

const INIT_TIMEOUT = 240_000;
const SOLVE_TIMEOUT = 120_000;

export class SolverClient {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.initPromise = null;
    this.initResolve = null;
    this.initReject = null;
    this.pending = new Map();
    this.status = 'idle';
    this.listeners = new Set();
    this.seq = 0;
  }

  onStatus(listener) {
    this.listeners.add(listener);
    listener({ status: this.status });
    return () => this.listeners.delete(listener);
  }

  emit(status, detail = {}) {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener({ status, ...detail });
      } catch {
        /* слушатель не должен ломать клиента */
      }
    }
  }

  ensureWorker() {
    if (this.worker) return this.worker;

    const url = new URL('./solver-worker.js', import.meta.url);
    const worker = new Worker(url, { name: 'diffur-solver' });
    this.worker = worker;

    worker.onmessage = (event) => this.handleMessage(event.data || {});
    worker.onerror = (event) => this.handleCrash(event?.message || 'Worker завершился с ошибкой.');
    return worker;
  }

  handleCrash(message) {
    this.ready = false;
    this.emit('failed', { message });
    if (this.initReject) {
      this.initReject(new Error(message));
      this.initReject = null;
      this.initResolve = null;
    }
    for (const [, entry] of this.pending) {
      entry.reject(new Error(message));
    }
    this.pending.clear();
    this.terminate();
  }

  handleMessage(message) {
    switch (message.type) {
      case 'progress':
        if (message.id && this.pending.has(message.id)) {
          const entry = this.pending.get(message.id);
          entry.onProgress?.(message);
        } else {
          this.emit('loading', { message: message.message, stage: message.stage });
        }
        break;
      case 'ready':
        this.ready = true;
        this.emit('ready', { python: message.python });
        if (this.initResolve) {
          this.initResolve();
          this.initResolve = null;
          this.initReject = null;
        }
        break;
      case 'init-error': {
        const error = new Error(message.error || 'Не удалось загрузить математический движок.');
        this.emit('failed', { message: error.message });
        if (this.initReject) {
          this.initReject(error);
          this.initReject = null;
          this.initResolve = null;
        }
        this.initPromise = null;
        this.terminate();
        break;
      }
      case 'result': {
        const entry = this.pending.get(message.id);
        if (!entry) break;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message.data);
        break;
      }
      default:
        break;
    }
  }

  init() {
    if (this.ready) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    const worker = this.ensureWorker();
    this.emit('loading', { message: 'Запускаю математический движок…', stage: 'boot' });

    this.initPromise = new Promise((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;

      const timer = setTimeout(() => {
        if (!this.initResolve) return;
        this.initReject = null;
        this.initResolve = null;
        this.initPromise = null;
        this.emit('failed', { message: 'Истекло время ожидания загрузки движка.' });
        this.terminate();
        reject(new Error('Истекло время ожидания загрузки движка. Проверьте интернет-соединение.'));
      }, INIT_TIMEOUT);

      const originalResolve = resolve;
      const originalReject = reject;
      this.initResolve = () => {
        clearTimeout(timer);
        originalResolve();
      };
      this.initReject = (error) => {
        clearTimeout(timer);
        originalReject(error);
      };

      worker.postMessage({ type: 'init' });
    });

    this.initPromise.catch(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  solve(payload, options = {}) {
    const timeout = options.timeout ?? SOLVE_TIMEOUT;
    return this.init().then(() => new Promise((resolve, reject) => {
      const worker = this.ensureWorker();
      const id = `req_${Date.now()}_${this.seq += 1}`;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.terminate();
        reject(new Error('Решение заняло слишком много времени. Попробуйте упростить уравнение.'));
      }, timeout);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        onProgress: options.onProgress,
      });

      worker.postMessage({ type: 'solve', id, payload });
    }));
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.initPromise = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Вычисления были прерваны.'));
    }
    this.pending.clear();
  }
}
