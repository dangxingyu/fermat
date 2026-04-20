/**
 * Inline-completion backend — powers the Cursor-style ghost-text autocomplete
 * in the Monaco editor.
 *
 * Prompt strategy: Claude doesn't have native fill-in-the-middle tokens, so we
 * ask the model to emit only the text that should appear at the cursor, given
 * a `<prefix>` + `<suffix>` context. Haiku 4.5 is fast enough (~300-700ms) to
 * feel responsive after the renderer-side 300ms debounce.
 *
 * Cancellation: each request is tracked by a requestId; the renderer fires a
 * `completion:cancel` IPC when the user keeps typing, which aborts the
 * in-flight Anthropic SDK stream.
 */

const SYSTEM_PROMPT = `You are a LaTeX autocomplete assistant for a mathematical proof document. Given the text before the cursor (<prefix>) and after the cursor (<suffix>), emit the text that should appear AT the cursor position.

STRICT RULES:
- Output ONLY the completion. No explanations, no code fences, no quotes, no XML tags.
- Do NOT repeat any of the prefix or suffix in your output.
- Keep completions short — typically a few words to one line. Never more than 3 lines.
- Stop at natural boundaries: end of sentence, end of line, closing brace, \\end{}.
- Match the style of the surrounding text (math-mode, prose, comment, etc.).
- Preserve LaTeX validity — balanced braces, proper \\command{arg} form.
- If the context is unclear or nothing useful to add, output an empty string.
- NEVER output "<prefix>", "<suffix>", or any reasoning about what you're doing.`;

class CompletionBackend {
  constructor() {
    /** @type {Map<string, AbortController>} */
    this._inflight = new Map();
  }

  /**
   * Complete at a cursor position.
   * @param {{prefix:string, suffix:string, requestId?:string, apiKey:string, model?:string}} opts
   * @returns {Promise<{completion:string}|{error:string,code?:string}>}
   */
  async complete({ prefix, suffix, requestId, apiKey, model }) {
    if (!apiKey) return { error: 'No Claude API key configured', code: 'NO_API_KEY' };
    if (typeof prefix !== 'string' || typeof suffix !== 'string') {
      return { error: 'prefix and suffix must be strings' };
    }
    // Skip if there's essentially no context — avoids wasting tokens
    if (prefix.trim().length === 0 && suffix.trim().length === 0) {
      return { completion: '' };
    }

    const ac = new AbortController();
    if (requestId) {
      // Cancel any previous in-flight request with this id (defensive —
      // normally the renderer sends completion:cancel for stale requests)
      const prev = this._inflight.get(requestId);
      if (prev) { try { prev.abort(); } catch {} }
      this._inflight.set(requestId, ac);
    }

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      // Haiku is the right call here: FIM completions need to be fast;
      // Sonnet feels laggy by the time a user is halfway through a word.
      const modelId = model || 'claude-haiku-4-5-20251001';

      // Keep prompt tight — Haiku is cheap but tokens add up if the user
      // types rapidly. 500ch prefix + 200ch suffix is enough signal for LaTeX.
      const clamp = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(-n) : s);
      const clipStart = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
      const promptPrefix = clamp(prefix, 500);
      const promptSuffix = clipStart(suffix, 200);

      const userContent = `<prefix>${promptPrefix}</prefix>\n<suffix>${promptSuffix}</suffix>`;

      const resp = await client.messages.create(
        {
          model: modelId,
          max_tokens: 180,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
          // Stop sequences: keep us from spilling into the suffix
          stop_sequences: ['</completion>', '<prefix>', '<suffix>'],
        },
        { signal: ac.signal },
      );

      // Anthropic returns an array of content blocks; concatenate text only.
      let text = '';
      for (const block of resp.content || []) {
        if (block.type === 'text' && block.text) text += block.text;
      }

      // Strip common model quirks: leading code fences, stray tags.
      text = text
        .replace(/^```[a-zA-Z]*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .replace(/^<completion>/, '')
        .replace(/<\/completion>$/, '');

      // Defensive: if the model echoed the prefix tail, strip it.
      const prefixTail = promptPrefix.slice(-Math.min(40, promptPrefix.length));
      if (prefixTail && text.startsWith(prefixTail)) {
        text = text.slice(prefixTail.length);
      }

      return { completion: text };
    } catch (err) {
      if (err?.name === 'AbortError' || ac.signal.aborted) {
        return { completion: '', aborted: true };
      }
      console.warn('[Completion] error:', err?.message || err);
      return { error: err?.message || String(err), code: err?.status ? `HTTP_${err.status}` : 'ERROR' };
    } finally {
      if (requestId && this._inflight.get(requestId) === ac) {
        this._inflight.delete(requestId);
      }
    }
  }

  /** Cancel a specific in-flight request by id. */
  cancel(requestId) {
    const ac = this._inflight.get(requestId);
    if (!ac) return false;
    try { ac.abort(); } catch {}
    this._inflight.delete(requestId);
    return true;
  }

  /** Abort every in-flight completion (e.g. on window close). */
  cancelAll() {
    for (const [, ac] of this._inflight) {
      try { ac.abort(); } catch {}
    }
    this._inflight.clear();
  }
}

module.exports = { CompletionBackend };
