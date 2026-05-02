import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotateOutlineWithAudit } from '../utils/outline-audit-browser';

function localHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function hasAuditableNodes(outline) {
  return !!outline?.nodes?.some(node => node.type !== 'section');
}

export function useOutlineAudit({ content, filePath, outline }) {
  const [audit, setAudit] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | waiting | loading | auditing | ready | stale | failed
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);
  const lastAttemptKeyRef = useRef('');
  const activeKeyRef = useRef('');
  const auditRef = useRef(null);

  const contentKey = useMemo(() => localHash(content), [content]);
  const canAudit = !!window.api?.outline?.audit &&
    !!filePath &&
    !!content &&
    hasAuditableNodes(outline);

  useEffect(() => {
    auditRef.current = audit;
  }, [audit]);

  useEffect(() => {
    let cancelled = false;

    if (!window.api?.outline?.loadAudit || !filePath) {
      setAudit(null);
      setStatus('idle');
      setError(null);
      return () => { cancelled = true; };
    }

    setStatus(prev => (prev === 'auditing' ? prev : 'loading'));
    window.api.outline.loadAudit({ filePath, content, outline })
      .then(result => {
        if (cancelled) return;
        if (result) {
          setAudit(result);
          setStatus(result.isStale ? 'stale' : 'ready');
        } else {
          setAudit(null);
          setStatus('idle');
        }
        setError(null);
      })
      .catch(err => {
        if (cancelled) return;
        setStatus('failed');
        setError(err?.message || 'Failed to load outline audit.');
      });

    return () => { cancelled = true; };
  }, [filePath]);

  const runAudit = useCallback(async ({ force = false } = {}) => {
    if (!canAudit) return null;

    const attemptKey = `${filePath}:${contentKey}`;
    if (!force && lastAttemptKeyRef.current === attemptKey) {
      return auditRef.current;
    }

    const requestId = ++requestIdRef.current;
    lastAttemptKeyRef.current = attemptKey;
    setStatus('auditing');
    setError(null);

    try {
      const result = await window.api.outline.audit({
        content,
        filePath,
        outline,
        force,
      });
      if (requestId !== requestIdRef.current || attemptKey !== activeKeyRef.current) return result;
      setAudit(result);
      setStatus(result?.isStale ? 'stale' : 'ready');
      return result;
    } catch (err) {
      if (requestId !== requestIdRef.current) return null;
      setStatus('failed');
      setError(err?.userMessage || err?.message || 'Outline audit failed.');
      return null;
    }
  }, [canAudit, content, contentKey, filePath, outline]);

  useEffect(() => {
    if (!canAudit) return undefined;

    activeKeyRef.current = `${filePath}:${contentKey}`;
    setStatus(prev => (prev === 'auditing' ? prev : 'waiting'));
    const timer = setTimeout(() => {
      runAudit();
    }, 2000);

    return () => clearTimeout(timer);
  }, [canAudit, contentKey, filePath, runAudit]);

  const annotatedOutline = useMemo(
    () => annotateOutlineWithAudit(outline, audit),
    [outline, audit],
  );

  const refreshAudit = useCallback(() => runAudit({ force: true }), [runAudit]);

  return {
    audit,
    annotatedOutline,
    auditStatus: status,
    auditError: error,
    refreshAudit,
  };
}
