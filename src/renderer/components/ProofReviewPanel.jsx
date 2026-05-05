import { useState, useEffect } from 'react';

/**
 * Proof Review Panel — shows AI-generated proofs for medium/high/max effort markers.
 * User can accept (inserts into doc), reject, or edit before accepting.
 */
export default function ProofReviewPanel({ reviews, onAccept, onReject }) {
  return (
    <div className="proof-review-panel">
      <div className="proof-review-header">
        <span>Proof Review ({reviews.length})</span>
      </div>
      <div className="proof-review-content">
        {reviews.map((review) => (
          <ProofCard
            key={review.taskId}
            review={review}
            onAccept={onAccept}
            onReject={onReject}
          />
        ))}
        {reviews.length === 0 && (
          <div style={{
            padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12,
          }}>
            No proofs to review.
            <br /><br />
            Proofs that are not auto-inlined will appear here for review before insertion.
          </div>
        )}
      </div>
    </div>
  );
}

function ProofCard({ review, onAccept, onReject }) {
  const [editing, setEditing] = useState(false);
  const [editedProof, setEditedProof] = useState(review.proof);
  // B-13: when the same card is re-rendered with a new `review.proof`
  // (e.g. after a resubmit), useState's initialiser doesn't re-run, so the
  // edited buffer gets stuck on the stale value. Sync the buffer when the
  // incoming proof changes AND the user isn't in the middle of an edit.
  useEffect(() => {
    if (!editing) setEditedProof(review.proof);
  }, [review.taskId, review.proof, editing]);

  // Copy the currently displayed proof to clipboard (U-06)
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const text = editing ? editedProof : review.proof;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('[ProofCard] Copy failed:', err?.message);
    }
  };

  const handleAccept = () => {
    onAccept(review.taskId, editing ? editedProof : review.proof);
  };

  return (
    <div className="proof-card">
      <div className="proof-card-header">
        <span>{review.marker?.label || 'Proof'}</span>
        <span className={`effort ${review.marker?.effort || 'medium'}`}>
          {review.marker?.effort || 'medium'}
        </span>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        Model: {review.model || 'claude'} &middot; Line {review.marker?.lineNumber}
      </div>

      {(review.maxPipeline || review.proofPipeline || review.proofNotebook) && (
        <EffortPipelineNotes review={review} />
      )}

      {editing ? (
        <textarea
          value={editedProof}
          onChange={(e) => setEditedProof(e.target.value)}
          style={{
            width: '100%',
            minHeight: 200,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.5,
            background: 'var(--bg-primary)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            padding: 10,
            resize: 'vertical',
          }}
        />
      ) : (
        <pre>{review.proof}</pre>
      )}

      <div className="proof-card-actions">
        <button className="btn-accept" onClick={handleAccept}>
          Accept
        </button>
        <button className="btn-edit" onClick={() => setEditing(!editing)}>
          {editing ? 'Preview' : 'Edit'}
        </button>
        <button className="btn-copy" onClick={handleCopy} title="Copy proof to clipboard">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button className="btn-reject" onClick={() => onReject(review.taskId)}>
          Reject
        </button>
      </div>
    </div>
  );
}

function EffortPipelineNotes({ review }) {
  const pipeline = review.maxPipeline || review.proofPipeline || {};
  const attempts = Array.isArray(pipeline.attempts) ? pipeline.attempts : [];
  const sourceCards = Array.isArray(pipeline.sourceCards) ? pipeline.sourceCards : [];
  const partialResults = Array.isArray(pipeline.partialResults) ? pipeline.partialResults : [];
  const ledgerProposals = Array.isArray(pipeline.ledgerProposals) ? pipeline.ledgerProposals : [];
  const notebook = review.proofNotebook || pipeline.notebook || '';
  const notebookStatus = extractTag(notebook, 'status') || 'unknown';
  const notebookSummary = extractTag(notebook, 'summary');
  const finalVerdict = extractVerdictTag(pipeline.finalVerdict || review.verdict);
  const finalStatus = pipeline.finalStatus || (finalVerdict === 'PASS' ? 'proved' : 'pending');
  const selected = pipeline.selectedAttempt === 'repair'
    ? 'repair pass'
    : Number.isInteger(pipeline.selectedAttempt)
    ? `selected ${pipeline.selectedAttempt}`
    : 'no selected pass';

  return (
    <details className="proof-pipeline-notes">
      <summary>
        <span>{pipeline.mode === 'max-long-range' ? 'Max pipeline' : 'Proof pipeline'}</span>
        <span>{attempts.length} drafts &middot; {finalStatus} &middot; {selected}</span>
      </summary>
      <div className="proof-pipeline-body">
        <div className="proof-pipeline-row">
          <span>Notebook</span>
          <span>{notebookStatus}</span>
        </div>
        {notebookSummary && (
          <p>{notebookSummary}</p>
        )}
        {attempts.length > 0 && (
          <div className="proof-attempt-list">
            {attempts.map((attempt, index) => (
              <div className="proof-attempt-row" key={`${attempt.role || 'attempt'}-${attempt.index ?? index}`}>
                <span>{attempt.role || `attempt ${index + 1}`}</span>
                <span>{attempt.verdictTag || extractVerdictTag(attempt.verdict)}</span>
              </div>
            ))}
          </div>
        )}
        {pipeline.repairNotebook && (
          <div className="proof-pipeline-row">
            <span>Repair pass</span>
            <span>{extractTag(pipeline.repairNotebook, 'status') || 'ran'}</span>
          </div>
        )}
        {(review.research || pipeline.research) && (
          <div className="proof-pipeline-row">
            <span>Research pass</span>
            <span>{extractResearchSignal(review.research || pipeline.research)}</span>
          </div>
        )}
        {sourceCards.length > 0 && (
          <ResearchList
            title="Source cards"
            items={sourceCards}
            renderItem={(item) => (
              <>
                <span>{item.title || item.id}</span>
                <span>{item.sourceType || 'source'} · {item.reviewStatus || 'candidate'} · {item.extractedClaimCount || 0} claims</span>
              </>
            )}
          />
        )}
        {partialResults.length > 0 && (
          <ResearchList
            title="Verified partials"
            items={partialResults}
            renderItem={(item) => (
              <>
                <span>{item.statement || item.id}</span>
                <span>{item.source || 'run_verified'}</span>
              </>
            )}
          />
        )}
        {ledgerProposals.length > 0 && (
          <LedgerProposalList proposals={ledgerProposals} filePath={review.marker?.filePath} />
        )}
      </div>
    </details>
  );
}

function ResearchList({ title, items, renderItem }) {
  return (
    <div className="proof-research-list">
      <div className="proof-research-title">{title}</div>
      {items.map((item, index) => (
        <div className="proof-research-row" key={item.id || index}>
          {renderItem(item)}
        </div>
      ))}
    </div>
  );
}

function LedgerProposalList({ proposals, filePath }) {
  const [accepted, setAccepted] = useState(new Set());
  const handleAccept = async (proposalId) => {
    if (!window.api?.ledger?.acceptProposal || !filePath) return;
    await window.api.ledger.acceptProposal({ filePath, proposalId });
    setAccepted(prev => new Set([...prev, proposalId]));
  };

  return (
    <div className="proof-research-list">
      <div className="proof-research-title">Ledger proposals</div>
      {proposals.map((proposal) => (
        <div className="proof-research-row ledger" key={proposal.id}>
          <span>{proposal.statement || proposal.id}</span>
          <span>{proposal.tier} · {proposal.usePolicy}</span>
          <button
            type="button"
            disabled={!filePath || accepted.has(proposal.id) || proposal.status === 'accepted'}
            onClick={() => handleAccept(proposal.id)}
          >
            {accepted.has(proposal.id) || proposal.status === 'accepted' ? 'Accepted' : 'Accept'}
          </button>
        </div>
      ))}
    </div>
  );
}

function extractTag(text, tagName) {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function extractVerdictTag(text) {
  const match = String(text || '').match(/<verdict>\s*(PASS|NEEDS_REVISION|FAIL)\s*<\/verdict>/i) ||
    String(text || '').match(/<verdict>\s*(PASS|NEEDS_REVISION|FAIL)\b/i);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function extractResearchSignal(text) {
  const body = String(text || '');
  if (/<source_backed_facts>\s*<fact\b/i.test(body)) return 'source-backed facts';
  if (/<open_questions>\s*<question\b/i.test(body)) return 'open questions';
  return 'reviewed';
}
