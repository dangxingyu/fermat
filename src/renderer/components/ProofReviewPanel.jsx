import React, { useState } from 'react';

/**
 * Proof Review Panel — shows AI-generated proofs for Medium/Hard markers.
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
            Medium and Hard proofs will appear here for review before being inserted.
          </div>
        )}
      </div>
    </div>
  );
}

function ProofCard({ review, onAccept, onReject }) {
  const [editing, setEditing] = useState(false);
  const [editedProof, setEditedProof] = useState(review.proof);

  const handleAccept = () => {
    onAccept(review.taskId, editing ? editedProof : review.proof);
  };

  return (
    <div className="proof-card">
      <div className="proof-card-header">
        <span>{review.marker?.label || 'Proof'}</span>
        <span className={`difficulty ${review.marker?.difficulty}`}>
          {review.marker?.difficulty}
        </span>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        Model: {review.model || 'claude'} &middot; Line {review.marker?.lineNumber}
      </div>

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
        <button className="btn-reject" onClick={() => onReject(review.taskId)}>
          Reject
        </button>
      </div>
    </div>
  );
}
