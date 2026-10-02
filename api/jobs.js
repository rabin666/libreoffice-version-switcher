// Background jobs (installs) with progress, logs and cancellation. Emits
// 'update' with the job's public state on every change, and 'removed'.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const MAX_LOG_LINES = 200;

export class JobManager extends EventEmitter {
  // id -> {key, controller, state}; only `state` is ever sent to clients.
  #jobs = new Map();

  list() {
    return [...this.#jobs.values()].map((job) => job.state).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.#jobs.get(id)?.state ?? null;
  }

  /** The running job registered under `key`, if any (used to de-duplicate requests). */
  findActive(key) {
    return [...this.#jobs.values()].find((job) => job.key === key && job.state.status === 'running')?.state ?? null;
  }

  /** Run `task({signal, phase, progress, log})` as a job; returns its state immediately. */
  start({ type, title, key, meta = {} }, task) {
    const controller = new AbortController();
    const state = {
      id: crypto.randomUUID(),
      type,
      title,
      meta,
      status: 'running',
      phase: 'starting',
      detail: '',
      progress: null,
      logs: [],
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.#jobs.set(state.id, { key, controller, state });
    const publish = () => this.emit('update', state);

    const context = {
      signal: controller.signal,
      phase: (phase, detail = '') => {
        state.phase = phase;
        state.detail = detail;
        if (phase !== 'download') state.progress = null;
        publish();
      },
      progress: (progress) => {
        state.progress = progress;
        publish();
      },
      log: (message) => {
        state.logs.push({ at: new Date().toISOString(), msg: message });
        if (state.logs.length > MAX_LOG_LINES) state.logs.shift();
        publish();
      },
    };

    publish();
    Promise.resolve()
      .then(() => task(context))
      .then(
        (result) => {
          state.status = 'done';
          state.result = result ?? null;
        },
        (err) => {
          state.status = controller.signal.aborted ? 'cancelled' : 'error';
          state.error = err?.message ?? String(err);
        },
      )
      .finally(() => {
        state.finishedAt = new Date().toISOString();
        publish();
      });
    return state;
  }

  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job || job.state.status !== 'running') return false;
    job.controller.abort();
    return true;
  }

  /** Forget a finished job. */
  dismiss(id) {
    const job = this.#jobs.get(id);
    if (!job || job.state.status === 'running') return false;
    this.#jobs.delete(id);
    this.emit('removed', id);
    return true;
  }
}
