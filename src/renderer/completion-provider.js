/**
 * Monaco inline-completion provider backed by Claude Haiku.
 *
 * Wiring:
 *   import { registerInlineCompletions } from './completion-provider';
 *   const dispose = registerInlineCompletions(monaco, 'latex');
 *   // ... on editor dispose:
 *   dispose();
 *
 * Behaviour:
 *   - Triggers on keystroke via Monaco's inline-completions pipeline.
 *   - Debounces 300ms per-request (fast typists don't send 10 calls/sec).
 *   - Uses Monaco's CancellationToken so stale completions are dropped.
 *   - Sends requestId alongside each IPC so the main process can abort the
 *     in-flight Claude API call when a newer request arrives.
 *   - Skips very short prefixes (< 2 non-whitespace chars) to avoid chatty
 *     completions while the user is still starting a word.
 *
 * UX:
 *   - Monaco renders the returned string as ghost text.
 *   - Tab accepts (default Monaco behaviour); Esc dismisses.
 *   - Triggering on the "Automatic" trigger kind only — no explicit invoke.
 *     (If we want a manual-invoke hotkey later, we can map it to an action.)
 */

const PREFIX_CHARS = 500;
const SUFFIX_CHARS = 200;
const DEBOUNCE_MS = 300;
const MIN_PREFIX_LEN = 2;

let requestCounter = 0;

/**
 * @param {any} monaco — the Monaco namespace object
 * @param {string} languageId — e.g. 'latex'
 * @returns {() => void} dispose fn to unregister the provider
 */
export function registerInlineCompletions(monaco, languageId = 'latex') {
  if (!monaco?.languages?.registerInlineCompletionsProvider) {
    console.warn('[Completion] Monaco lacks inline-completions API — skipping');
    return () => {};
  }

  // Shared state across calls so we can supersede a pending debounce with
  // the latest keystroke.
  let pendingTimer = null;
  let pendingRequestId = null;

  const cancelPending = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pendingRequestId) {
      // Fire-and-forget cancel; main-side abort is idempotent.
      try { window.api?.completion?.cancel?.(pendingRequestId); } catch {}
      pendingRequestId = null;
    }
  };

  const disposable = monaco.languages.registerInlineCompletionsProvider(languageId, {
    async provideInlineCompletions(model, position, context, token) {
      if (!window.api?.completion?.request) return { items: [] };

      // Only react to implicit (automatic) triggers — not explicit user-invoked
      // inline completion actions. Adjust if we add a keyboard shortcut later.
      // `context.triggerKind` is 0 (Automatic) or 1 (Explicit) per Monaco.
      if (context.triggerKind !== 0 && context.triggerKind !== undefined) {
        // Still proceed for explicit triggers — they expect a result
      }

      // Read prefix/suffix from the model directly so we don't serialise the
      // entire doc into our context by accident.
      const prefixRange = new monaco.Range(
        Math.max(1, position.lineNumber - 200), 1,
        position.lineNumber, position.column,
      );
      const suffixRange = new monaco.Range(
        position.lineNumber, position.column,
        Math.min(model.getLineCount(), position.lineNumber + 200),
        model.getLineMaxColumn(Math.min(model.getLineCount(), position.lineNumber + 200)),
      );
      let prefix = model.getValueInRange(prefixRange) || '';
      let suffix = model.getValueInRange(suffixRange) || '';
      if (prefix.length > PREFIX_CHARS) prefix = prefix.slice(-PREFIX_CHARS);
      if (suffix.length > SUFFIX_CHARS) suffix = suffix.slice(0, SUFFIX_CHARS);

      // Skip if there's basically no prefix — avoid showing ghost text before
      // the user has started typing anything meaningful.
      if (prefix.replace(/\s+/g, '').length < MIN_PREFIX_LEN) return { items: [] };

      cancelPending();

      const requestId = `c${++requestCounter}`;
      pendingRequestId = requestId;

      // Debounce: if a new call comes in within DEBOUNCE_MS, this timer is
      // cleared and replaced. On token cancellation (Monaco supersedes us),
      // we also cancel the pending timer and fire the IPC cancel.
      const result = await new Promise((resolve) => {
        pendingTimer = setTimeout(async () => {
          if (token.isCancellationRequested) {
            resolve(null);
            return;
          }
          try {
            const resp = await window.api.completion.request({
              prefix, suffix, requestId,
            });
            if (token.isCancellationRequested) { resolve(null); return; }
            if (!resp || resp.error || !resp.completion) { resolve(null); return; }
            resolve(resp.completion);
          } catch (err) {
            console.warn('[Completion] request failed:', err?.message);
            resolve(null);
          }
        }, DEBOUNCE_MS);

        token.onCancellationRequested(() => {
          cancelPending();
          resolve(null);
        });
      });

      if (pendingRequestId === requestId) pendingRequestId = null;
      if (!result) return { items: [] };

      return {
        items: [{
          insertText: result,
          range: new monaco.Range(
            position.lineNumber, position.column,
            position.lineNumber, position.column,
          ),
        }],
      };
    },

    // Monaco calls freeInlineCompletions to let us clean up any per-request
    // state. We don't stash anything on the result, but the hook is required.
    freeInlineCompletions() {},
  });

  return () => {
    cancelPending();
    try { disposable?.dispose?.(); } catch {}
  };
}
