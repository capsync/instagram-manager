import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';

// Everything shown here comes from the existing API (accounts, posts, autopilot). Nothing is estimated or made up.
const STATUS = {
  draft:      { color: 'var(--muted)', label: 'Draft' },
  publishing: { color: 'var(--info)',  label: 'Publishing' },
  scheduled:  { color: 'var(--warn)',  label: 'Scheduled' },
  posted:     { color: 'var(--ok)',    label: 'Posted' },
  failed:     { color: 'var(--err)',   label: 'Failed' },
};

let cache = null;   // last result, so coming back to Home is instant

const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const snippet = (p) => String(p.final_caption || p.generated_caption || p.original_caption || '').replace(/\s+/g, ' ').trim().slice(0, 70);

function Chip({ status }) {
  const st = STATUS[status] || STATUS.draft;
  return <span style={{ fontSize: 11, fontWeight: 700, color: st.color, border: `1px solid ${st.color}`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>{st.label}</span>;
}

function Stat({ label, value, color, onClick }) {
  return (
    <button type="button" className="dash-card" onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', minHeight: 76 }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || 'var(--text)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{label}</div>
    </button>
  );
}

function Section({ title, action, children }) {
  return (
    <section style={{ marginTop: 20 }}>
      <div className="dash-row" style={{ marginBottom: 6 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function Dashboard({ onNavigate }) {
  const [data, setData] = useState(cache);
  const [loading, setLoading] = useState(!cache);
  const [errors, setErrors] = useState([]);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;            // no duplicate requests
    inflight.current = true;
    setLoading(true);
    const [acc, posts, ap] = await Promise.allSettled([api.getAccounts(), api.getPosts(), api.autopilot()]);
    const errs = [];
    const next = {
      accounts: acc.status === 'fulfilled' && Array.isArray(acc.value) ? acc.value : (errs.push('pages'), cache?.accounts || []),
      posts:    posts.status === 'fulfilled' && Array.isArray(posts.value) ? posts.value : (errs.push('posts'), cache?.posts || []),
      pages:    ap.status === 'fulfilled' && ap.value && Array.isArray(ap.value.pages) ? ap.value.pages : (errs.push('autopilot'), cache?.pages || []),
    };
    // Only remember a result that fully loaded
    if (!errs.length) cache = next;
    setData(next);
    setErrors(errs);
    setLoading(false);
    inflight.current = false;
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!data) {
    return <div>{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 84, marginBottom: 10 }} />)}</div>;
  }

  const { accounts, posts, pages } = data;
  const count = (st) => posts.filter(p => p.status === st).length;
  const failed = posts.filter(p => p.status === 'failed');
  const upcoming = posts.filter(p => p.status === 'scheduled' && p.scheduled_at).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)).slice(0, 3);
  const publishing = count('publishing');
  const apBusy = pages.reduce((n, p) => n + (p.queue?.processing || 0), 0);
  const apAttention = pages.filter(p => p.paused || (p.queue?.failed || 0) > 0);
  const recent = [...posts].sort((a, b) => new Date(b.posted_at || b.scheduled_at || b.created_at || 0) - new Date(a.posted_at || a.scheduled_at || a.created_at || 0)).slice(0, 5);
  const needsAttention = failed.length > 0 || apAttention.length > 0;

  return (
    <div style={{ color: 'var(--text)' }}>
      <div className="dash-row">
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Home</h1>
        <button type="button" className="dash-btn" onClick={load} disabled={loading} aria-label="Refresh">{loading ? 'Updating…' : 'Refresh'}</button>
      </div>

      {errors.length > 0 && (
        <div role="alert" className="dash-card" style={{ marginTop: 12, borderColor: 'var(--err)', color: 'var(--err)', fontSize: 13 }}>
          Could not load: {errors.join(', ')}. The numbers below may be out of date.
        </div>
      )}

      {accounts.length === 0 && !loading && !errors.includes('pages') ? (
        <div className="dash-card" style={{ marginTop: 14, textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Connect your first Instagram page</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 14px' }}>Add a page to start creating and scheduling posts.</div>
          <button type="button" className="dash-btn primary" onClick={() => onNavigate('accounts')}>Add a page</button>
        </div>
      ) : (
        <>
          <div className="dash-grid" style={{ marginTop: 14 }}>
            <Stat label="Instagram pages" value={accounts.length} onClick={() => onNavigate('accounts')} />
            <Stat label="Scheduled" value={count('scheduled')} color="var(--warn)" onClick={() => onNavigate('history')} />
            <Stat label="Posted" value={count('posted')} color="var(--ok)" onClick={() => onNavigate('history')} />
            <Stat label="Failed" value={failed.length} color={failed.length ? 'var(--err)' : 'var(--text)'} onClick={() => onNavigate('history')} />
          </div>

          {(publishing > 0 || apBusy > 0) && (
            <div className="dash-card" style={{ marginTop: 10, fontSize: 13, color: 'var(--info)' }}>
              {publishing > 0 && <div>{publishing} post{publishing > 1 ? 's' : ''} publishing now</div>}
              {apBusy > 0 && <div>{apBusy} Autopilot item{apBusy > 1 ? 's' : ''} processing</div>}
            </div>
          )}

          {needsAttention && (
            <Section title="Needs attention" action={<button type="button" className="dash-link" onClick={() => onNavigate('history')}>Open Posts</button>}>
              <div style={{ display: 'grid', gap: 8 }}>
                {failed.slice(0, 3).map(p => (
                  <div key={p.id} className="dash-card" style={{ borderColor: 'rgba(248,113,113,.4)' }}>
                    <div className="dash-row"><span className="dash-clip" style={{ fontWeight: 600, fontSize: 14 }}>{p.account_name || p.username || 'Post'}</span><Chip status="failed" /></div>
                    <div style={{ fontSize: 13, color: 'var(--err)', marginTop: 6, wordBreak: 'break-word' }}>{p.error_message || 'This post failed. Open it to try again.'}</div>
                  </div>
                ))}
                {failed.length > 3 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>+{failed.length - 3} more failed posts</div>}
                {apAttention.map(p => (
                  <button key={p.id} type="button" className="dash-card" onClick={() => onNavigate('autopilot')} style={{ textAlign: 'left', cursor: 'pointer', borderColor: 'rgba(245,158,11,.4)' }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.username || p.name} · Autopilot</div>
                    <div style={{ fontSize: 13, color: 'var(--warn)', marginTop: 4 }}>
                      {p.paused ? 'Paused. Tap to review and resume.' : `${p.queue.failed} queued item${p.queue.failed > 1 ? 's' : ''} failed.`}
                      {p.last_error ? ` ${String(p.last_error).slice(0, 90)}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </Section>
          )}

          {upcoming.length > 0 && (
            <Section title="Up next" action={<button type="button" className="dash-link" onClick={() => onNavigate('history')}>All posts</button>}>
              <div style={{ display: 'grid', gap: 8 }}>
                {upcoming.map(p => (
                  <div key={p.id} className="dash-card dash-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="dash-clip" style={{ fontSize: 14, fontWeight: 600 }}>{p.account_name || p.username || 'Post'}</div>
                      <div className="dash-clip" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{snippet(p) || 'No caption yet'}</div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--warn)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(p.scheduled_at)}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {pages.length > 0 && (
            <Section title="Autopilot" action={<button type="button" className="dash-link" onClick={() => onNavigate('autopilot')}>Manage</button>}>
              <div style={{ display: 'grid', gap: 8 }}>
                {pages.map(p => (
                  <div key={p.id} className="dash-card dash-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="dash-clip" style={{ fontSize: 14, fontWeight: 600 }}>{p.username || p.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                        Today {p.today?.posted ?? 0}/{p.today?.target ?? 0} · {p.queue?.queued ?? 0} queued
                      </div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: p.paused ? 'var(--warn)' : p.enabled ? 'var(--ok)' : 'var(--muted)' }}>
                      {p.paused ? 'Paused' : p.enabled ? 'On' : 'Off'}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {recent.length > 0 && (
            <Section title="Recent activity">
              <div style={{ display: 'grid', gap: 8 }}>
                {recent.map(p => (
                  <div key={p.id} className="dash-card dash-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="dash-clip" style={{ fontSize: 14, fontWeight: 600 }}>{p.account_name || p.username || 'Post'}</div>
                      <div className="dash-clip" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{snippet(p) || fmt(p.posted_at || p.scheduled_at || p.created_at)}</div>
                    </div>
                    <Chip status={p.status} />
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Quick actions">
            <div className="dash-grid">
              <button type="button" className="dash-btn primary" onClick={() => onNavigate('new')}>Create a post</button>
              <button type="button" className="dash-btn" onClick={() => onNavigate('multi')}>Post to many pages</button>
              <button type="button" className="dash-btn" onClick={() => onNavigate('history')}>All posts</button>
              <button type="button" className="dash-btn" onClick={() => onNavigate('accounts')}>Pages</button>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
