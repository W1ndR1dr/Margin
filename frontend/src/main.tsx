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

/**
 * Dev-only debug handle.
 *
 * Exposed so the UI can be driven from the console and from the headless
 * capture script in tools/ (CLAUDE.md sanctions headless Chrome against
 * 127.0.0.1:5173 as the only allowed way to verify the interface). Stripped
 * from production builds by the `import.meta.env.DEV` guard.
 */
if (import.meta.env.DEV) {
  void Promise.all([
    import('./store/useAppStore'),
    import('./viewer/ViewerCore'),
    import('./labels/structureStore'),
    import('./tools/carotid'),
    import('./tools/airway'),
  ]).then(([store, core, labels, carotid, airway]) => {
    (window as unknown as Record<string, unknown>).__margin = {
      store: store.useAppStore,
      viewer: core.viewer,
      structures: labels.useStructureStore,
      quickAdd: labels.quickAdd,
      carotid: carotid.carotid,
      carotidStore: carotid.useCarotidStore,
      airway: airway.airway,
      airwayStore: airway.useAirwayStore,
    };
  });
}

// NOTE: no StrictMode. Its double-invoked effects tear down and rebuild the
// WebGL rendering engine on every mount, which Cornerstone3D does not enjoy.
/**
 * Keep one root across hot reloads. Vite re-executes this module when it or
 * anything it owns changes, and a second `createRoot` on the same container
 * warns and leaves two React trees fighting over the Cornerstone canvases.
 */
interface RootHolder {
  __marginRoot?: ReturnType<typeof createRoot>;
}
const holder = window as unknown as RootHolder;
const reactRoot = holder.__marginRoot ?? createRoot(root);
holder.__marginRoot = reactRoot;

reactRoot.render(
  <Boundary>
    <App />
  </Boundary>,
);
