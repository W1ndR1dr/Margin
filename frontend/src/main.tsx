import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[hnrad] fatal', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeContent: 'center',
          justifyItems: 'center',
          gap: 14,
          padding: 40,
          textAlign: 'center',
          background: '#0a0c10',
          color: '#e9edf2',
          fontFamily: "'Instrument Sans', system-ui, sans-serif",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 19 }}>HNRad hit an unexpected error</h2>
        <pre
          style={{
            maxWidth: 680,
            whiteSpace: 'pre-wrap',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: '#ff9a7a',
            background: '#11151b',
            border: '1px solid rgba(255,255,255,.09)',
            borderRadius: 8,
            padding: 14,
            textAlign: 'left',
            userSelect: 'text',
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            height: 30,
            padding: '0 14px',
            borderRadius: 5,
            border: '1px solid rgba(255,138,61,.5)',
            background: '#ff8a3d',
            color: '#190c03',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// NOTE: no StrictMode. Its double-invoked effects tear down and rebuild the
// WebGL rendering engine on every mount, which Cornerstone3D does not enjoy.
createRoot(root).render(
  <Boundary>
    <App />
  </Boundary>,
);
