import { useState, useCallback, useRef } from 'react';

// Import the parser for browser-side use (when Electron IPC not available)
import { parseTheoryOutlineBrowser } from '../utils/outline-parser-browser';

/**
 * Hook for managing the theory outline.
 * Uses IPC in Electron, falls back to browser-side parsing in dev.
 */
export function useOutline(content) {
  const [outline, setOutline] = useState({ nodes: [], edges: [] });
  const contentRef = useRef(content);
  contentRef.current = content;

  const refreshOutline = useCallback(async () => {
    const currentContent = contentRef.current;
    if (!currentContent) {
      setOutline({ nodes: [], edges: [] });
      return;
    }

    try {
      if (window.api?.outline) {
        const result = await window.api.outline.parse(currentContent);
        setOutline(result);
      } else {
        // Browser fallback
        const result = parseTheoryOutlineBrowser(currentContent);
        setOutline(result);
      }
    } catch (err) {
      console.error('Outline parse error:', err);
    }
  }, []);

  return { outline, refreshOutline };
}
