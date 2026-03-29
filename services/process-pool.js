/**
 * Process Pool — Fixed pool of long-lived child processes
 *
 * Instead of fork()‑ing a new process per upload (expensive: ONNX model reload,
 * V8 heap duplication), we pre-fork N workers at startup. Each worker loads the
 * ONNX model once and stays alive to handle many uploads sequentially.
 *
 * Benefits:
 *   - Fixed memory footprint (N workers, not N × uploads)
 *   - ONNX model loaded once per worker (not once per upload)
 *   - Bounded concurrency — excess work is queued, not spawned
 *   - Crash recovery — dead workers get auto-respawned
 *
 * Why processes and not worker_threads:
 *   @xenova/transformers ONNX native bindings crash the main process
 *   when a worker thread exits. fork() gives full process isolation.
 */

const { fork } = require("child_process");
const path = require("path");
const os = require("os");

const WORKER_SCRIPT = path.join(__dirname, "process-worker.js");

class ProcessPool {
  /**
   * @param {object} opts
   * @param {number}   opts.size          - Number of workers (default: CPU cores - 1, min 1)
   * @param {function} opts.onMessage     - Called with (msg) for every IPC message from a worker
   */
  constructor({ size, onMessage } = {}) {
    // Cap at 4 workers — document processing is I/O-heavy (Qdrant HTTP, file reads),
    // not CPU-heavy enough to justify 15 workers on a 16-core machine.
    this.size = Math.max(1, Math.min(size || Math.min(os.cpus().length - 1, 4), 4));
    this.onMessage = onMessage || (() => {});

    /** @type {Set<import('child_process').ChildProcess>} idle workers ready for work */
    this.idle = new Set();
    /** @type {Set<import('child_process').ChildProcess>} workers currently running a job */
    this.busy = new Set();
    /** @type {Array<{ job: object, resolve: Function, reject: Function }>} */
    this.queue = [];

    this._spawning = false;
    this._shutdown = false;
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /**
   * Spin up all workers. Call once at server start.
   */
  start() {
    console.log(`[Pool] Starting ${this.size} worker(s)…`);
    for (let i = 0; i < this.size; i++) {
      this._spawnWorker();
    }
  }

  /**
   * Gracefully kill all workers. Call on server shutdown.
   */
  async shutdown() {
    this._shutdown = true;
    const all = [...this.idle, ...this.busy];
    for (const w of all) {
      w.kill("SIGTERM");
    }
    this.idle.clear();
    this.busy.clear();
    // Reject any queued work
    for (const { reject } of this.queue) {
      reject(new Error("Pool shutting down"));
    }
    this.queue = [];
    console.log("[Pool] All workers terminated");
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Submit a job to the pool. Returns a promise that resolves when the
   * worker finishes the job (sends { type: 'done' }).
   *
   * @param {object} job - The message sent to the worker (must have type: 'start')
   * @returns {Promise<void>}
   */
  run(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this._dispatch();
    });
  }

  /**
   * How many jobs are waiting in the queue.
   */
  get pending() {
    return this.queue.length;
  }

  /**
   * How many workers are currently processing a job.
   */
  get activeCount() {
    return this.busy.size;
  }

  // ─── Internal ────────────────────────────────────────────────

  _spawnWorker() {
    if (this._shutdown) return;

    const child = fork(WORKER_SCRIPT, [], {
      // silent: false — inherit stdio so console.error from workers is visible
      stdio: ["pipe", "inherit", "inherit", "ipc"],
    });

    child.on("message", (msg) => {
      // Forward every IPC message to the pool consumer (app.js)
      this.onMessage(msg);

      // Job finished — return worker to idle pool
      if (msg.type === "done" || msg.type === "error") {
        this.busy.delete(child);
        this.idle.add(child);
        // Resolve/reject the promise for this job
        if (child._poolResolve) {
          if (msg.type === "error") {
            child._poolReject(new Error(msg.error));
          } else {
            child._poolResolve();
          }
          child._poolResolve = null;
          child._poolReject = null;
        }
        this._dispatch(); // pick up next queued job
      }
    });

    child.on("error", (err) => {
      console.error("[Pool] Worker error:", err.message);
    });

    child.on("exit", (code, signal) => {
      console.warn(`[Pool] Worker PID ${child.pid} exited (code ${code}, signal ${signal})`);
      this.idle.delete(child);
      this.busy.delete(child);

      // If the worker died while busy, reject its promise
      if (child._poolReject) {
        child._poolReject(new Error(`Worker exited with code ${code}`));
        child._poolResolve = null;
        child._poolReject = null;
      }

      // Auto-respawn unless we're shutting down.
      // On Windows, Ctrl+C sends SIGINT to the entire process group —
      // children die before our SIGINT handler sets _shutdown = true.
      // So also skip respawn if the child was killed by a signal.
      if (!this._shutdown && !signal) {
        console.log("[Pool] Respawning replacement worker…");
        this._spawnWorker();
      }
    });

    this.idle.add(child);
    this._dispatch(); // immediately check if there's queued work
  }

  _dispatch() {
    while (this.queue.length > 0 && this.idle.size > 0) {
      const { job, resolve, reject } = this.queue.shift();
      const worker = this.idle.values().next().value;
      this.idle.delete(worker);
      this.busy.add(worker);

      // Attach promise handlers so we can resolve when done
      worker._poolResolve = resolve;
      worker._poolReject = reject;

      worker.send(job);
    }
  }
}

module.exports = ProcessPool;
