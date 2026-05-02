const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ContextAssembler } = require('./context-assembler');
const { parseTheoryOutline } = require('./outline-parser');
const { ClaudeProvider, resolveModelId } = require('./llm-provider');
const {
  buildOutlineAuditPrompt,
  documentHash,
  extractJsonObject,
  loadOutlineAudit,
  normalizeOutlineAudit,
  saveOutlineAudit,
} = require('./outline-audit');
const {
  appendProofRunEvent,
  buildSchedulerDecision,
  createProofRun,
  formatSchedulerDecisionForPrompt,
  persistProofRunArtifacts,
} = require('./proof-run');

/**
 * Classify an API/network error into a structured { code, userMessage } pair
 * so the renderer can show a helpful, actionable toast instead of a raw stack.
 */
function classifyAndAnnotateError(err) {
  const status = err.status || err.statusCode;
  const msg = (err.message || '').toLowerCase();

  let code, userMessage;

  if (status === 401 || msg.includes('invalid x-api-key') || msg.includes('authentication')) {
    code = 'AUTH_ERROR';
    userMessage = 'Invalid API key. Open Settings and check your Anthropic key.';
  } else if (status === 402 || msg.includes('credit') || msg.includes('billing') || msg.includes('quota')) {
    code = 'QUOTA_EXCEEDED';
    userMessage = 'Anthropic account quota exceeded. Check your billing at console.anthropic.com.';
  } else if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    code = 'RATE_LIMIT';
    userMessage = 'Rate limit hit. Wait a moment, then try again.';
  } else if (status === 500 || status === 502 || status === 503 || status === 529) {
    code = 'API_UNAVAILABLE';
    userMessage = 'Anthropic API is temporarily unavailable. Try again in a minute.';
  } else if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch failed')) {
    code = 'NETWORK_ERROR';
    userMessage = 'Network error — check your internet connection.';
  } else if (msg.includes('api key') || msg.includes('no api key') || msg.includes('not configured')) {
    code = 'NO_API_KEY';
    userMessage = 'No API key configured. Open Settings and add your Anthropic key.';
  } else {
    code = 'UNKNOWN_ERROR';
    userMessage = `Proof failed: ${err.message}`;
  }

  err.fermatCode = code;
  err.fermatUserMessage = userMessage;
  return err;
}

function normalizeProofEffort(value) {
  const key = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'max'].includes(key) ? key : 'medium';
}

/**
 * ClaudeCodeBackend
 *
 * Uses Claude Code (the CLI agent) as the proving backend for Fermat.
 * Falls back to direct API via ClaudeProvider when the CLI is not available.
 */
class ClaudeCodeBackend {
  constructor() {
    this.contextAssembler = new ContextAssembler();

    const { app } = require('electron');
    if (app && app.isPackaged) {
      this.projectRoot = process.resourcesPath;
    } else {
      this.projectRoot = path.join(__dirname, '../..');
    }
    this.skillsDir = path.join(this.projectRoot, '.claude/skills');
    this._claudePath = null;
    this._hasClaudeCli = false;
    this._detectCli();

    this.workDir = path.join(os.tmpdir(), 'fermat-proving');
    if (!fs.existsSync(this.workDir)) {
      fs.mkdirSync(this.workDir, { recursive: true });
    }

    // Provider abstraction for direct API calls (CLI path bypasses this)
    this._provider = null;

    // Session-scoped verify cache: source-hash → LeanRunner.verify() result
    this._verifyCache = new Map();
  }

  _detectCli() {
    const { execFileSync } = require('child_process');
    try {
      const result = execFileSync('which', ['claude'], {
        timeout: 3000,
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
        },
      });
      this._claudePath = result.toString().trim();
      this._hasClaudeCli = true;
      console.log(`[ClaudeCodeBackend] CLI found: ${this._claudePath}`);
    } catch {
      this._hasClaudeCli = false;
      console.log('[ClaudeCodeBackend] Claude CLI not found — will use direct API fallback');
    }
  }

  get isAvailable() {
    return this._hasClaudeCli;
  }

  /**
   * Get or (re)create the ClaudeProvider for a given apiKey + model pair.
   * Called on every direct-API _callLlm invocation; cheap if nothing changed.
   */
  _getOrUpdateProvider(apiKey, model) {
    const modelId = resolveModelId(model);
    if (!this._provider || this._provider.apiKey !== apiKey || this._provider.model !== modelId) {
      this._provider = new ClaudeProvider({ apiKey, model: modelId });
      console.log(`[ClaudeCodeBackend] Provider: ${modelId} (direct API)`);
    }
    return this._provider;
  }

  /**
   * Execute a proving workflow for a given marker.
   *
   * @param {string} texContent  — full document content
   * @param {object} marker      — { id, effort, label, lineNumber, ... }
   * @param {object} options     — { apiKey, model, skipVerify, onStream, onStatus,
   *                                  verificationMode, leanRunner, maxLeanRetries,
   *                                  onStatementReview, taskId, signal }
   * @returns {object} { proof, verdict?, sketch?, leanCode?, leanVerified?, leanLog?,
   *                     sorries?, leanStatement? }
   */
  async prove(texContent, marker, options = {}) {
    console.log(`[Prove] Starting proof for marker "${marker.label || marker.id}" (line ${marker.lineNumber || '?'})`);
    if (options.signal?.aborted) {
      const err = new Error('Cancelled before start');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

    const outline = parseTheoryOutline(texContent);
    const targetNode = this._findTargetNode(outline, marker);
    if (!targetNode) {
      throw new Error(`Could not find theorem/lemma for marker: ${marker.label}`);
    }

    const knowledgeLedger = this._loadKnowledgeLedger(marker);
    const ctx = this.contextAssembler.assembleForProof(outline, targetNode, { knowledgeLedger });
    const contextPrompt = this.contextAssembler.formatAsPrompt(ctx);

    const effort = normalizeProofEffort(targetNode.proveItMarker?.effort);
    const whichPath = this._hasClaudeCli ? 'Claude CLI' : 'direct API';
    console.log(`[Prove] Target: ${targetNode.type} "${targetNode.name || targetNode.labels?.[0]}" | effort=${effort} | path=${whichPath} | context=${contextPrompt.length}ch | deps=${ctx.directDependencies.length} | ledger=${knowledgeLedger?.path ? 'yes' : 'no'}`);

    if (!this._hasClaudeCli && !options.apiKey) {
      const err = new Error('No API key configured and Claude Code CLI not available.');
      throw classifyAndAnnotateError(err);
    }
    let results = await this._proveThreePhase(contextPrompt, effort, targetNode, { ...options, marker });

    if (options.verificationMode === 'lean' && options.leanRunner?.isAvailable) {
      results = await this._leanSketchFillVerify(results, contextPrompt, targetNode, options);
    }

    return results;
  }

  /**
   * Run a project-level semantic audit for the outline sidebar.
   *
   * This is intentionally separate from proving: it can suggest dependencies
   * and obligations, but it never licenses them as usable proof facts.
   */
  async auditOutline(texContent, options = {}) {
    const {
      filePath = null,
      outline: providedOutline = null,
      apiKey,
      model,
      signal,
      force = false,
    } = options;

    if (signal?.aborted) {
      const err = new Error('Cancelled before outline audit');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

    const outline = providedOutline || parseTheoryOutline(texContent);
    const hash = documentHash(texContent);

    if (filePath && !force) {
      try {
        const cached = loadOutlineAudit({ filePath, texContent, outline });
        if (cached?.documentHash === hash && !cached.isStale) {
          console.log(`[OutlineAudit] Cache hit: ${cached.auditPath}`);
          return { ...cached, skipped: true };
        }
      } catch (err) {
        console.warn(`[OutlineAudit] Ignoring unreadable cached audit: ${err.message}`);
      }
    }

    if (!this._hasClaudeCli && !apiKey) {
      const err = new Error('No API key configured and Claude Code CLI not available.');
      throw classifyAndAnnotateError(err);
    }

    const knowledgeLedger = this._loadKnowledgeLedger({ filePath });
    const prompt = buildOutlineAuditPrompt({
      outline,
      texContent,
      filePath,
      knowledgeLedger,
    });
    const skill = this._loadSkill('fermat-outline-audit');

    console.log(`[OutlineAudit] Auditing ${outline.nodes?.length || 0} outline nodes | hash=${hash}`);
    const raw = await this._callLlm(prompt, null, apiKey, model, skill, signal);
    const parsed = extractJsonObject(raw);
    const audit = normalizeOutlineAudit(parsed, { outline, texContent, filePath });

    let auditPath = null;
    if (filePath) {
      auditPath = saveOutlineAudit(audit, filePath);
      console.log(`[OutlineAudit] Saved: ${auditPath}`);
    }

    return { ...audit, auditPath, skipped: false };
  }

  /**
   * Unified natural-language prove pipeline.
   * Effort levels:
   * low    → direct proof, usually auto-inlined/skips verify by config.
   * medium → knowledge → plan → prove → verify + 1 self-correction.
   * high   → target notebook → parallel drafts → verifier ensemble → repair.
   * max    → long-range staged search with notebook updates between stages.
   *
   */
  async _proveThreePhase(contextPrompt, effort, targetNode, options) {
    const { onStream, apiKey, model, signal } = options;
    effort = normalizeProofEffort(effort);
    const results = {};
    let workingContext = contextPrompt;

    if (effort !== 'low') {
      console.log('[Prove] Phase 1/4: knowledge review (fermat-knowledge skill)');
      const knowledgeSkill = this._loadSkill('fermat-knowledge');
      const tk0 = Date.now();
      results.knowledge = await this._callLlm(contextPrompt, onStream, apiKey, model, knowledgeSkill, signal);
      workingContext += `\n\n${this._asTaggedBlock('knowledge_review', results.knowledge)}`;
      console.log(`[Prove] Knowledge review done (${Date.now() - tk0}ms, ${results.knowledge.length}ch)`);

      console.log('[Prove] Phase 2/4: plan (fermat-sketch skill)');
      const sketchSkill = this._loadSkill('fermat-sketch');
      const t0 = Date.now();
      results.sketch = await this._callLlm(workingContext, onStream, apiKey, model, sketchSkill, signal);
      console.log(`[Prove] Sketch done (${Date.now() - t0}ms, ${results.sketch.length}ch)`);
    }

    if (effort === 'max') {
      return this._proveMaxPipeline(workingContext, results, targetNode, options);
    }

    if (effort === 'high') {
      return this._proveHighPipeline(workingContext, results, targetNode, options);
    }

    console.log(`[Prove] Phase ${effort === 'low' ? '1/1' : '3/4'}: prove (fermat-prove skill)`);
    const proveSkill = this._loadSkill('fermat-prove');
    let proveInput = workingContext;
    const proofPlanBlock = results.sketch
      ? this._asTaggedBlock('proof_plan', results.sketch)
      : '';
    if (results.sketch) {
      proveInput += `\n\n${proofPlanBlock}`;
    }
    const tp0 = Date.now();
    let proofOutput = await this._callLlm(proveInput, onStream, apiKey, model, proveSkill, signal);
    console.log(`[Prove] Proof draft done (${Date.now() - tp0}ms, ${proofOutput.length}ch)`);

    if (!options.skipVerify) {
      console.log(`[Prove] Phase ${effort === 'low' ? 'verify' : '4/4'}: verify (fermat-verify skill)`);
      const verifySkill = this._loadSkill('fermat-verify');
      const verifyInput = `${workingContext}${proofPlanBlock ? `\n\n${proofPlanBlock}` : ''}\n\n<proof_to_verify>\n${proofOutput}\n</proof_to_verify>`;
      const tv0 = Date.now();
      results.verdict = await this._callLlm(verifyInput, onStream, apiKey, model, verifySkill, signal);
      const rawVerdictTag = this._extractVerdictTag(results.verdict);
      results.verdictTag = this._normalizeVerdictForProof(rawVerdictTag, proofOutput);
      if (results.verdictTag !== rawVerdictTag) {
        results.verdict += '\n\n<fermat_guardrail>Verifier PASS was downgraded because the proof is explicitly marked [FERMAT BLOCKED].</fermat_guardrail>';
      }
      console.log(`[Prove] Verdict: ${results.verdictTag} (${Date.now() - tv0}ms)`);

      const needsRetry = results.verdictTag === 'FAIL' || results.verdictTag === 'NEEDS_REVISION';
      if (needsRetry) {
        console.log('[Prove] Verification failed — retrying with feedback');
        const retryInput =
          `${workingContext}${proofPlanBlock ? `\n\n${proofPlanBlock}` : ''}\n\n<previous_attempt>\n${proofOutput}\n</previous_attempt>\n\n` +
          `<verification_feedback>\n${results.verdict}\n</verification_feedback>\n\n` +
          `The previous proof attempt FAILED verification. Please write a corrected proof addressing the issues identified above. Do not use any fact marked prove_inline, prove_as_sublemma, research_before_use, or do_not_use unless this proof first establishes the fact under the target assumptions.`;
        proofOutput = await this._callLlm(retryInput, onStream, apiKey, model, proveSkill, signal);

        const reVerifyInput = `${workingContext}${proofPlanBlock ? `\n\n${proofPlanBlock}` : ''}\n\n<proof_to_verify>\n${proofOutput}\n</proof_to_verify>`;
        results.verdict = await this._callLlm(reVerifyInput, onStream, apiKey, model, verifySkill, signal);
        results.verdictTag = this._normalizeVerdictForProof(this._extractVerdictTag(results.verdict), proofOutput);
        console.log(`[Prove] Re-verify verdict: ${results.verdictTag}`);
      }
    } else {
      console.log('[Prove] Verification skipped');
    }

    results.proof = this._extractProof(proofOutput);
    return results;
  }

  async _proveHighPipeline(workingContext, results, targetNode, options) {
    const { onStream, onStatus, apiKey, model, signal } = options;
    const pipeline = {
      mode: 'high-research',
      attempts: [],
      selectedAttempt: null,
      finalVerdict: null,
    };
    results.proofPipeline = pipeline;

    const emitStatus = (phase, extra = {}) => {
      if (onStatus) onStatus({ phase, ...extra });
      console.log(`[EffortPipeline] ${phase}`, extra);
    };

    emitStatus('high-notebook');
    const notebookSkill = this._loadSkill('fermat-proof-notebook');
    const proofPlanBlock = results.sketch
      ? this._asTaggedBlock('proof_plan', results.sketch)
      : '';
    const notebookInput = `${workingContext}${proofPlanBlock ? `\n\n${proofPlanBlock}` : ''}`;
    const tNotebook = Date.now();
    results.proofNotebook = await this._callLlm(
      notebookInput,
      onStream,
      apiKey,
      model,
      notebookSkill,
      signal,
    );
    pipeline.notebook = results.proofNotebook;
    pipeline.notebookStatus = this._extractTagText(results.proofNotebook, 'status') || 'unknown';
    let attemptContext = `${notebookInput}\n\n${this._asTaggedBlock('proof_notebook', results.proofNotebook)}`;
    console.log(`[EffortPipeline] Notebook done (${Date.now() - tNotebook}ms, ${results.proofNotebook.length}ch)`);

    if (pipeline.notebookStatus.includes('needs_research')) {
      emitStatus('high-research');
      const researchSkill = this._loadSkill('fermat-research');
      const researchInput = `${attemptContext}\n\n<research_task>
The proof notebook says this target needs research. Review only source material already present in the project context, knowledge ledger, bibliography snippets, or full document. Do not invent papers or theorems. If no source-backed fact is available, return open questions and keep the relevant claim under research_before_use.
</research_task>`;
      results.research = await this._callLlm(
        researchInput,
        onStream,
        apiKey,
        model,
        researchSkill,
        signal,
      );
      pipeline.research = results.research;
      attemptContext += `\n\n${this._asTaggedBlock('research_review', results.research)}`;
    }

    const proveSkill = this._loadSkill('fermat-prove');
    const verifySkill = this._loadSkill('fermat-verify');
    const attemptPrompts = [
      {
        role: 'primary',
        instruction: 'Write the cleanest complete proof following the proof plan and proof notebook. Prefer proving short obligations inline.',
      },
      {
        role: 'obligation-first',
        instruction: 'Write an independent proof draft that starts by isolating every nontrivial proof obligation as an internal claim. If an obligation is too large, return a visibly blocked proof.',
      },
    ];

    emitStatus('high-drafting', { attempts: attemptPrompts.length });
    const draftTasks = attemptPrompts.map(async (attempt, index) => {
      const prompt = `${attemptContext}\n\n<proof_attempt_directive role="${attempt.role}">
${attempt.instruction}
Do not cite notebook entries as facts. Use only document-proved/source-backed facts directly; prove candidate obligations inline or mark the proof blocked.
</proof_attempt_directive>`;
      const raw = await this._callLlm(prompt, index === 0 ? onStream : null, apiKey, model, proveSkill, signal);
      return {
        index,
        role: attempt.role,
        raw,
        proof: this._extractProof(raw),
      };
    });
    pipeline.attempts = await Promise.all(draftTasks);

    if (options.skipVerify) {
      pipeline.selectedAttempt = pipeline.attempts[0]?.index ?? null;
      results.proof = pipeline.attempts[0]?.proof || this._blockedProof('High-effort proof pipeline produced no proof attempt.');
      return results;
    }

    emitStatus('high-verifying', { attempts: pipeline.attempts.length });
    for (const attempt of pipeline.attempts) {
      const verifyInput = `${attemptContext}\n\n<proof_to_verify>\n${attempt.raw}\n</proof_to_verify>`;
      attempt.verdict = await this._callLlm(verifyInput, null, apiKey, model, verifySkill, signal);
      attempt.verdictTag = this._normalizeVerdictForProof(this._extractVerdictTag(attempt.verdict), attempt.proof);
      attempt.correctedProof = this._extractCorrectedProof(attempt.verdict);
    }

    const passing = pipeline.attempts.find(a => a.verdictTag === 'PASS');
    if (passing) {
      emitStatus('high-pass', { attempt: passing.index, role: passing.role });
      pipeline.selectedAttempt = passing.index;
      pipeline.finalVerdict = passing.verdict;
      results.verdict = passing.verdict;
      results.proof = passing.proof;
      return results;
    }

    const corrected = pipeline.attempts.find(a => a.correctedProof);
    if (corrected) {
      emitStatus('high-reverify-correction', { attempt: corrected.index, role: corrected.role });
      const reVerifyInput = `${attemptContext}\n\n<proof_to_verify>\n${corrected.correctedProof}\n</proof_to_verify>`;
      const reVerdict = await this._callLlm(reVerifyInput, onStream, apiKey, model, verifySkill, signal);
      const reTag = this._normalizeVerdictForProof(this._extractVerdictTag(reVerdict), corrected.correctedProof);
      pipeline.finalVerdict = reVerdict;
      results.verdict = reVerdict;
      if (reTag === 'PASS' || reTag === 'NEEDS_REVISION') {
        pipeline.selectedAttempt = corrected.index;
        results.proof = corrected.correctedProof;
        return results;
      }
    }

    emitStatus('high-repair');
    const attemptsBlock = this._formatProofAttemptsForPrompt(pipeline.attempts);
    const repairNotebookInput = `${attemptContext}\n\n<proof_attempts>\n${attemptsBlock}\n</proof_attempts>`;
    const repairNotebook = await this._callLlm(
      repairNotebookInput,
      null,
      apiKey,
      model,
      notebookSkill,
      signal,
    );
    pipeline.repairNotebook = repairNotebook;

    const repairInput = `${repairNotebookInput}\n\n${this._asTaggedBlock('proof_notebook', repairNotebook)}\n\n` +
      `The previous high-effort proof attempts failed verification. Write one final corrected proof only if the verifier feedback can be repaired under the fact-use policy. If the proof still needs a separate lemma or source-backed fact, return a visibly blocked proof.`;
    const repairedRaw = await this._callLlm(repairInput, onStream, apiKey, model, proveSkill, signal);
    const repairedProof = this._extractProof(repairedRaw);
    const finalVerifyInput = `${repairNotebookInput}\n\n${this._asTaggedBlock('proof_notebook', repairNotebook)}\n\n<proof_to_verify>\n${repairedRaw}\n</proof_to_verify>`;
    const finalVerdict = await this._callLlm(finalVerifyInput, null, apiKey, model, verifySkill, signal);
    const finalTag = this._normalizeVerdictForProof(this._extractVerdictTag(finalVerdict), repairedProof);
    pipeline.finalVerdict = finalVerdict;
    pipeline.repairedProof = repairedProof;
    results.verdict = finalVerdict;
    if (finalTag === 'PASS' || finalTag === 'NEEDS_REVISION') {
      pipeline.selectedAttempt = 'repair';
      results.proof = repairedProof;
    } else {
      pipeline.selectedAttempt = null;
      results.proof = this._blockedProof(this._summarizeFailedProofPipeline(pipeline.attempts, finalVerdict));
    }
    return results;
  }

  async _proveMaxPipeline(workingContext, results, targetNode, options) {
    const { onStream, onStatus, apiKey, model, signal } = options;
    const width = this._boundedInt(options.maxProofWidth, 3, 2, 5);
    const maxStages = this._boundedInt(options.maxProofStages, 3, 1, 6);
    const long = {
      mode: 'max-long-range',
      runId: this._proofRunId(targetNode),
      width,
      maxStages,
      stages: [],
      attempts: [],
      selectedAttempt: null,
      finalVerdict: null,
    };
    results.proofPipeline = long;
    results.maxPipeline = long;
    const proofRun = createProofRun({
      runId: long.runId,
      target: targetNode,
      config: {
        effort: 'max',
        width,
        maxStages,
        model: model || null,
        skipVerify: !!options.skipVerify,
      },
    });
    results.proofRun = proofRun;

    const emitStatus = (phase, extra = {}) => {
      if (onStatus) onStatus({ phase, ...extra });
      console.log(`[MaxPipeline] ${phase}`, extra);
    };
    const appendRunEvent = (type, payload = {}) => {
      appendProofRunEvent(proofRun, type, payload);
      const paths = this._persistProofRunArtifacts(proofRun, targetNode, options);
      if (paths) {
        long.eventLogPath = paths.runPath;
        long.obligationGraphPath = paths.graphPath;
      }
    };
    const initialPaths = this._persistProofRunArtifacts(proofRun, targetNode, options);
    if (initialPaths) {
      long.eventLogPath = initialPaths.runPath;
      long.obligationGraphPath = initialPaths.graphPath;
    }

    if (results.knowledge) {
      appendRunEvent('knowledge_review.completed', { text: results.knowledge });
    }
    if (results.sketch) {
      appendRunEvent('plan.completed', { text: results.sketch });
    }

    const notebookSkill = this._loadSkill('fermat-proof-notebook');
    const proveSkill = this._loadSkill('fermat-prove');
    const verifySkill = this._loadSkill('fermat-verify');
    const researchSkill = this._loadSkill('fermat-research');
    const proofPlanBlock = results.sketch
      ? this._asTaggedBlock('proof_plan', results.sketch)
      : '';
    const baseInput = `${workingContext}${proofPlanBlock ? `\n\n${proofPlanBlock}` : ''}`;

    emitStatus('max-notebook', { width, maxStages });
    let currentNotebook = await this._callLlm(
      `${baseInput}\n\n<long_range_request effort="max">
Build the initial long-range proof notebook. Prefer precise obligations, discarded routes, and next actions over a confident but unsupported route.
</long_range_request>`,
      onStream,
      apiKey,
      model,
      notebookSkill,
      signal,
    );
    results.proofNotebook = currentNotebook;
    long.notebook = currentNotebook;
    appendRunEvent('notebook.updated', {
      stage: 0,
      text: currentNotebook,
      status: this._extractTagText(currentNotebook, 'status') || 'unknown',
    });
    this._persistProofRunSnapshot(long, targetNode, options);

    for (let stageIndex = 1; stageIndex <= maxStages; stageIndex++) {
      const stage = {
        index: stageIndex,
        notebook: currentNotebook,
        notebookStatus: this._extractTagText(currentNotebook, 'status') || 'unknown',
        attempts: [],
      };
      long.stages.push(stage);

      let stageContext = `${baseInput}\n\n${this._asTaggedBlock('proof_notebook', currentNotebook)}`;
      const preResearchDecision = buildSchedulerDecision(proofRun.obligationGraph, {
        stage: stageIndex,
        width,
      });
      stage.preResearchDecision = preResearchDecision;
      if (stage.notebookStatus.includes('needs_research') || preResearchDecision.focus === 'research') {
        emitStatus('max-research', { stage: stageIndex });
        stage.research = await this._callLlm(
          `${stageContext}\n\n<research_task>
The max-effort notebook or scheduler requests research. Review only source material already present in the project context, knowledge ledger, bibliography snippets, or full document. Do not invent papers or theorems. If the needed source is not present, return open questions and keep the claim under research_before_use.
</research_task>`,
          null,
          apiKey,
          model,
          researchSkill,
          signal,
        );
        stageContext += `\n\n${this._asTaggedBlock('research_review', stage.research)}`;
        long.research = stage.research;
        results.research = stage.research;
        appendRunEvent('research.completed', {
          stage: stageIndex,
          text: stage.research,
        });
      }

      const schedulerDecision = buildSchedulerDecision(proofRun.obligationGraph, {
        stage: stageIndex,
        width,
      });
      stage.schedulerDecision = schedulerDecision;
      stageContext += `\n\n${formatSchedulerDecisionForPrompt(schedulerDecision)}`;
      appendRunEvent('scheduler.decision', {
        stage: stageIndex,
        decision: schedulerDecision,
      });

      const selectedObligationIds = (schedulerDecision.selectedObligations || []).map(item => item.id);
      const directives = this._maxAttemptDirectives(width, stageIndex, schedulerDecision);
      emitStatus('max-drafting', { stage: stageIndex, attempts: directives.length });
      stage.attempts = await Promise.all(directives.map(async (attempt, localIndex) => {
        const globalIndex = long.attempts.length + localIndex;
        const prompt = `${stageContext}\n\n<max_attempt_directive stage="${stageIndex}" role="${this._escapeXmlAttr(attempt.role)}">
${attempt.instruction}
Do not cite notebook entries as facts. Use only document-proved/source-backed facts directly; prove candidate obligations inline. If a necessary obligation is too large or unsupported, return a visibly blocked proof naming that obligation.
</max_attempt_directive>`;
        const raw = await this._callLlm(prompt, globalIndex === 0 ? onStream : null, apiKey, model, proveSkill, signal);
        return {
          index: globalIndex,
          stage: stageIndex,
          role: attempt.role,
          raw,
          proof: this._extractProof(raw),
          selectedObligationIds,
        };
      }));
      long.attempts.push(...stage.attempts);
      for (const attempt of stage.attempts) {
        appendRunEvent('attempt.completed', {
          stage: stageIndex,
          index: attempt.index,
          role: attempt.role,
          raw: attempt.raw,
          proof: attempt.proof,
          selectedObligationIds: attempt.selectedObligationIds,
        });
      }

      if (options.skipVerify) {
        const first = stage.attempts[0];
        long.selectedAttempt = first?.index ?? null;
        results.proof = first?.proof || this._blockedProof('Max proof pipeline produced no proof attempt.');
        appendRunEvent('run.completed', {
          status: 'skipped_verification',
          selectedAttempt: long.selectedAttempt,
        });
        this._persistProofRunSnapshot(long, targetNode, options);
        return results;
      }

      emitStatus('max-verifying', { stage: stageIndex, attempts: stage.attempts.length });
      for (const attempt of stage.attempts) {
        const verifyInput = `${stageContext}\n\n<proof_to_verify>\n${attempt.raw}\n</proof_to_verify>`;
        attempt.verdict = await this._callLlm(verifyInput, null, apiKey, model, verifySkill, signal);
        attempt.verdictTag = this._normalizeVerdictForProof(this._extractVerdictTag(attempt.verdict), attempt.proof);
        attempt.correctedProof = this._extractCorrectedProof(attempt.verdict);
        appendRunEvent('verification.completed', {
          stage: stageIndex,
          index: attempt.index,
          role: attempt.role,
          verdictTag: attempt.verdictTag,
          verdict: attempt.verdict,
          correctedProof: attempt.correctedProof,
          selectedObligationIds: attempt.selectedObligationIds,
        });
      }

      const passing = stage.attempts.find(a => a.verdictTag === 'PASS');
      if (passing) {
        emitStatus('max-pass', { stage: stageIndex, attempt: passing.index, role: passing.role });
        long.selectedAttempt = passing.index;
        long.finalVerdict = passing.verdict;
        results.verdict = passing.verdict;
        results.proof = passing.proof;
        appendRunEvent('run.completed', {
          status: 'proved',
          verdictTag: 'PASS',
          selectedAttempt: passing.index,
        });
        this._persistProofRunSnapshot(long, targetNode, options);
        return results;
      }

      const corrected = stage.attempts.find(a => a.correctedProof);
      if (corrected) {
        emitStatus('max-reverify-correction', { stage: stageIndex, attempt: corrected.index, role: corrected.role });
        const reVerifyInput = `${stageContext}\n\n<proof_to_verify>\n${corrected.correctedProof}\n</proof_to_verify>`;
        const reVerdict = await this._callLlm(reVerifyInput, null, apiKey, model, verifySkill, signal);
        const reTag = this._normalizeVerdictForProof(this._extractVerdictTag(reVerdict), corrected.correctedProof);
        corrected.correctedVerdict = reVerdict;
        corrected.correctedVerdictTag = reTag;
        long.finalVerdict = reVerdict;
        results.verdict = reVerdict;
        appendRunEvent('correction.verified', {
          stage: stageIndex,
          index: corrected.index,
          role: corrected.role,
          verdictTag: reTag,
          verdict: reVerdict,
          correctedProof: corrected.correctedProof,
          selectedObligationIds: corrected.selectedObligationIds,
        });
        if (reTag === 'PASS') {
          long.selectedAttempt = corrected.index;
          results.proof = corrected.correctedProof;
          appendRunEvent('run.completed', {
            status: 'proved',
            verdictTag: reTag,
            selectedAttempt: corrected.index,
          });
          this._persistProofRunSnapshot(long, targetNode, options);
          return results;
        }
      }

      emitStatus('max-notebook-update', { stage: stageIndex });
      const history = this._formatProofAttemptsForPrompt(long.attempts.slice(-Math.max(width * 2, 6)));
      currentNotebook = await this._callLlm(
        `${baseInput}\n\n${this._asTaggedBlock('proof_notebook', currentNotebook)}\n\n<proof_attempts>\n${history}\n</proof_attempts>\n\n<long_range_update stage="${stageIndex}">
All attempts in this stage failed verification. Update the notebook: preserve supported partial results only as obligations unless proved inline, mark failed routes as discarded, and choose the next stage's concrete tasks.
</long_range_update>`,
        null,
        apiKey,
        model,
        notebookSkill,
        signal,
      );
      stage.nextNotebook = currentNotebook;
      long.notebook = currentNotebook;
      results.proofNotebook = currentNotebook;
      appendRunEvent('notebook.updated', {
        stage: stageIndex,
        text: currentNotebook,
        status: this._extractTagText(currentNotebook, 'status') || 'unknown',
      });
      this._persistProofRunSnapshot(long, targetNode, options);
    }

    emitStatus('max-blocked', { stages: maxStages, attempts: long.attempts.length });
    long.selectedAttempt = null;
    const finalAttempt = [...long.attempts].reverse().find(a => a.verdict);
    long.finalVerdict = finalAttempt?.verdict || null;
    results.verdict = long.finalVerdict;
    results.proof = this._blockedProof(this._summarizeFailedProofPipeline(long.attempts, long.finalVerdict));
    appendRunEvent('run.blocked', {
      stages: maxStages,
      attempts: long.attempts.length,
      finalVerdict: long.finalVerdict,
    });
    this._persistProofRunSnapshot(long, targetNode, options);
    return results;
  }

  // ── Lean sketch → fill → sorrify pipeline ─────────────────────────────────

  /**
   * Three-phase Lean 4 verification pipeline.
   *
   * Phase 1 – Sketch:  Claude generates a sorry-skeleton; lean type-checks it.
   * ⏸ Statement Review: user confirms the theorem statement.
   * Phase 2 – Fill: for each sorry, Claude fills in the proof; lean verifies.
   * Phase 3 – Final verdict.
   *
   * Optimisations vs. original:
   *   - Rich Lean 4 system prompt (tactic guidance, Lean 3 pitfall guards)
   *   - Few-shot examples in sketch / fill / diagnose prompts
   *   - trace_state goal-state probe after sketch verifies
   *   - Context-region-aware sorry parser with enclosing-declaration context
   *   - Lean verify result cache (avoids re-running lean on identical source)
   *   - Full contextPrompt in fill/diagnose (not truncated to 800/600 chars)
   */
  async _leanSketchFillVerify(results, contextPrompt, targetNode, options) {
    const { onStream, onStatus, leanRunner, apiKey, model } = options;
    const maxSketchRetries = 2;
    const maxFillRetries = options.maxLeanRetries ?? 3;

    // Build rich Lean 4 system prompt (aware of mathlib availability).
    // Must use effectiveMathlib (user setting AND cache present), NOT just
    // mathlibReady — otherwise the LLM generates `import Mathlib` but verify()
    // runs in core-only mode, causing "unknown module prefix 'Mathlib'".
    const usesMathlib = leanRunner.effectiveMathlib;
    const LEAN_SYS = this._buildLeanSys(usesMathlib);

    const emitStatus = (phase, extra = {}) => {
      if (onStatus) onStatus({ phase, ...extra });
      console.log(`[LeanSFV] ${phase}`, extra);
    };

    // ── Phase 1: Sketch ────────────────────────────────────────────────────
    let sketch = null;
    let sketchErrors = [];
    let sketchLog = '';

    for (let attempt = 1; attempt <= maxSketchRetries + 1; attempt++) {
      emitStatus(attempt === 1 ? 'lean-sketching' : 'lean-sketch-retry',
        { attempt, maxAttempts: maxSketchRetries + 1 });

      try {
        const raw = await this._callLlm(
          this._buildSketchPrompt(contextPrompt, results.proof, sketch, sketchErrors, attempt),
          onStream, apiKey, model, LEAN_SYS, options.signal,
        );
        sketch = this._extractLeanBlock(raw) || raw.trim();
      } catch (err) {
        console.error('[LeanSFV] Sketch gen failed:', err.message);
        emitStatus('lean-failed', { reason: 'sketch-gen-error' });
        return { ...results, leanCode: null, leanVerified: false, leanLog: '', leanErrors: [], sorries: [] };
      }

      emitStatus('lean-sketch-checking', { attempt });
      sketchLog = '';
      const sketchResult = await this._cachedVerify(leanRunner, sketch, (line) => {
        sketchLog += line + '\n';
        if (onStream) onStream(`[lean] ${line}`);
      }, options.signal);
      sketchErrors = sketchResult.errors.filter(e => e.severity === 'error');

      if (sketchErrors.length === 0) {
        emitStatus('lean-sketch-ok', { attempt });
        if (!sketch.match(/\bsorry\b/)) {
          emitStatus('lean-verified', {});
          return {
            ...results,
            leanCode: sketch,
            leanVerified: true,
            leanLog: sketchLog.trim(),
            leanErrors: [],
            sorries: [],
            leanStatement: this._parseTheoremStatement(sketch),
          };
        }
        break;
      }

      if (attempt > maxSketchRetries) {
        emitStatus('lean-failed', { reason: 'sketch-failed', errorCount: sketchErrors.length });
        return {
          ...results,
          leanCode: sketch,
          leanVerified: false,
          leanLog: sketchLog.trim(),
          leanErrors: sketchErrors,
          sorries: [],
        };
      }
    }

    // ── Goal-state probe ────────────────────────────────────────────────────
    // After the sketch type-checks, run a trace_state probe to extract
    // Lean-elaborated goal states for bare (unannotated) sorries. This
    // enriches sorry.expectedType and sorry.hypotheses before the fill phase.
    const sorries = await this._probeGoalStates(sketch, leanRunner, options.signal);
    console.log(`[LeanSFV] Parsed ${sorries.length} sorries from sketch`);

    // ── ⏸ Statement Review ────────────────────────────────────────────────
    const statement = this._parseTheoremStatement(sketch);
    emitStatus('lean-statement-review', { statement, sketch });

    if (options.onStatementReview) {
      const reviewResult = await new Promise((resolve) => {
        options.onStatementReview({ statement, sketch, resolve });
      });

      if (reviewResult.action === 'cancel') {
        emitStatus('lean-failed', { reason: 'user-cancelled' });
        return { ...results, leanCode: sketch, leanVerified: false, leanLog: sketchLog.trim(), leanErrors: [], sorries: [] };
      }

      if (reviewResult.action === 'edit' && reviewResult.newCode) {
        sketch = reviewResult.newCode;
        sketchLog = '';
        const recheck = await this._cachedVerify(leanRunner, sketch, (line) => {
          sketchLog += line + '\n';
          if (onStream) onStream(`[lean] ${line}`);
        }, options.signal);
        sketchErrors = recheck.errors.filter(e => e.severity === 'error');
        if (sketchErrors.length > 0) {
          console.warn('[LeanSFV] User-edited sketch has errors; proceeding anyway per user choice');
        }
      }
    }

    const sorryStatuses = sorries.map((s, i) => ({
      ...s, index: i, status: 'pending', fillCode: null, errors: null,
    }));

    let currentCode = sketch;
    let leanLog = sketchLog;

    // ── Phase 2 & 3: Fill each sorry ──────────────────────────────────────
    for (let i = 0; i < sorries.length; i++) {
      // Count sorries only in code regions (P-7: ignore comments)
      if (!this._countCodeSorries(currentCode)) {
        sorryStatuses.slice(i).forEach(s => { s.status = 'filled'; s.fillCode = currentCode; });
        break;
      }

      const sorry = sorryStatuses[i];
      sorry.status = 'filling';
      emitStatus('lean-filling', {
        sorryIndex: i, total: sorries.length,
        filled: sorryStatuses.filter(s => s.status === 'filled').length,
      });

      const prevSorryCount = this._countCodeSorries(currentCode);
      let fillErrors = [];
      let lastCandidate = currentCode;

      for (let attempt = 1; attempt <= maxFillRetries; attempt++) {
        if (attempt > 1) {
          emitStatus('lean-fill-retry', { sorryIndex: i, attempt, maxAttempts: maxFillRetries });
        }

        const prompt = attempt === 1
          ? this._buildFillPrompt(currentCode, sorry, i, sorries.length, results.proof, contextPrompt)
          : this._buildDiagnosePrompt(lastCandidate, sorry, fillErrors, contextPrompt, attempt);

        let rawFill;
        try {
          rawFill = await this._callLlm(prompt, onStream, apiKey, model, LEAN_SYS, options.signal);
        } catch (err) {
          console.error(`[LeanSFV] Fill ${i} attempt ${attempt} error:`, err.message);
          break;
        }

        const candidate = this._extractLeanBlock(rawFill) || rawFill.trim();
        lastCandidate = candidate;

        let lineOut = '';
        const fillResult = await this._cachedVerify(leanRunner, candidate, (line) => {
          lineOut += line + '\n';
          if (onStream) onStream(`[lean] ${line}`);
        }, options.signal);
        leanLog = lineOut;
        fillErrors = fillResult.errors.filter(e => e.severity === 'error');

        const newSorryCount = this._countCodeSorries(candidate);
        const madeProgress = newSorryCount < prevSorryCount;

        if (fillErrors.length === 0 && madeProgress) {
          currentCode = candidate;
          sorry.status = 'filled';
          sorry.fillCode = candidate;
          emitStatus('lean-fill-ok', { sorryIndex: i, total: sorries.length });
          break;
        }

        if (!madeProgress) {
          fillErrors = [
            ...fillErrors,
            { severity: 'error', line: 0, col: 0, message: 'Sorry was not filled — no progress made' },
          ];
        }

        if (attempt >= maxFillRetries) {
          sorry.status = 'failed';
          sorry.errors = fillErrors.filter(e => e.message !== 'Sorry was not filled — no progress made');
          emitStatus('lean-fill-failed', { sorryIndex: i, total: sorries.length });
        }
      }
    }

    // ── Final verdict ──────────────────────────────────────────────────────
    const anyFilled        = sorryStatuses.some(s => s.status === 'filled');
    const remainingSorries = this._countCodeSorries(currentCode);

    let finalLog = '';
    const finalResult = await this._cachedVerify(leanRunner, currentCode, (line) => { finalLog += line + '\n'; }, options.signal);
    const finalErrors = finalResult.errors.filter(e => e.severity === 'error');
    const leanVerified = finalErrors.length === 0 && remainingSorries === 0;

    if (leanVerified)   emitStatus('lean-verified', { sorries: sorryStatuses });
    else if (anyFilled) emitStatus('lean-partial',  { sorries: sorryStatuses });
    else                emitStatus('lean-failed',   { sorries: sorryStatuses });

    return {
      ...results,
      leanCode: currentCode,
      leanVerified,
      leanLog: finalLog.trim(),
      leanErrors: finalErrors,
      sorries: sorryStatuses,
      leanStatement: this._parseTheoremStatement(currentCode),
    };
  }

  // ── System prompt ─────────────────────────────────────────────────────────

  /**
   * Build the rich Lean 4 system prompt used for all sketch/fill/diagnose calls.
   * Includes tactic hierarchy, Lean 3 pitfall guards, and sorry annotation rules.
   */
  _buildLeanSys(usesMathlib = false) {
    const importLine = usesMathlib ? 'import Mathlib' : 'import Std';
    return `\
You are a Lean 4 proof assistant integrated into the Fermat theorem-proving pipeline.

IMPORTS: Every generated file must begin with \`${importLine}\`.

LEAN 4 vs LEAN 3 — avoid these common Lean 3 regressions:
- Use \`by\` for tactic blocks, NOT \`begin ... end\`
- Module names are UpperCamelCase: \`Nat.Prime\` not \`nat.prime\`
- \`And\` fields: \`h.left\` / \`h.right\`, not \`h.1\` / \`h.2\`
- Tactic separators: newlines or \`<;>\`, NOT commas
- \`ring\` not \`ring'\`; \`simp\` not \`simp_rw\` for simple rewrites
- \`rcases h with ⟨a, b⟩\` / \`obtain ⟨a, b⟩ := h\` for destructuring
- \`#check\` is a top-level command only — never use it inside a tactic block
- Case labels: \`case zero =>\` / \`case succ n ih =>\`, not comma-separated

TACTIC PRIORITY (try in order for each goal type):
- Linear arithmetic (ℤ/ℕ equalities, inequalities): \`omega\` → \`linarith\` → \`norm_num\`
- Ring / field identities:                           \`ring\` → \`field_simp; ring\`
- Decidable / small numerics:                        \`decide\` → \`norm_num\`
- Propositional tautology:                           \`tauto\` → \`aesop\`
- Existential with known witness:                    \`exact ⟨w, h⟩\` → \`refine ⟨?_, ?_⟩\`
- Set/finset membership:                             \`simp [Finset.mem_insert]\` → \`decide\`
- Structural induction:                              \`induction n with | zero => ... | succ n ih => ...\`
- Case split on hypothesis:                          \`rcases h with h₁ | h₂\` → \`obtain ⟨a, ha⟩ := h\`

SORRY ANNOTATION RULE: Every \`sorry\` in a skeleton MUST be annotated as
\`show T; sorry\` where T is the Lean type of the subgoal at that point.
If unsure of the exact type, write \`show ?_; sorry\` as a placeholder.
This annotation is REQUIRED — bare \`sorry\` without \`show T;\` is not acceptable.

Output ONLY a \`\`\`lean4 ... \`\`\` code block. No prose, no markdown outside the fence.`;
  }

  // ── Prompt builders ───────────────────────────────────────────────────────

  /** Build the sketch-generation prompt (Phase 1). */
  _buildSketchPrompt(contextPrompt, naturalProof, prevSketch, prevErrors, attempt) {
    if (attempt === 1) {
      return `\
Generate a Lean 4 proof skeleton with \`sorry\` placeholders.

RULES:
1. The skeleton MUST type-check with sorry allowed (no structural/syntax errors).
2. EVERY sorry MUST be annotated: \`show T; sorry\` where T is the expected type.
3. Do NOT fill in real proofs — only build the structure.
4. Include \`import Mathlib\` (or appropriate imports) at the top.

EXAMPLE — how to turn an informal proof into a skeleton:
  Informal: "We induct on n. Base: 0 + 0 = 0 by rfl. Step: assume n + 0 = n, then
             (n+1) + 0 = n + 1 follows because addition is defined recursively."
  Skeleton:
  \`\`\`lean4
  import Mathlib
  theorem add_zero (n : ℕ) : n + 0 = n := by
    induction n with
    | zero      => show 0 + 0 = 0; sorry
    | succ n ih => show n.succ + 0 = n.succ; sorry
  \`\`\`

MATHEMATICAL CONTEXT:
${contextPrompt}

INFORMAL PROOF TO FORMALIZE:
${naturalProof}`;
    }

    return `\
Your previous Lean 4 proof sketch had structural errors. Fix the STRUCTURE only.
Keep all \`sorry\` placeholders as-is — do not fill them in.

Previous sketch:
\`\`\`lean4
${prevSketch}
\`\`\`

Errors to fix:
${prevErrors.map(e => `  line ${e.line}: ${e.message}`).join('\n')}

Output the corrected \`\`\`lean4 ... \`\`\` code block.`;
  }

  /** Build the fill prompt for sorry #sorryIndex (Phase 2). */
  _buildFillPrompt(currentCode, sorry, sorryIndex, total, naturalProof, contextPrompt) {
    const typeHint = sorry.expectedType
      ? `\nExpected type (from Lean elaboration): \`${sorry.expectedType}\``
      : '';

    const hypHint = sorry.hypotheses?.length
      ? `\nLocal hypotheses at this point:\n${sorry.hypotheses.map(h => `  ${h}`).join('\n')}`
      : '';

    const declHint = sorry.enclosingDeclaration
      ? `\nEnclosing declaration:\n\`\`\`lean4\n${sorry.enclosingDeclaration}\n\`\`\``
      : '';

    return `\
Fill in exactly ONE \`sorry\` in the following Lean 4 proof sketch.

EXAMPLE — filling a sorry:
  Before (sorry #1 of 2):
  \`\`\`lean4
  theorem even_sq (n : ℕ) (h : 2 ∣ n) : 2 ∣ n ^ 2 := by
    obtain ⟨k, hk⟩ := h
    subst hk
    show 2 ∣ (2 * k) ^ 2; sorry
    show 2 ∣ k; sorry
  \`\`\`
  After (sorry #1 filled):
  \`\`\`lean4
  theorem even_sq (n : ℕ) (h : 2 ∣ n) : 2 ∣ n ^ 2 := by
    obtain ⟨k, hk⟩ := h
    subst hk
    exact ⟨2 * k ^ 2, by ring⟩
    show 2 ∣ k; sorry
  \`\`\`

SKETCH (filling sorry ${sorryIndex + 1} of ${total}):
\`\`\`lean4
${currentCode}
\`\`\`

The sorry to fill is near line ${sorry.line}:
\`\`\`
${sorry.surroundingCode}
\`\`\`
${typeHint}${hypHint}${declHint}

INFORMAL PROOF CONTEXT:
${naturalProof}

MATHEMATICAL CONTEXT:
${contextPrompt}

OUTPUT: The complete Lean 4 code with sorry #${sorryIndex + 1} replaced by a working proof.
Keep all OTHER \`sorry\` placeholders unchanged.
Output ONLY a \`\`\`lean4 ... \`\`\` code block.`;
  }

  /**
   * Build the diagnose/retry prompt for a failed fill.
   * @param {number} attempt — which retry (2 = first diagnose, 3 = second, etc.)
   */
  _buildDiagnosePrompt(code, sorry, errors, contextPrompt, attempt = 2) {
    const strategyHint = attempt >= 3
      ? '\nATTENTION: Your previous attempts have failed. Try a DIFFERENT approach — if you used `simp`, try explicit rewrites or `omega`; if you used tactic mode, try term mode.\n'
      : '';

    // Classify errors to give targeted hints
    const classifiedErrors = errors.map(e => {
      let hint = '';
      const msg = e.message || '';
      if (msg.includes('unknown identifier') || msg.includes('unknown constant')) {
        hint = ' [HINT: wrong name — check capitalisation or use fully-qualified module path]';
      } else if (msg.includes('type mismatch')) {
        hint = ' [HINT: types don\'t match — check implicit arguments or use explicit coercion]';
      } else if (msg.includes('unsolved goals')) {
        hint = ' [HINT: proof is incomplete — add more tactic steps or use `exact?`/`apply?`]';
      } else if (msg.includes('failed to synthesize')) {
        hint = ' [HINT: missing typeclass instance — try adding `inferInstance` or explicit instance]';
      } else if (msg.includes('function expected')) {
        hint = ' [HINT: applied a non-function — check implicit vs explicit argument braces `{ }` vs `( )`]';
      }
      return `  line ${e.line}: ${e.message}${hint}`;
    });

    const typeHint = sorry.expectedType
      ? `\nExpected type at this sorry: \`${sorry.expectedType}\``
      : '';

    const hypHint = sorry.hypotheses?.length
      ? `\nLocal hypotheses:\n${sorry.hypotheses.map(h => `  ${h}`).join('\n')}`
      : '';

    return `\
The following Lean 4 proof attempt failed. Fix the errors.
${strategyHint}
EXAMPLE — fixing a type-mismatch error:
  Broken:  \`exact Nat.prime n\`    -- error: unknown identifier 'Nat.prime'
  Fixed:   \`exact Nat.Prime n\`    -- Lean 4 uses UpperCamelCase

CURRENT CODE:
\`\`\`lean4
${code}
\`\`\`

LEAN ERRORS:
${classifiedErrors.join('\n')}

TARGET SUBGOAL (near line ${sorry.line}):
\`\`\`
${sorry.surroundingCode}
\`\`\`
${typeHint}${hypHint}

MATHEMATICAL CONTEXT:
${contextPrompt}

Output the COMPLETE corrected \`\`\`lean4 ... \`\`\` code block.
Keep unrelated \`sorry\` placeholders unchanged.`;
  }

  // ── Sorry parser ──────────────────────────────────────────────────────────

  /**
   * Parse the positions and context of every `sorry` in Lean code,
   * skipping sorries inside block comments (/-  -/) and line comments (--).*
   * Returns [{ line, col, expectedType, surroundingCode, enclosingDeclaration,
   *            hypotheses? }].
   *
   * Note: nested block comments (Lean 4 supports them) are handled by the
   * simple regex strip below, which only handles one level. Deeply-nested
   * comments are rare in proof files.
   */
  _parseSorries(code) {
    // Strip block comments to avoid matching sorry inside /- ... -/
    // Single-level only; nested /- /- -/ -/ may not strip fully (acceptable).
    const stripped = code.replace(/\/-([\s\S]*?)-\//g, m => ' '.repeat(m.length));
    const lines     = stripped.split('\n');
    const origLines = code.split('\n');
    const sorries   = [];

    for (let i = 0; i < lines.length; i++) {
      // Remove line comment from consideration
      const codePart = lines[i].replace(/--.*$/, '');
      if (!/\bsorry\b/.test(codePart)) continue;

      const col = codePart.indexOf('sorry');

      // Extract type annotation from original line (not stripped)
      const origLine   = origLines[i];
      const showMatch  = origLine.match(/\bshow\s+(.+?);\s*sorry\b/);
      const annotMatch = origLine.match(/\(\s*sorry\s*:\s*([^)]+)\)/);
      const expectedType = (showMatch?.[1] || annotMatch?.[1] || '').trim() || null;

      const ctxLines = origLines.slice(Math.max(0, i - 5), Math.min(origLines.length, i + 3));
      const enclosingDeclaration = this._findEnclosingDeclaration(origLines, i);

      sorries.push({
        line: i + 1,
        col,
        expectedType,
        surroundingCode: ctxLines.join('\n'),
        enclosingDeclaration,
      });
    }

    return sorries;
  }

  /**
   * Walk backward from `lineIdx` to find the nearest theorem/lemma/def/instance
   * declaration. Returns the declaration header (up to the `:= by` line) as a
   * string, or null if not found.
   */
  _findEnclosingDeclaration(lines, lineIdx) {
    const DECL_RE = /^(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma|def|example|instance|abbrev)\b/;
    for (let i = lineIdx; i >= 0; i--) {
      if (!DECL_RE.test(lines[i])) continue;
      // Collect lines from the declaration keyword up to `:= by` / `:= {`
      const declLines = [];
      for (let k = i; k <= lineIdx && k < lines.length; k++) {
        declLines.push(lines[k]);
        if (/(:=\s*by\b|:=\s*\{)/.test(lines[k])) break;
      }
      return declLines.join('\n');
    }
    return null;
  }

  /**
   * Count `sorry` occurrences in non-comment code regions.
   * Replaces the old `(code.match(/\bsorry\b/g) || []).length` which
   * matched sorry inside comments and string literals.
   */
  _countCodeSorries(code) {
    const stripped = code.replace(/\/-([\s\S]*?)-\//g, m => ' '.repeat(m.length));
    const lines    = stripped.split('\n');
    let count = 0;
    for (const line of lines) {
      const codePart = line.replace(/--.*$/, '');
      const m = codePart.match(/\bsorry\b/g);
      if (m) count += m.length;
    }
    return count;
  }

  // ── Goal-state probe ──────────────────────────────────────────────────────

  /**
   * After the sketch type-checks, run a lean probe that inserts `trace_state`
   * before each bare (unannotated) sorry. Lean outputs the goal state as an
   * `information:` message, which we parse to populate sorry.expectedType and
   * sorry.hypotheses.
   *
   * Falls back gracefully: if the probe fails or trace_state is unavailable,
   * returns sorries from _parseSorries() without goal-state enrichment.
   */
  async _probeGoalStates(sketch, leanRunner, signal) {
    const sorries = this._parseSorries(sketch);
    if (!sorries.some(s => !s.expectedType)) return sorries; // all already annotated

    try {
      const probeCode   = this._buildProbeCode(sketch, sorries);
      // Don't use the cache here — the probe code differs from the real sketch
      const probeResult = await leanRunner.verify(probeCode, () => {}, signal);
      this._parseGoalStates(probeResult.rawOutput, sorries);
      const enriched = sorries.filter(s => s.expectedType).length;
      if (enriched) console.log(`[LeanSFV] Goal-state probe enriched ${enriched}/${sorries.length} sorries`);
    } catch (err) {
      console.warn('[LeanSFV] Goal-state probe failed (non-fatal):', err.message);
    }

    return sorries;
  }

  /**
   * Build a probe version of the sketch where each unannotated sorry is
   * replaced with `trace_state; sorry`. Lean's `trace_state` tactic emits
   * the current proof state as an `information:` log message.
   */
  _buildProbeCode(sketch, sorries) {
    const lines      = sketch.split('\n');
    const probeLines = [...lines];
    for (const sorry of sorries) {
      if (sorry.expectedType) continue;
      const idx = sorry.line - 1;
      if (idx >= 0 && idx < probeLines.length) {
        // Replace the first `sorry` on this line with `trace_state; sorry`
        probeLines[idx] = probeLines[idx].replace(/\bsorry\b/, 'trace_state; sorry');
      }
    }
    return probeLines.join('\n');
  }

  /**
   * Parse Lean's rawOutput for trace_state information messages and
   * populate sorry.expectedType / sorry.hypotheses in-place.
   *
   * Expected format in rawOutput (multi-line):
   *   "path/file.lean:LINE:COL: information: [optional case label]"
   *   "h₁ : T₁"
   *   "⊢ goalType"
   */
  _parseGoalStates(rawOutput, sorries) {
    const outputLines = rawOutput.split('\n');

    for (const sorry of sorries) {
      if (sorry.expectedType !== null) continue;

      const targetLine = sorry.line;

      // Find the `information:` message emitted at sorry.line by trace_state
      let infoIdx = -1;
      for (let i = 0; i < outputLines.length; i++) {
        const m = outputLines[i].match(/:(\d+):\d+: information: (.*)/);
        if (m && parseInt(m[1], 10) === targetLine) {
          infoIdx = i;
          break;
        }
      }
      if (infoIdx < 0) continue;

      // Collect multi-line content: first line's suffix + continuation lines
      let content = outputLines[infoIdx].replace(/.*?: information: /, '');
      let j = infoIdx + 1;
      while (j < outputLines.length && !outputLines[j].match(/^.*?:\d+:\d+: /)) {
        content += '\n' + outputLines[j];
        j++;
      }

      const infoLines = content.split('\n').filter(l => l.trim());
      const goalIdx   = infoLines.findIndex(l => l.trim().startsWith('⊢'));
      if (goalIdx >= 0) {
        sorry.expectedType = infoLines[goalIdx].replace(/^\s*⊢\s*/, '').trim();
      }

      const hyps = infoLines
        .slice(0, goalIdx >= 0 ? goalIdx : infoLines.length)
        .filter(l => l.trim() && !/^case\b/.test(l.trim()));
      if (hyps.length) {
        sorry.hypotheses = hyps.map(l => l.trim());
      }
    }
  }

  // ── Verify cache ──────────────────────────────────────────────────────────

  /**
   * Cache wrapper around leanRunner.verify().
   * Keyed by a hash of the source code. Avoids re-running lean on identical
   * source (common when diagnose retries produce the same code, or when the
   * final-verdict pass re-verifies code already verified during the fill loop).
   */
  async _cachedVerify(leanRunner, code, onLine, signal) {
    const key = this._hashCode(code);
    if (this._verifyCache.has(key)) {
      console.log('[LeanSFV] Verify cache hit');
      const cached = this._verifyCache.get(key);
      // Replay output lines so the UI log stays consistent
      if (onLine) {
        for (const line of cached.rawOutput.split('\n')) {
          if (line) onLine(line);
        }
      }
      return cached;
    }

    const result = await leanRunner.verify(code, onLine, signal);

    // Only cache when not cancelled (abort yields partial results)
    if (!signal?.aborted) {
      this._verifyCache.set(key, result);
      // Keep the cache bounded — evict oldest entry above 60 items
      if (this._verifyCache.size > 60) {
        this._verifyCache.delete(this._verifyCache.keys().next().value);
      }
    }
    return result;
  }

  /** Simple djb2-style hash of a string. Sufficient for cache keying. */
  _hashCode(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  // ── LLM dispatch ─────────────────────────────────────────────────────────

  /**
   * Unified LLM call — uses Claude CLI when available, ClaudeProvider otherwise.
   * The provider path goes through the llm-provider abstraction layer.
   */
  async _callLlm(prompt, onStream, apiKey, model, systemPrompt = '', signal = undefined) {
    if (signal?.aborted) {
      const err = new Error('Cancelled before LLM call');
      err.code = 'FERMAT_CANCELLED';
      throw err;
    }

    if (this._hasClaudeCli) {
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      return this._runClaude(fullPrompt, onStream, signal, model);
    }

    // Direct API path — use provider abstraction
    const provider = this._getOrUpdateProvider(apiKey, model);
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: prompt },
    ];
    try {
      return await provider.complete(messages, { signal, onToken: onStream });
    } catch (err) {
      if (err.code === 'FERMAT_CANCELLED') throw err;
      throw classifyAndAnnotateError(err);
    }
  }

  /** Run claude CLI in non-interactive (print) mode. */
  _runClaude(prompt, onStream, signal = undefined, model = undefined) {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--model', resolveModelId(model),
      ];

      const proc = spawn(this._claudePath, args, {
        cwd: this.projectRoot,
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let abortedByCaller = false;

      const onAbort = () => {
        abortedByCaller = true;
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        if (onStream) onStream(text);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // B-06: surface stdin EPIPE instead of letting it bubble
      proc.stdin.on('error', (err) => {
        if (err.code === 'EPIPE') {
          console.warn('[ClaudeCLI] stdin EPIPE — child exited before reading full prompt');
        } else {
          console.warn(`[ClaudeCLI] stdin error: ${err.message}`);
        }
      });
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (err) {
        console.warn(`[ClaudeCLI] stdin.write threw: ${err.message}`);
      }

      proc.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (abortedByCaller) {
          const abortErr = new Error('Cancelled');
          abortErr.code = 'FERMAT_CANCELLED';
          return reject(abortErr);
        }
        if (code !== 0 && !stdout) {
          console.error(`[ClaudeCLI] Exit ${code}: ${stderr.slice(0, 400)}`);
          const err = new Error(`Claude CLI exited with code ${code}: ${stderr}`);
          reject(classifyAndAnnotateError(err));
        } else {
          if (stderr) console.warn(`[ClaudeCLI] stderr: ${stderr.slice(0, 200)}`);
          resolve(stdout.trim());
        }
      });

      proc.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        console.error(`[ClaudeCLI] Spawn failed: ${err.message}`);
        const wrapped = new Error(`Failed to spawn Claude CLI: ${err.message}`);
        reject(classifyAndAnnotateError(wrapped));
      });
    });
  }

  // ── Lean 4 helpers ────────────────────────────────────────────────────────

  /**
   * Extract the theorem/lemma declaration header from Lean 4 code.
   * Handles `:= by`, `:= {`, and term-mode (`:= expr`).
   */
  _parseTheoremStatement(code) {
    if (!code) return null;
    // Find `:= by` or `:= {` at depth 0 (bracket-aware scan)
    let depth = 0;
    const tokens = [['/-', -1], ['-/', +1]]; // block comment tracking handled separately
    const lines = code.split('\n');
    let charCount = 0;
    for (const line of lines) {
      const lineStart = charCount;
      // Check for `:= by` or `:= {` not inside a comment
      const assignMatch = line.match(/:=\s*(by\b|\{)/);
      if (assignMatch && depth === 0) {
        const assignIdx = charCount + assignMatch.index;
        return code.slice(0, assignIdx).trim();
      }
      charCount += line.length + 1;
      void tokens; void depth; void lineStart;
    }
    // Fallback: first meaningful lines
    const meaningful = code.split('\n').filter(
      l => l.trim() && !l.startsWith('import') && !l.startsWith('open') &&
           !l.startsWith('--') && !l.startsWith('/-'),
    );
    return meaningful.slice(0, 5).join('\n');
  }

  /**
   * Extract the first ```lean4 ... ``` (or ```lean ...) block from a string.
   */
  _extractLeanBlock(text) {
    if (!text) return '';
    const m = text.match(/```(?:lean4?)\n([\s\S]*?)```/);
    if (m) return m[1].trim();
    const m2 = text.match(/```\n([\s\S]*?)```/);
    if (m2) return m2[1].trim();
    return text.trim();
  }

  // ── Max-effort run persistence ───────────────────────────────────────────

  _proofRunId(targetNode) {
    const label = targetNode?.labels?.[0] || targetNode?.name || targetNode?.id || 'target';
    const safe = String(label).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'target';
    return `${Date.now()}-${safe}`;
  }

  _persistProofRunSnapshot(run, targetNode, options = {}) {
    try {
      const fermatDir = this._resolveFermatDir(options.marker || {});
      if (!fermatDir) return null;
      const runsDir = path.join(fermatDir, 'proof-runs');
      fs.mkdirSync(runsDir, { recursive: true });
      const runPath = path.join(runsDir, `${run.runId || this._proofRunId(targetNode)}.json`);
      run.runPath = runPath;
      const payload = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        target: {
          id: targetNode?.id || null,
          type: targetNode?.type || null,
          name: targetNode?.name || null,
          labels: targetNode?.labels || [],
          lineNumber: targetNode?.lineNumber || null,
        },
        run: this._compactProofRun(run),
      };
      fs.writeFileSync(runPath, JSON.stringify(payload, null, 2));
      return runPath;
    } catch (err) {
      console.warn(`[MaxPipeline] Failed to persist run snapshot: ${err.message}`);
      return null;
    }
  }

  _persistProofRunArtifacts(proofRun, targetNode, options = {}) {
    try {
      const fermatDir = this._resolveFermatDir(options.marker || {});
      if (!fermatDir) return null;
      const paths = persistProofRunArtifacts(proofRun, fermatDir);
      if (paths) {
        console.log(`[MaxPipeline] Event log: ${paths.runPath}`);
      }
      void targetNode;
      return paths;
    } catch (err) {
      console.warn(`[MaxPipeline] Failed to persist proof run event log: ${err.message}`);
      return null;
    }
  }

  _compactProofRun(run) {
    const compactAttempt = (attempt = {}) => ({
      index: attempt.index,
      stage: attempt.stage,
      role: attempt.role,
      verdictTag: attempt.verdictTag || this._extractVerdictTag(attempt.verdict),
      correctedVerdictTag: attempt.correctedVerdictTag || this._extractVerdictTag(attempt.correctedVerdict),
      selectedObligationIds: attempt.selectedObligationIds || [],
      proof: this._truncateForPrompt(attempt.proof || '', 2000),
      verifierFeedback: this._truncateForPrompt(attempt.verdict || '', 2000),
    });
    return {
      mode: run.mode,
      runId: run.runId,
      runPath: run.runPath || null,
      width: run.width,
      maxStages: run.maxStages,
      selectedAttempt: run.selectedAttempt,
      finalVerdictTag: this._extractVerdictTag(run.finalVerdict),
      notebook: this._truncateForPrompt(run.notebook || '', 5000),
      attempts: (run.attempts || []).map(compactAttempt),
      stages: (run.stages || []).map(stage => ({
        index: stage.index,
        notebookStatus: stage.notebookStatus,
        schedulerDecision: stage.schedulerDecision ? {
          focus: stage.schedulerDecision.focus,
          graphStatus: stage.schedulerDecision.graphStatus,
          selectedObligations: (stage.schedulerDecision.selectedObligations || []).map(item => ({
            id: item.id,
            statement: this._truncateForPrompt(item.statement || '', 500),
            tier: item.tier,
            usePolicy: item.usePolicy,
            confidence: item.confidence,
            status: item.status,
          })),
          selectedRoutes: (stage.schedulerDecision.selectedRoutes || []).map(item => ({
            id: item.id,
            idea: this._truncateForPrompt(item.idea || '', 500),
            confidence: item.confidence,
            usePolicy: item.usePolicy,
          })),
        } : null,
        notebook: this._truncateForPrompt(stage.notebook || '', 2500),
        nextNotebook: this._truncateForPrompt(stage.nextNotebook || '', 2500),
        research: this._truncateForPrompt(stage.research || '', 2500),
        attempts: (stage.attempts || []).map(compactAttempt),
      })),
    };
  }

  _resolveFermatDir(marker = {}) {
    const startDirs = [];
    if (typeof marker.projectDir === 'string' && marker.projectDir) {
      startDirs.push(marker.projectDir);
    }
    if (typeof marker.filePath === 'string' && marker.filePath) {
      startDirs.push(path.dirname(marker.filePath));
    }
    if (startDirs.length === 0) return null;

    for (const start of startDirs) {
      let dir = path.resolve(start);
      for (let depth = 0; depth < 8; depth++) {
        const fermatDir = path.join(dir, '.fermat');
        if (fs.existsSync(fermatDir) || fs.existsSync(path.join(dir, '.git'))) {
          fs.mkdirSync(fermatDir, { recursive: true });
          return fermatDir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    const fallback = path.join(path.resolve(startDirs[0]), '.fermat');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }

  // ── Project knowledge ledger ─────────────────────────────────────────────

  /**
   * Load an optional project-level knowledge ledger.
   *
   * Search order:
   *   1. marker.knowledgeLedgerPath, if provided
   *   2. .fermat/knowledge.md in marker.projectDir
   *   3. .fermat/knowledge.md in marker.filePath's directory or its ancestors
   *
   * The ledger is read-only here. Skills may propose updates, but writes should
   * be explicit user actions so an LLM cannot silently mutate mathematical
   * assumptions behind the user's back.
   */
  _loadKnowledgeLedger(marker = {}) {
    const MAX_CHARS = 30_000;

    const directPath = typeof marker.knowledgeLedgerPath === 'string'
      ? marker.knowledgeLedgerPath
      : null;
    const startDirs = [];

    if (typeof marker.projectDir === 'string' && marker.projectDir) {
      startDirs.push(marker.projectDir);
    }
    if (typeof marker.filePath === 'string' && marker.filePath) {
      startDirs.push(path.dirname(marker.filePath));
    }

    const candidates = [];
    if (directPath) candidates.push(path.resolve(directPath));

    const seenDirs = new Set();
    for (const start of startDirs) {
      let dir = path.resolve(start);
      for (let depth = 0; depth < 8; depth++) {
        if (seenDirs.has(dir)) break;
        seenDirs.add(dir);
        candidates.push(path.join(dir, '.fermat', 'knowledge.md'));
        if (fs.existsSync(path.join(dir, '.git'))) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    for (const candidate of candidates) {
      try {
        if (!candidate || !fs.existsSync(candidate)) continue;
        const raw = fs.readFileSync(candidate, 'utf-8');
        const truncated = raw.length > MAX_CHARS;
        const content = truncated
          ? raw.slice(0, MAX_CHARS) + '\n\n[FERMAT: knowledge ledger truncated for prompt budget]\n'
          : raw;
        console.log(`[Knowledge] Loaded ledger: ${candidate}${truncated ? ' (truncated)' : ''}`);
        return { path: candidate, content, truncated };
      } catch (err) {
        console.warn(`[Knowledge] Failed to read ledger ${candidate}: ${err.message}`);
      }
    }

    return null;
  }

  _asTaggedBlock(tagName, text) {
    const body = String(text || '').trim();
    const tagPattern = new RegExp(`<${tagName}(\\s|>)`);
    if (tagPattern.test(body)) return body;
    return `<${tagName}>\n${body}\n</${tagName}>`;
  }

  // ── Skill loader ──────────────────────────────────────────────────────────

  _loadSkill(name) {
    const skillPath = path.join(this.skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillPath}`);
    }
    return fs.readFileSync(skillPath, 'utf-8').replace(/^---[\s\S]*?---\n*/, '');
  }

  // ── Target node resolution ────────────────────────────────────────────────

  _findTargetNode(outline, marker) {
    if (marker.lineNumber) {
      return outline.nodes.find(n =>
        n.proveItMarker && Math.abs(n.lineNumber - marker.lineNumber) < 10,
      );
    }
    if (marker.id) {
      return outline.nodes.find(n => n.id === marker.id);
    }
    if (marker.label) {
      return outline.nodes.find(n =>
        n.labels?.some(l => marker.label.includes(l)) ||
        marker.label.includes(n.name),
      );
    }
    return null;
  }

  // ── LaTeX proof extraction ────────────────────────────────────────────────

  /**
   * Extract \begin{proof}...\end{proof} from model output.
   * B-12: only wrap output that actually looks like a LaTeX proof body.
   */
  _extractProof(text) {
    if (!text) return '';
    const match = text.match(/\\begin\{proof\}[\s\S]*?\\end\{proof\}/);
    if (match) return match[0];

    const trimmed = text.trim();
    if (trimmed.startsWith('\\begin{proof}')) return trimmed;

    if (this._looksLikeProofBody(trimmed)) {
      return `\\begin{proof}\n${trimmed}\n\\end{proof}`;
    }

    console.warn('[Prove] Model did not return a LaTeX proof; surfacing as placeholder');
    const preview = trimmed.replace(/\n/g, ' ').slice(0, 160);
    return `% [FERMAT] The model did not produce a LaTeX proof.\n% Preview: ${preview}${preview.length >= 160 ? '…' : ''}\n\\begin{proof}\n  % TODO: model output was not a proof — inspect the model response and retry.\n\\end{proof}`;
  }

  _looksLikeProofBody(text) {
    if (!text) return false;
    if (/\b(I cannot|I can't|I'm sorry|I apologize|As an AI)\b/i.test(text)) return false;
    if (/^```/m.test(text) || /\btheorem\s+\w+\s*:/.test(text) || /:=\s*by\b/.test(text)) return false;
    if (/\\(begin|end|QED|qed|square|blacksquare|textit|emph|cite|ref)\b/.test(text)) return true;
    if (/\$[^$]*\$/.test(text)) return true;
    if (/\\\\/.test(text)) return true;
    return false;
  }

  _extractVerdictTag(text) {
    const body = String(text || '');
    const match = body.match(/<verdict>\s*(PASS|NEEDS_REVISION|FAIL)\s*<\/verdict>/i) ||
      body.match(/<verdict>\s*(PASS|NEEDS_REVISION|FAIL)\b/i);
    return match ? match[1].toUpperCase() : 'UNKNOWN';
  }

  _extractCorrectedProof(text) {
    const body = String(text || '');
    const match = body.match(/<corrected_proof>\s*([\s\S]*?)\s*<\/corrected_proof>/i);
    if (!match) return '';

    const corrected = match[1].trim();
    if (!corrected || /^(none|n\/a|not available|no corrected proof)\.?$/i.test(corrected)) {
      return '';
    }

    if (/\\begin\{proof\}/.test(corrected) || this._looksLikeProofBody(corrected)) {
      return this._extractProof(corrected);
    }

    return '';
  }

  _formatProofAttemptsForPrompt(attempts = []) {
    return attempts.map((attempt, i) => {
      const index = Number.isInteger(attempt.index) ? attempt.index : i;
      const role = this._escapeXmlAttr(attempt.role || 'attempt');
      const verdictTag = this._escapeXmlAttr(attempt.verdictTag || this._extractVerdictTag(attempt.verdict));
      return [
        `<attempt index="${index}" role="${role}" verdict="${verdictTag}">`,
        '<proof>',
        this._truncateForPrompt(attempt.proof || attempt.raw || '', 4500),
        '</proof>',
        '<verifier_feedback>',
        this._truncateForPrompt(attempt.verdict || '', 4500),
        '</verifier_feedback>',
        '</attempt>',
      ].join('\n');
    }).join('\n\n');
  }

  _summarizeFailedProofPipeline(attempts = [], finalVerdict = '') {
    const attemptSummary = attempts.length
      ? attempts.map((attempt, i) => {
        const index = Number.isInteger(attempt.index) ? attempt.index : i;
        const tag = attempt.verdictTag || this._extractVerdictTag(attempt.verdict);
        return `attempt ${index} (${attempt.role || 'attempt'}): ${tag}`;
      }).join('; ')
      : 'no proof attempts were produced';

    const finalIssues = this._extractVerifierIssues(finalVerdict);
    const issueText = finalIssues.length
      ? finalIssues.join('\n')
      : this._truncateForPrompt(finalVerdict || 'No verifier feedback was returned.', 1200);

    return [
      'Proof effort pipeline did not reach verifier PASS.',
      `Attempt verdicts: ${attemptSummary}.`,
      'Blocking verifier feedback:',
      issueText,
    ].join('\n');
  }

  _blockedProof(reason) {
    const comment = String(reason || 'Proof effort pipeline could not certify this proof.')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map(line => `% ${line.replace(/%/g, '\\%')}`)
      .join('\n');

    return [
      '\\begin{proof}',
      '% [FERMAT BLOCKED] This proof was not inserted as a certified argument.',
      comment || '% Proof effort pipeline could not certify this proof.',
      '\\end{proof}',
    ].join('\n');
  }

  _isBlockedProof(proof) {
    return /\[FERMAT BLOCKED(?:\]|:|\s)/i.test(String(proof || ''));
  }

  _normalizeVerdictForProof(verdictTag, proof) {
    const tag = this._extractVerdictTag(`<verdict>${verdictTag || ''}</verdict>`);
    if (tag === 'PASS' && this._isBlockedProof(proof)) {
      return 'NEEDS_REVISION';
    }
    return tag;
  }

  _extractVerifierIssues(verdict) {
    const body = String(verdict || '');
    const issuesMatch = body.match(/<issues>\s*([\s\S]*?)\s*<\/issues>/i);
    if (!issuesMatch) return [];
    return issuesMatch[1]
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^[-*]\s+/.test(line))
      .slice(0, 8);
  }

  _extractTagText(text, tagName) {
    const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
    const match = String(text || '').match(pattern);
    return match ? match[1].trim().toLowerCase() : '';
  }

  _maxAttemptDirectives(width, stageIndex, schedulerDecision = null) {
    const lateStage = stageIndex > 1
      ? 'Use verifier feedback and discarded routes from earlier stages to avoid repeating failed arguments.'
      : 'Treat this as the first broad search stage.';
    const schedulerFocus = this._formatSchedulerFocusForPrompt(schedulerDecision);
    return [
      {
        role: 'primary',
        instruction: `Write the strongest complete proof following the current notebook. ${lateStage}\n${schedulerFocus}`,
      },
      {
        role: 'obligation-first',
        instruction: `Start with the selected scheduler obligations. Turn every nontrivial dependency into an explicit internal claim, then prove those claims before using them.\n${schedulerFocus}`,
      },
      {
        role: 'adversarial-repair',
        instruction: `Assume the obvious proof is wrong. Search for hidden cases, circularity, and condition mismatches in the selected obligations and routes, then write only the repaired argument.\n${schedulerFocus}`,
      },
      {
        role: 'alternate-route',
        instruction: `Try a materially different selected or candidate route from the current primary strategy while respecting all discarded routes and use policies.\n${schedulerFocus}`,
      },
      {
        role: 'sublemma-extractor',
        instruction: `Focus on the smallest selected obligation or missing sublemma that would make the target proof go through; prove it inline when short, otherwise mark it as a sublemma obligation.\n${schedulerFocus}`,
      },
    ].slice(0, width);
  }

  _formatSchedulerFocusForPrompt(schedulerDecision) {
    if (!schedulerDecision) {
      return 'Scheduler focus: unavailable. Follow the current notebook and preserve all use-policy constraints.';
    }
    const obligations = (schedulerDecision.selectedObligations || [])
      .slice(0, 5)
      .map((item, index) => [
        `${index + 1}. ${this._truncateForPrompt(item.statement || '', 500)}`,
        `tier=${item.tier || 'unknown'}`,
        `use_policy=${item.usePolicy || 'research_before_use'}`,
        `confidence=${item.confidence || 'medium'}`,
        item.neededFor ? `needed_for=${this._truncateForPrompt(item.neededFor, 160)}` : '',
      ].filter(Boolean).join(' | '));
    const routes = (schedulerDecision.selectedRoutes || [])
      .slice(0, 3)
      .map((item, index) => [
        `${index + 1}. ${this._truncateForPrompt(item.idea || '', 300)}`,
        `confidence=${item.confidence || 'medium'}`,
        `use_policy=${item.usePolicy || 'research_before_use'}`,
      ].join(' | '));
    return [
      `Scheduler focus: ${schedulerDecision.focus || 'route_search'}. ${schedulerDecision.rationale || ''}`,
      obligations.length ? `Selected obligations:\n${obligations.join('\n')}` : 'Selected obligations: none.',
      routes.length ? `Candidate routes:\n${routes.join('\n')}` : 'Candidate routes: none.',
    ].join('\n');
  }

  _boundedInt(value, fallback, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  _truncateForPrompt(text, maxChars) {
    const body = String(text || '').trim();
    if (body.length <= maxChars) return body;
    return `${body.slice(0, maxChars)}\n[FERMAT: truncated ${body.length - maxChars} chars]`;
  }

  _escapeXmlAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  recordAcceptedProof(label, statementTeX, proofTeX) {
    this.contextAssembler.recordAcceptedProof(label, statementTeX, proofTeX);
  }
}

module.exports = { ClaudeCodeBackend };
