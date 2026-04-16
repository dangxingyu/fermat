import React, { useState, useCallback, useEffect } from 'react';

/**
 * Hook for interacting with the Fermat engine.
 * Manages proof task state, handles events from the main process.
 */
export function useCopilot({ onAutoInline } = {}) {
  const [proofTasks, setProofTasks] = useState(new Map());
  const [pendingReviews, setPendingReviews] = useState([]);
  const [copilotStatus, setCopilotStatus] = useState({ running: 0, queued: 0, completed: 0 });
  // Structured API errors shown as toasts. Each entry: { id, code, userMessage, marker }
  const [proofErrors, setProofErrors] = useState([]);

  // Keep the callback fresh across renders without re-subscribing IPC.
  const onAutoInlineRef = React.useRef(onAutoInline);
  useEffect(() => { onAutoInlineRef.current = onAutoInline; }, [onAutoInline]);

  // Listen for copilot events from main process
  useEffect(() => {
    if (!window.api?.copilot) return;

    const onStarted = (data) => {
      setProofTasks(prev => {
        const next = new Map(prev);
        next.set(data.taskId, { ...data, status: 'running' });
        return next;
      });
      setCopilotStatus(prev => ({ ...prev, running: prev.running + 1 }));
    };

    const onCompleted = (data) => {
      setProofTasks(prev => {
        const next = new Map(prev);
        next.set(data.taskId, { ...data, status: 'completed' });
        return next;
      });
      setCopilotStatus(prev => ({
        ...prev,
        running: Math.max(0, prev.running - 1),
        completed: prev.completed + 1,
      }));

      // Auto-inline: insert the proof directly into the editor at the marker.
      // Otherwise, queue it for user review.
      if (data.autoInline && data.proof && onAutoInlineRef.current) {
        onAutoInlineRef.current(data);
      } else if (!data.autoInline) {
        setPendingReviews(prev => [...prev, data]);
      }
    };

    const onStatus = (data) => {
      setProofTasks(prev => {
        const next = new Map(prev);
        const existing = next.get(data.taskId) || {};
        next.set(data.taskId, { ...existing, ...data });
        return next;
      });
    };

    const onFailed = (data) => {
      setProofTasks(prev => {
        const next = new Map(prev);
        next.set(data.taskId, { ...data, status: 'failed' });
        return next;
      });
      setCopilotStatus(prev => ({ ...prev, running: Math.max(0, prev.running - 1) }));
      // Surface structured error as a toast (auto-dismiss after 12s for non-auth errors).
      const errorEntry = {
        id: data.taskId,
        code: data.code || 'UNKNOWN_ERROR',
        userMessage: data.userMessage || data.error || 'Proof failed.',
        marker: data.marker,
      };
      setProofErrors(prev => [...prev, errorEntry]);
      if (errorEntry.code !== 'AUTH_ERROR' && errorEntry.code !== 'NO_API_KEY') {
        setTimeout(() => {
          setProofErrors(prev => prev.filter(e => e.id !== errorEntry.id));
        }, 12000);
      }
    };

    const offStarted = window.api.copilot.onProofStarted(onStarted);
    const offCompleted = window.api.copilot.onProofCompleted(onCompleted);
    const offStatus = window.api.copilot.onProofStatus?.(onStatus);
    const offFailed = window.api.copilot.onProofFailed(onFailed);

    // Cleanup: remove IPC listeners on unmount
    return () => {
      offStarted?.();
      offCompleted?.();
      offStatus?.();
      offFailed?.();
    };
  }, []);

  const submitMarker = useCallback(async (marker) => {
    if (!window.api?.copilot) {
      // Dev mode — simulate
      console.log('[Dev] Would submit proof request:', marker);
      const taskId = `dev_${Date.now()}`;
      setProofTasks(prev => {
        const next = new Map(prev);
        next.set(taskId, { taskId, marker, status: 'running' });
        return next;
      });
      setCopilotStatus(prev => ({ ...prev, running: prev.running + 1 }));

      // Simulate completion after 2s
      setTimeout(() => {
        const fakeProof = `\\begin{proof}\nThis follows directly from the definitions. [Simulated proof in dev mode]\n\\end{proof}`;
        const autoInline = marker.difficulty === 'Easy';
        setProofTasks(prev => {
          const next = new Map(prev);
          next.set(taskId, { taskId, marker, status: 'completed', proof: fakeProof });
          return next;
        });
        setCopilotStatus(prev => ({
          ...prev,
          running: Math.max(0, prev.running - 1),
          completed: prev.completed + 1,
        }));
        const completedData = { taskId, marker, proof: fakeProof, autoInline };
        if (autoInline && onAutoInlineRef.current) {
          onAutoInlineRef.current(completedData);
        } else {
          setPendingReviews(prev => [...prev, completedData]);
        }
      }, 2000);

      return;
    }
    return window.api.copilot.submitProof(marker);
  }, []);

  const dismissError = useCallback((id) => {
    setProofErrors(prev => prev.filter(e => e.id !== id));
  }, []);

  const acceptProof = useCallback((taskId) => {
    setPendingReviews(prev => prev.filter(r => r.taskId !== taskId));
  }, []);

  const rejectProof = useCallback((taskId) => {
    setPendingReviews(prev => prev.filter(r => r.taskId !== taskId));
    if (window.api?.copilot) {
      window.api.copilot.cancelProof(taskId);
    }
  }, []);

  return {
    proofTasks,
    pendingReviews,
    submitMarker,
    acceptProof,
    rejectProof,
    copilotStatus,
    proofErrors,
    dismissError,
  };
}
