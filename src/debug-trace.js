/**
 * Foldnex - Development trace
 * Records phase timings for a grouping run when the extension is loaded
 * unpacked. Store installs never trace. Events hold phase names, timings, and
 * counts only; titles, URLs, prompts, and responses are never recorded.
 */

const TRACE_KEY = 'foldnex_debug_trace';
let enabledPromise = null;

function isTraceEnabled() {
  enabledPromise ||= (async () => {
    try {
      const self = await globalThis.chrome?.management?.getSelf?.();
      return self?.installType === 'development';
    } catch {
      return false;
    }
  })();
  return enabledPromise;
}

export function createTrace(meta = {}) {
  const startedAt = performance.now();
  const record = {
    ...meta,
    context: typeof window !== 'undefined' ? 'page' : 'worker',
    startedAt: Date.now(),
    events: []
  };

  return {
    mark(phase, data = {}) {
      const event = { phase, ms: Math.round(performance.now() - startedAt), ...data };
      record.events.push(event);
      isTraceEnabled().then(enabled => {
        if (!enabled) return;
        console.log(`[Foldnex debug] +${event.ms}ms ${phase}`, data);
        return chrome.storage.local.set({ [meta.kind ? `${TRACE_KEY}_${meta.kind}` : TRACE_KEY]: record });
      }).catch(() => {});
    },
    elapsed() {
      return Math.round(performance.now() - startedAt);
    }
  };
}

export const noopTrace = Object.freeze({ mark() {}, elapsed() { return 0; } });
