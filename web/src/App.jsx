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

  const active = opsState.ops.filter((o) => ['running', 'queued', 'cancelling'].includes(o.state));
  // Running first — with a parallel pool the backlog can be long, so only the
  // in-flight ops plus a few upcoming ones are listed.
  const running = [...active].sort((a, b) => (a.state === 'queued' ? 1 : 0) - (b.state === 'queued' ? 1 : 0));
  const nowRunning = active.filter((o) => o.state === 'running').length;
  const waiting = active.filter((o) => o.state === 'queued').length;
  const LIST_CAP = 12;
  const shown = running.slice(0, LIST_CAP);

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
            <NavLink to="/companies">
              <span className="glyph">04</span> Companies
            </NavLink>
            <NavLink to="/profile">
              <span className="glyph">05</span> Profile
            </NavLink>
            <NavLink to="/settings">
              <span className="glyph">06</span> Settings
            </NavLink>
          </nav>
          <div className="foot">
            {active.length > 0 && (
              <div className="live-ops">
                <div className="queue-head">
                  <span>{nowRunning} running</span>
                  {waiting > 0 && <span>{waiting} queued</span>}
                </div>
                {shown.map((o) => (
                  <div className="row" key={o.key}>
                    {o.state === 'queued' ? <span className="queue-dot" /> : <span className="spinner" />}
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
                {active.length > shown.length && <div className="row more">+{active.length - shown.length} more…</div>}
                {waiting > 0 && (
                  <button className="queue-clear" onClick={() => apiPost('/ops/cancel-queued').catch(() => {})}>
                    Cancel {waiting} queued
                  </button>
                )}
              </div>
            )}
            <button className="btn small theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
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
