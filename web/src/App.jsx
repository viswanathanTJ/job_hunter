import React, { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useOps, apiPost } from './api.js';

const OpsContext = createContext({ ops: [], pulse: 0 });
export const useOpsContext = () => useContext(OpsContext);

export default function App() {
  const opsState = useOps();
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('jobdash-theme', theme);
    } catch {}
  }, [theme]);

  const running = opsState.ops.filter((o) => ['running', 'queued', 'cancelling'].includes(o.state));

  return (
    <OpsContext.Provider value={opsState}>
      <div className="shell">
        <aside className="sidebar">
          <div>
            <div className="brand">
              <span className="diamond">◆</span>
              <span>
                Signal Desk
                <small>career-ops console</small>
              </span>
            </div>
          </div>
          <nav className="nav">
            <NavLink to="/" end>
              <span className="glyph">01</span> Dashboard
            </NavLink>
            <NavLink to="/jobs">
              <span className="glyph">02</span> Jobs
            </NavLink>
            <NavLink to="/pipeline">
              <span className="glyph">03</span> Pipeline
            </NavLink>
            <NavLink to="/settings">
              <span className="glyph">04</span> Settings
            </NavLink>
          </nav>
          <div className="foot">
            {running.length > 0 && (
              <div className="live-ops">
                {running.map((o) => (
                  <div className="row" key={o.key}>
                    <span className="spinner" />
                    <span style={{ flex: 1 }}>
                      {o.state === 'cancelling'
                        ? 'STOPPING…'
                        : o.type === 'fetch'
                          ? 'FETCHING JOBS'
                          : `${o.state === 'queued' ? 'QUEUED ' : ''}${o.type.toUpperCase()} · ${o.company || o.jobId}`}
                    </span>
                    {o.type !== 'fetch' && o.state !== 'cancelling' && (
                      <button className="op-x" title="Stop" onClick={() => apiPost('/ops/cancel', { key: o.key }).catch(() => {})}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <button
              className="btn small theme-toggle"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="Toggle theme"
            >
              {theme === 'dark' ? '☀ Light' : '● Dark'}
            </button>
          </div>
        </aside>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </OpsContext.Provider>
  );
}
