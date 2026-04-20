/**
 * LlmProvider
 *
 * Thin abstraction layer over LLM completion APIs.
 * Currently only Claude (via @anthropic-ai/sdk) is implemented.
 * Adding OpenAI / Gemini / local models requires only a new subclass
 * that implements `complete(messages, options)`.
 *
 * Interface:
 *   provider.complete(messages, options) → Promise<string>
 *
 * messages: [{ role: 'system'|'user'|'assistant', content: string }]
 * options:  { signal?, maxTokens?, temperature?, onToken? }
 *           onToken: (chunk: string) => void — streaming callback
 *
 * Cancelled calls (via AbortSignal) reject with err.code === 'FERMAT_CANCELLED'.
 */

// ── Model registry ────────────────────────────────────────────────────────────

/** Canonical Anthropic model IDs for the current generation. */
const CLAUDE_MODELS = {
  'claude-opus-4-7':           'claude-opus-4-7',
  'claude-sonnet-4-6':         'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
};

/** Short aliases accepted in Fermat settings UI. */
const CLAUDE_MODEL_ALIASES = {
  'opus':   'claude-opus-4-7',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5-20251001',
};

/**
 * Resolve a model name, alias, or raw ID to its canonical Anthropic model ID.
 * Unknown values are passed through so future models work without code changes.
 */
function resolveModelId(nameOrId) {
  if (!nameOrId) return 'claude-sonnet-4-6';
  return CLAUDE_MODEL_ALIASES[nameOrId] || CLAUDE_MODELS[nameOrId] || nameOrId;
}

// ── Base class ────────────────────────────────────────────────────────────────

class LlmProvider {
  /**
   * Complete a conversation and return the full assistant text.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {object}        [options]
   * @param {AbortSignal}   [options.signal]      cancel the in-flight request
   * @param {number}        [options.maxTokens]   default: 4096
   * @param {number}        [options.temperature] 0.0–1.0
   * @param {function}      [options.onToken]     streaming chunk callback
   * @returns {Promise<string>}
   */
  // eslint-disable-next-line no-unused-vars
  async complete(messages, options = {}) {
    throw new Error(`${this.constructor.name}.complete() is not implemented`);
  }
}

// ── Claude (Anthropic SDK) ────────────────────────────────────────────────────

class ClaudeProvider extends LlmProvider {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey  Anthropic API key
   * @param {string} [opts.model] model ID or alias (default: claude-sonnet-4-6)
   */
  constructor({ apiKey, model } = {}) {
    super();
    this.apiKey = apiKey || '';
    this.model  = resolveModelId(model);
  }

  async complete(messages, options = {}) {
    const { signal, maxTokens = 4096, temperature, onToken } = options;

    if (signal?.aborted) {
      const err = new Error('Cancelled before LLM call');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

    // Lazy-require so the module loads even when the SDK isn't installed
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });

    // Anthropic treats the system message as a top-level field, not a message
    const systemMsg   = messages.find(m => m.role === 'system');
    const convMsgs    = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    const params = {
      model:      this.model,
      max_tokens: maxTokens,
      messages:   convMsgs,
    };
    if (systemMsg)             params.system      = systemMsg.content;
    if (temperature !== undefined) params.temperature = temperature;

    const stream = await client.messages.stream(params, signal ? { signal } : undefined);

    let text = '';
    try {
      for await (const ev of stream) {
        if (signal?.aborted) {
          try { stream.controller?.abort?.(); } catch {}
          const err = new Error('Cancelled mid-stream');
          err.code = 'FERMAT_CANCELLED';
          throw err;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.text) {
          text += ev.delta.text;
          if (onToken) onToken(ev.delta.text);
        }
      }
    } catch (err) {
      if (signal?.aborted || err.code === 'FERMAT_CANCELLED') {
        const abortErr = new Error('Cancelled');
        abortErr.code = 'FERMAT_CANCELLED';
        throw abortErr;
      }
      throw err;
    }

    return text;
  }
}

module.exports = { LlmProvider, ClaudeProvider, CLAUDE_MODELS, CLAUDE_MODEL_ALIASES, resolveModelId };
