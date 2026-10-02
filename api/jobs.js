import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * Long-running background work (installs) with progress, logs and
 * cancellation. Emits 'update' with the public job object on every change.
 */
export class JobManager extends EventEmitter {
  #jobs = new Map();

  list() {
    return [...this.#jobs.values()].map((j) => j.public).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.#jobs.get(id)?.public ?? null;
  }

  findActive(key) {
    return [...this.#jobs.values()].find((j) => j.key === key && j.public.status === 'running')?.public ?? null;
  }

  /** Start `runner({signal, phase, progress, log})` as a job. */
  start({ type, title, key, meta = {} }, runner) {
    const controller = new AbortController();
    const job = {
      key,
      controller,
      public: {
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
      },
    };
    this.#jobs.set(job.public.id, job);
    const pub = job.public;
    const changed = () => this.emit('update', pub);

    const ctx = {
      signal: controller.signal,
      phase: (phase, detail = '') => {
        pub.phase = phase;
        pub.detail = detail;
        if (phase !== 'download') pub.progress = null;
        changed();
      },
      progress: (p) => {
        pub.progress = p;
        changed();
      },
      log: (msg) => {
        pub.logs.push({ at: new Date().toISOString(), msg });
        if (pub.logs.length > 200) pub.logs.shift();
        changed();
      },
    };

    changed();
    Promise.resolve()
      .then(() => runner(ctx))
      .then(
        (result) => {
          pub.status = 'done';
          pub.result = result ?? null;
        },
        (err) => {
          pub.status = controller.signal.aborted ? 'cancelled' : 'error';
          pub.error = err?.message ?? String(err);
        },
      )
      .finally(() => {
        pub.finishedAt = new Date().toISOString();
        changed();
      });
    return pub;
  }

  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job || job.public.status !== 'running') return false;
    job.controller.abort();
    return true;
  }

  dismiss(id) {
    const job = this.#jobs.get(id);
    if (!job || job.public.status === 'running') return false;
    this.#jobs.delete(id);
    this.emit('removed', id);
    return true;
  }
}
