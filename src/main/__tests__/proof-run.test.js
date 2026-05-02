import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendProofRunEvent,
  buildSchedulerDecision,
  createProofRun,
  formatSchedulerDecisionForPrompt,
  parseBlocks,
  persistProofRunArtifacts,
  selectOpenObligations,
  targetKey,
} from '../proof-run.js';

describe('proof-run event log and obligation graph', () => {
  it('extracts proof-plan obligations into a stable obligation graph', () => {
    const run = createProofRun({
      runId: 'run-1',
      target: { id: 'n1', type: 'theorem', name: 'Target', labels: ['thm:target'], lineNumber: 7 },
      config: { effort: 'max' },
    });

    appendProofRunEvent(run, 'plan.completed', {
      text: [
        '<proof_plan>',
        '  <proof_obligations>',
        '    <obligation id="obl-1" tier="T2_ALMOST_SURE" use_policy="prove_inline" confidence="high">',
        '      <statement>Every integer greater than 1 has a prime divisor.</statement>',
        '      <needed_for>Euclid proof</needed_for>',
        '      <proof_strategy>Use minimal counterexample.</proof_strategy>',
        '    </obligation>',
        '  </proof_obligations>',
        '</proof_plan>',
      ].join('\n'),
    });

    const obligations = Object.values(run.obligationGraph.obligations);
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      statement: 'Every integer greater than 1 has a prime divisor.',
      tier: 'T2_ALMOST_SURE',
      usePolicy: 'prove_inline',
      confidence: 'high',
      neededFor: 'Euclid proof',
      status: 'open',
    });
    expect(obligations[0].provenance[0]).toMatchObject({
      sourceType: 'proof_plan',
      sourceId: '2-plan.completed',
    });
  });

  it('selects scheduler obligations by use policy and confidence', () => {
    const run = createProofRun({
      runId: 'run-schedule',
      target: { id: 'n-schedule', type: 'theorem', name: 'Target' },
      config: { effort: 'max' },
    });

    appendProofRunEvent(run, 'plan.completed', {
      text: [
        '<proof_plan>',
        '  <obligation id="research" use_policy="research_before_use" confidence="high">',
        '    <statement>A source-backed extremal estimate is available.</statement>',
        '  </obligation>',
        '  <obligation id="inline" use_policy="prove_inline" confidence="medium">',
        '    <statement>Every maximal counterexample has a minimal bad subconfiguration.</statement>',
        '    <needed_for>counterexample descent</needed_for>',
        '    <proof_hint>Choose a counterexample of minimal size.</proof_hint>',
        '  </obligation>',
        '</proof_plan>',
      ].join('\n'),
    });

    const selected = selectOpenObligations(run.obligationGraph, { limit: 2 });
    expect(selected[0]).toMatchObject({
      statement: 'Every maximal counterexample has a minimal bad subconfiguration.',
      usePolicy: 'prove_inline',
    });

    const decision = buildSchedulerDecision(run.obligationGraph, { stage: 1, width: 2 });
    expect(decision.focus).toBe('prove_obligations');
    expect(decision.selectedObligations[0].statement).toContain('minimal bad subconfiguration');

    const formatted = formatSchedulerDecisionForPrompt(decision);
    expect(formatted).toContain('<scheduler_decision stage="1" focus="prove_obligations"');
    expect(formatted).toContain('<needed_for>counterexample descent</needed_for>');

    appendProofRunEvent(run, 'scheduler.decision', { stage: 1, decision });
    expect(run.obligationGraph.lastSchedulerDecision.focus).toBe('prove_obligations');

    appendProofRunEvent(run, 'attempt.completed', {
      stage: 1,
      index: 0,
      role: 'obligation-first',
      proof: '\\begin{proof}draft\\end{proof}',
      selectedObligationIds: [selected[0].id],
    });
    expect(run.obligationGraph.obligations[selected[0].id].status).toBe('pending_verification');
    expect(run.obligationGraph.obligations[selected[0].id].attempts[0]).toBe('attempt:1:0:obligation-first');

    appendProofRunEvent(run, 'verification.completed', {
      stage: 1,
      index: 0,
      role: 'obligation-first',
      verdictTag: 'FAIL',
      verdict: '<verdict>FAIL</verdict>',
    });
    expect(run.obligationGraph.obligations[selected[0].id].status).toBe('open');
  });

  it('requests research when all selected obligations need source support', () => {
    const run = createProofRun({
      runId: 'run-research-schedule',
      target: { id: 'n-research', type: 'conjecture', name: 'Target' },
      config: { effort: 'max' },
    });

    appendProofRunEvent(run, 'plan.completed', {
      text: [
        '<proof_plan>',
        '  <obligation id="source-needed" use_policy="research_before_use" confidence="high">',
        '    <statement>A published density increment lemma applies in this regime.</statement>',
        '  </obligation>',
        '</proof_plan>',
      ].join('\n'),
    });

    const decision = buildSchedulerDecision(run.obligationGraph, { stage: 1, width: 2 });

    expect(decision.focus).toBe('research');
    expect(decision.selectedObligations[0]).toMatchObject({
      statement: 'A published density increment lemma applies in this regime.',
      usePolicy: 'research_before_use',
    });
  });

  it('updates graph status from notebooks and records verifier verdicts', () => {
    const run = createProofRun({
      runId: 'run-2',
      target: { id: 'n2', type: 'conjecture', name: 'Open target', labels: ['erdos:1'] },
      config: { effort: 'max' },
    });

    appendProofRunEvent(run, 'notebook.updated', {
      text: [
        '<proof_notebook>',
        '  <status>blocked</status>',
        '  <candidate_routes>',
        '    <route id="route-a" confidence="medium">',
        '      <idea>Try a Fourier flatness inequality.</idea>',
        '      <main_risk>No such inequality is known.</main_risk>',
        '    </route>',
        '  </candidate_routes>',
        '</proof_notebook>',
      ].join('\n'),
    });
    appendProofRunEvent(run, 'attempt.completed', {
      stage: 1,
      index: 0,
      role: 'primary',
      proof: '\\begin{proof}x\\end{proof}',
    });
    appendProofRunEvent(run, 'verification.completed', {
      stage: 1,
      index: 0,
      role: 'primary',
      verdictTag: 'FAIL',
      verdict: '<verdict>FAIL</verdict><issues>\n- [critical] unsupported fact\n</issues>',
    });

    expect(run.obligationGraph.status).toBe('blocked');
    expect(Object.values(run.obligationGraph.routes)[0]).toMatchObject({
      idea: 'Try a Fourier flatness inequality.',
      mainRisk: 'No such inequality is known.',
      status: 'candidate',
    });
    expect(Object.values(run.obligationGraph.attempts)[0]).toMatchObject({
      stage: 1,
      index: 0,
      role: 'primary',
      status: 'drafted',
    });
    expect(Object.values(run.obligationGraph.verdicts)[0]).toMatchObject({
      verdictTag: 'FAIL',
      issues: ['- [critical] unsupported fact'],
    });
  });

  it('persists run and target obligation graph side by side', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fermat-proof-run-'));
    const fermatDir = path.join(root, '.fermat');
    const run = createProofRun({
      runId: 'run-persist',
      target: { id: 'n3', type: 'theorem', name: 'Target', labels: ['thm:persist'] },
      config: { effort: 'max' },
    });

    const paths = persistProofRunArtifacts(run, fermatDir);

    expect(paths.runPath).toBe(path.join(fermatDir, 'runs', 'run-persist.json'));
    expect(paths.graphPath).toBe(path.join(fermatDir, 'obligations', 'thm-persist.json'));
    expect(JSON.parse(fs.readFileSync(paths.runPath, 'utf-8')).events[0].type).toBe('run.started');
    expect(JSON.parse(fs.readFileSync(paths.graphPath, 'utf-8')).target.labels).toEqual(['thm:persist']);
    expect(targetKey({ labels: ['thm:persist'] })).toBe('thm-persist');
  });

  it('parses simple XML-style blocks with attributes', () => {
    const blocks = parseBlocks('<obligation id="o1" confidence="low"><statement>S</statement></obligation>', 'obligation');
    expect(blocks).toEqual([{
      attrs: { id: 'o1', confidence: 'low' },
      body: '<statement>S</statement>',
    }]);
  });
});
