import React, { useRef } from 'react';

/**
 * TabBar
 *
 * VS Code-style horizontal tab strip. Each tab shows the file name, a dirty
 * indicator (•), and a close button (×). The active tab is visually raised.
 *
 * Props:
 *   tabs       — array of { id, fileName, isDirty }
 *   activeTabId — id of the currently-active tab
 *   onSelect(tabId)  — called when the user clicks a tab
 *   onClose(tabId)   — called when the user clicks the × button
 */
export default function TabBar({ tabs, activeTabId, onSelect, onClose }) {
  const stripRef = useRef(null);

  // Horizontal scroll with the mouse wheel (no horizontal scrollbar shown)
  const handleWheel = (e) => {
    if (stripRef.current) {
      e.preventDefault();
      stripRef.current.scrollLeft += e.deltaY;
    }
  };

  return (
    <div
      ref={stripRef}
      onWheel={handleWheel}
      style={{
        display: 'flex',
        background: 'var(--bg-ink)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        height: 34,
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none', // Firefox
        msOverflowStyle: 'none', // IE/Edge
      }}
    >
      {tabs.map(tab => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            title={tab.fileName}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '0 10px 0 14px',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'var(--font-sans)',
              maxWidth: 200,
              minWidth: 90,
              flexShrink: 0,
              background: isActive ? 'var(--bg-primary)' : 'transparent',
              borderRight: '1px solid var(--border)',
              borderTop: isActive ? '1px solid var(--accent-soft)' : '1px solid transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              position: 'relative',
              userSelect: 'none',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              transition: 'color 0.12s',
            }}
          >
            {/* Dirty dot */}
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: tab.isDirty ? 'var(--accent)' : 'transparent',
              flexShrink: 0,
              transition: 'background 0.15s',
            }} />
            {/* File name */}
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
              letterSpacing: '0.01em',
            }}>
              {tab.fileName}
            </span>
            {/* Close button */}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              title="Close tab"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-faint)',
                padding: '1px 3px',
                fontSize: 13,
                lineHeight: 1,
                flexShrink: 0,
                borderRadius: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: isActive ? 1 : 0,
                transition: 'opacity 0.12s, background 0.1s, color 0.1s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.opacity = '1';
                e.currentTarget.style.background = 'var(--bg-active)';
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.opacity = isActive ? '1' : '0';
                e.currentTarget.style.background = 'none';
                e.currentTarget.style.color = 'var(--text-faint)';
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
