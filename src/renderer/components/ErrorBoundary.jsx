import React from 'react';

/**
 * Error boundary — catches React rendering errors and shows a fallback
 * instead of a blank page.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Fermat ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 40,
          fontFamily: "'JetBrains Mono', monospace",
          background: '#1e1e2e',
          color: '#cdd6f4',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>∎</div>
          <h1 style={{ fontSize: 18, marginBottom: 12, color: '#f38ba8' }}>
            Fermat encountered an error
          </h1>
          <pre style={{
            fontSize: 12,
            background: '#181825',
            padding: 16,
            borderRadius: 8,
            maxWidth: 600,
            overflow: 'auto',
            color: '#a6adc8',
            border: '1px solid #45475a',
          }}>
            {this.state.error?.message || 'Unknown error'}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 20,
              padding: '8px 20px',
              background: '#89b4fa',
              color: '#1e1e2e',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
