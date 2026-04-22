/**
 * Daemon-wide tracker for in-flight child processes (Claude CLI, bash steps,
 * orchestrator subprocesses). Used by the graceful-shutdown path to SIGTERM
 * + wait + SIGKILL stragglers on SIGINT/SIGTERM.
 *
 * Every spawn site in the daemon should register the child and unregister
 * on close. Untracked children will be orphaned on shutdown.
 */

const children = new Map(); // jobId -> Set<ChildProcess>

export function registerChild(jobId, proc) {
  if (!jobId || !proc) return;
  let set = children.get(jobId);
  if (!set) {
    set = new Set();
    children.set(jobId, set);
  }
  set.add(proc);
}

export function unregisterChild(jobId, proc) {
  if (!jobId || !proc) return;
  const set = children.get(jobId);
  if (!set) return;
  set.delete(proc);
  if (set.size === 0) children.delete(jobId);
}

export function getTrackedJobIds() {
  return Array.from(children.keys());
}

export function getChildCount() {
  let n = 0;
  for (const s of children.values()) n += s.size;
  return n;
}

/**
 * Send a signal to every tracked child. Returns the count of signaled procs.
 */
export function signalAllChildren(signal = 'SIGTERM') {
  let n = 0;
  for (const set of children.values()) {
    for (const proc of set) {
      try {
        proc.kill(signal);
        n += 1;
      } catch {
        // child may have already exited
      }
    }
  }
  return n;
}

/**
 * Resolve once all tracked children have exited, or after timeoutMs.
 * Returns true if all exited, false on timeout.
 */
export function waitForAllChildrenToExit(timeoutMs) {
  if (getChildCount() === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (getChildCount() === 0) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(true);
      }
    }, 200);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve(false);
    }, timeoutMs);
  });
}

/**
 * Force-kill every tracked child with SIGKILL. Used as the final step after
 * the graceful window elapses.
 */
export function killAllChildren() {
  return signalAllChildren('SIGKILL');
}
