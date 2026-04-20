// Tests for src/main/copilot-engine.js
// Covers: queue + concurrency, submitProofRequest, cancelProof, configure
// validation (NaN clamp), updateContent.
//
// Strategy: rather than mocking the Claude/Lean dependencies at the module
// level (vi.mock has CJS-interop quirks in this workspace), we construct a
// real FermatEngine and then monkey-patch `engine.backend` and
// `engine.leanRunner` to lightweight stubs. This is the same engine the app
// uses in production — we just swap its collaborators.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FermatEngine } from '../copilot-engine.js';

/** A stub backend whose `prove` returns a controllable pending promise. */
function makeStubBackend() {
  const state = { calls: [], pending: [] };
  return {
    calls: state.calls,
    async prove(content, marker, options) {
      state.calls.push({ content, marker, options });
      return new Promise((resolve, reject) => {
        state.pending.push({ resolve, reject });
      });
    },
    resolveLast(value) {
      const p = state.pending.pop();
      if (p) p.resolve(value);
    },
    rejectLast(err) {
      const p = state.pending.pop();
      if (p) p.reject(err);
    },
  };
}

/** A stub LeanRunner that does nothing expensive. */
function makeStubLeanRunner() {
  return {
    detect() { return Promise.resolve({ available: false, path: null, version: null }); },
    setUsesMathlib() {},
    get isAvailable()  { return false; },
    get binaryPath()   { return null; },
    get mathlibReady() { return false; },
  };
}

/** Build an engine with stubbed collaborators. */
function makeEngine() {
  const engine = new FermatEngine();
  engine.backend = makeStubBackend();
  engine.leanRunner = makeStubLeanRunner();
  return engine;
}

function mockMarker(label = 'thm:x', difficulty = 'Medium') {
  return {
    id: `marker_${label}`,
    label,
    difficulty,
    lineNumber: 10,
    fullContent: 'some document content',
  };
}

beforeEach(() => {
  // Silence console.log noise
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('FermatEngine — submitProofRequest', () => {
  it('assigns a taskId and returns queued/running status', () => {
    const engine = makeEngine();
    engine.updateContent('irrelevant');
    const res = engine.submitProofRequest(mockMarker());
    expect(typeof res.taskId).toBe('string');
    expect(res.taskId.length).toBeGreaterThan(8);
    expect(['queued', 'running']).toContain(res.status);
  });

  it('pushes task into tasks map under its taskId', () => {
    const engine = makeEngine();
    engine.updateContent('c');
    const { taskId } = engine.submitProofRequest(mockMarker('thm:a'));
    expect(engine.tasks.has(taskId)).toBe(true);
    expect(engine.tasks.get(taskId).marker.label).toBe('thm:a');
  });
});

describe('FermatEngine — cancelProof', () => {
  it('returns false for an unknown taskId', () => {
    const engine = makeEngine();
    expect(engine.cancelProof('does-not-exist')).toBe(false);
  });

  it('marks a known task cancelled, aborts its signal, and removes it from the map', () => {
    const engine = makeEngine();
    engine.updateContent('c');
    const { taskId } = engine.submitProofRequest(mockMarker());
    const task = engine.tasks.get(taskId);
    const signal = task.abortController.signal;

    expect(engine.cancelProof(taskId)).toBe(true);
    expect(signal.aborted).toBe(true);
    // B-09: cancelled tasks are spliced out of tasks and queue
    expect(engine.tasks.has(taskId)).toBe(false);
    expect(engine.queue.includes(task)).toBe(false);
  });
});

describe('FermatEngine — configure', () => {
  it('merges fields from config into this.config', () => {
    const engine = makeEngine();
    engine.configure({ verificationMode: 'off', maxConcurrent: 2 });
    expect(engine.config.verificationMode).toBe('off');
    expect(engine.config.maxConcurrent).toBe(2);
  });

  it('B-11: clamps NaN maxConcurrent to 1 instead of storing it', () => {
    const engine = makeEngine();
    engine.configure({ maxConcurrent: NaN });
    expect(engine.config.maxConcurrent).toBe(1);
  });

  it('B-11: clamps negative/zero maxConcurrent to 1', () => {
    const engine = makeEngine();
    engine.configure({ maxConcurrent: 0 });
    expect(engine.config.maxConcurrent).toBe(1);
    engine.configure({ maxConcurrent: -5 });
    expect(engine.config.maxConcurrent).toBe(1);
  });

  it('B-11: replaces NaN lean.maxRetries with default 3', () => {
    const engine = makeEngine();
    engine.configure({ lean: { maxRetries: NaN, binaryPath: '' } });
    expect(engine.config.lean.maxRetries).toBe(3);
  });
});

describe('FermatEngine — updateContent', () => {
  it('stores the latest content for later context assembly', () => {
    const engine = makeEngine();
    engine.updateContent('doc v1');
    expect(engine._latestContent).toBe('doc v1');
    engine.updateContent('doc v2');
    expect(engine._latestContent).toBe('doc v2');
  });
});

describe('FermatEngine — concurrency limit', () => {
  it('runs at most maxConcurrent tasks simultaneously', async () => {
    const engine = makeEngine();
    engine.configure({ maxConcurrent: 2, models: { claude: { apiKey: 'k', model: 'm' } } });
    engine.updateContent('doc');
    engine.submitProofRequest(mockMarker('t1'));
    engine.submitProofRequest(mockMarker('t2'));
    engine.submitProofRequest(mockMarker('t3'));

    // Flush microtasks so _executeProof reaches its first await.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(engine.running).toBe(2);
    expect(engine.queue.length).toBe(1);
    // Each in-flight task got its backend.prove invoked once.
    expect(engine.backend.calls.length).toBe(2);
  });

  it('starts the queued task after one in-flight completes', async () => {
    const engine = makeEngine();
    engine.configure({ maxConcurrent: 1, models: { claude: { apiKey: 'k', model: 'm' } } });
    engine.updateContent('doc');
    engine.submitProofRequest(mockMarker('a'));
    engine.submitProofRequest(mockMarker('b'));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(engine.running).toBe(1);
    expect(engine.queue.length).toBe(1);

    // Resolve the first prove so the slot frees up.
    engine.backend.resolveLast({
      proof: '\\begin{proof}QED.\\end{proof}',
      sketch: null,
      verdict: null,
    });

    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(engine.queue.length).toBe(0);
    // Two prove calls total now — one for 'a' (resolved) and one for 'b' (pending).
    expect(engine.backend.calls.length).toBe(2);
  });
});
