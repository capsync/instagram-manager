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
const TINT = { violet: '167,139,250', amber: '245,158,11', green: '16,185,129', red: '248,113,113' };

let cache = null;   // last result, so coming back to Home is instant
let cacheAt = 0;    // when it was loaded: fresh data is reused so switching tabs never re-downloads or flickers

const reduced = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const snippet = (p) => String(p.final_caption || p.generated_caption || p.original_caption || '').replace(/\s+/g, ' ').trim().slice(0, 70);
const firstName = () => { try { return String(JSON.parse(localStorage.getItem('im_user') || '{}').name || '').trim().split(/\s+/)[0]; } catch { return ''; } };
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const hue = (str) => { let h = 0; for (const c of String(str || '?')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

// Numbers count up once when they appear (skipped when the phone asks for reduced motion)
function CountUp({ value }) {
  const [n, setN] = useState(reduced() ? value : 0);
  useEffect(() => {
    if (reduced() || !value) { setN(value); return; }
    let raf = 0; const t0 = performance.now(), dur = 700;
    const tick = (t) => { const k = Math.min(1, (t - t0) / dur); setN(Math.round(value * (1 - Math.pow(1 - k, 3)))); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{n}</>;
}

function Ring({ done, target }) {
  const r = 17, c = 2 * Math.PI * r, frac = target > 0 ? Math.min(1, done / target) : 0;
  const [on, setOn] = useState(reduced());
  useEffect(() => { const id = setTimeout(() => setOn(true), 60); return () => clearTimeout(id); }, []);
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" role="img" aria-label={`${done} of ${target} posted today`}>
      <circle cx="22" cy="22" r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="5" />
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--ok)" strokeWidth="5" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={on ? c * (1 - frac) : c} transform="rotate(-90 22 22)" style={{ transition: 'stroke-dashoffset .9s cubic-bezier(.22,1,.36,1)' }} />
    </svg>
  );
}

function Avatar({ acct, size = 40 }) {
  const [bad, setBad] = useState(false);
  const src = acct.brand_avatar || acct.ig_avatar;
  const label = acct.username || acct.name || '?';
  if (src && !bad) return <img src={src} alt={label} width={size} height={size} loading="lazy" onError={() => setBad(true)} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', border: '2px solid rgba(255,255,255,.35)' }} />;
  return <div aria-label={label} style={{ width: size, height: size, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: '#fff', border: '2px solid rgba(255,255,255,.35)', background: `linear-gradient(135deg, hsl(${hue(label)} 70% 55%), hsl(${(hue(label) + 50) % 360} 70% 45%))` }}>{label.charAt(0).toUpperCase()}</div>;
}

function Chip({ status }) {
  const st = STATUS[status] || STATUS.draft;
  return <span style={{ fontSize: 11, fontWeight: 700, color: st.color, border: `1px solid ${st.color}`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>{st.label}</span>;
}

const ICONS = {
  pages: <path d="M4 5h16v14H4zM4 9h16" />,
  scheduled: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  posted: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  failed: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.2v.1" /></>,
};
function Stat({ label, value, tint, icon, onClick, delay }) {
  const t = TINT[tint];
  return (
    <button type="button" className="dash-card tilt fade-up" onClick={onClick}
      style={{ textAlign: 'left', cursor: 'pointer', minHeight: 84, animationDelay: `${delay}ms`, background: `linear-gradient(145deg, rgba(${t},.20), rgba(${t},.06))`, borderColor: `rgba(${t},.35)` }}>
      <div className="dash-row">
        <div style={{ fontSize: 28, fontWeight: 800, color: '#fff', lineHeight: 1.1 }}><CountUp value={value} /></div>
        <svg className="bob-slow" style={{ animationDelay: `${delay}ms` }} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={`rgb(${t})`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[icon]}</svg>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{label}</div>
    </button>
  );
}

function Section({ title, action, children, delay = 0 }) {
  return (
    <section className="fade-up" style={{ marginTop: 20, animationDelay: `${delay}ms` }}>
      <div className="dash-row" style={{ marginBottom: 6 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// Posts that went live in each of the last 7 days (real posted_at times)
function lastSevenDays(posts) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const end = new Date(d); end.setDate(end.getDate() + 1);
    const n = posts.filter(p => p.status === 'posted' && p.posted_at && new Date(p.posted_at) >= d && new Date(p.posted_at) < end).length;
    days.push({ label: d.toLocaleDateString([], { weekday: 'short' }), full: d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), n });
  }
  return days;
}

function Week({ posts }) {
  const days = lastSevenDays(posts);
  const max = Math.max(1, ...days.map(d => d.n));
  const total = days.reduce((a, d) => a + d.n, 0);
  const [sel, setSel] = useState(6);
  const [grown, setGrown] = useState(reduced());
  useEffect(() => { const id = setTimeout(() => setGrown(true), 80); return () => clearTimeout(id); }, []);
  return (
    <div className="dash-card tilt">
      <div style={{ height: 96, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        {days.map((d, i) => (
          <button key={i} type="button" className="bar-col" onClick={() => setSel(i)} aria-label={`${d.full}: ${d.n} posted`}>
            <div className="bar" style={{ height: grown ? `${Math.max(6, (d.n / max) * 62)}px` : '0px', background: i === sel ? 'linear-gradient(180deg, #E6356A, #A78BFA)' : 'rgba(167,139,250,.35)' }} />
            <span style={{ fontSize: 10, color: i === sel ? 'var(--text)' : 'var(--muted)' }}>{d.label}</span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 13, marginTop: 8, color: 'var(--muted)' }}>
        <strong style={{ color: 'var(--text)' }}>{days[sel].n} posted</strong> on {days[sel].full} · {total} in the last 7 days
      </div>
    </div>
  );
}

export default function Dashboard({ onNavigate }) {
  const [data, setData] = useState(cache);
  const [loading, setLoading] = useState(!cache);
  const [errors, setErrors] = useState([]);
  const inflight = useRef(false);

  const load = useCallback(async (force = true) => {
    if (!force && cache && Date.now() - cacheAt < 20000) return;   // fresh enough
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
    if (!errs.length) { cache = next; cacheAt = Date.now(); }   // only remember a result that fully loaded
    setData(next);
    setErrors(errs);
    setLoading(false);
    inflight.current = false;
  }, []);

  useEffect(() => { load(false); }, [load]);

  if (!data) {
    return <div>{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 84, marginBottom: 10 }} />)}</div>;
  }

  const { accounts, posts, pages } = data;
  const count = (st) => posts.filter(p => p.status === st).length;
  const failed = posts.filter(p => p.status === 'failed');
  const upcoming = posts.filter(p => p.status === 'scheduled' && p.scheduled_at).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)).slice(0, 3);
  const publishing = count('publishing');
  const scheduled = count('scheduled');
  const apBusy = pages.reduce((n, p) => n + (p.queue?.processing || 0), 0);
  const apAttention = pages.filter(p => p.paused || (p.queue?.failed || 0) > 0);
  const recent = [...posts].sort((a, b) => new Date(b.posted_at || b.scheduled_at || b.created_at || 0) - new Date(a.posted_at || a.scheduled_at || a.created_at || 0)).slice(0, 5);
  const needsAttention = failed.length > 0 || apAttention.length > 0;
  const week = lastSevenDays(posts).reduce((a, d) => a + d.n, 0);
  const name = firstName();

  // One honest line about where things stand
  const note = errors.includes('posts') ? 'Some of your data could not load. Tap Refresh to try again.'
    : failed.length ? `${failed.length} post${failed.length > 1 ? 's need' : ' needs'} a look. Tap below to fix ${failed.length > 1 ? 'them' : 'it'}.`
    : publishing ? 'Publishing in progress. Sit tight.'
    : scheduled ? `${scheduled} post${scheduled > 1 ? 's' : ''} lined up${upcoming[0] ? `. Next: ${fmt(upcoming[0].scheduled_at)}` : ''}.`
    : week ? `${week} post${week > 1 ? 's' : ''} went live this week. Keep the rhythm going.`
    : 'Nothing scheduled yet. A fresh post takes about a minute.';

  return (
    <div style={{ color: 'var(--text)' }}>
      <div className="hero tilt fade-up">
        <span className="hero-blob" style={{ width: 120, height: 120, right: -30, top: -40, background: 'rgba(230,53,106,.55)' }} />
        <span className="hero-blob" style={{ width: 90, height: 90, left: -20, bottom: -40, background: 'rgba(56,189,248,.45)', animationDelay: '-4s' }} />
        <div style={{ position: 'relative' }}>
          <div className="dash-row">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,.8)' }}>{greeting()}{name ? `, ${name}` : ''}</div>
              <h1 style={{ fontSize: 22, fontWeight: 800, margin: '2px 0 0' }}>Your dashboard</h1>
            </div>
            <button type="button" className="dash-btn" onClick={() => load(true)} disabled={loading} aria-label="Refresh" style={{ background: 'rgba(255,255,255,.14)' }}>
              {loading ? <><span className="live-dot" /> Updating</> : 'Refresh'}
            </button>
          </div>
          <div style={{ fontSize: 14, marginTop: 10, color: '#fff', lineHeight: 1.4 }}>{note}</div>
          {accounts.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              {accounts.slice(0, 6).map((a, i) => (
                <button key={a.id} type="button" className="avatar-btn bob" onClick={() => onNavigate('accounts')} aria-label={`Open ${a.username || a.name}`} style={{ animationDelay: `${i * 70}ms, ${i * 400}ms`, marginRight: -8 }}>
                  <Avatar acct={a} />
                </button>
              ))}
              {accounts.length > 6 && <span style={{ marginLeft: 16, fontSize: 12, color: 'rgba(255,255,255,.85)' }}>+{accounts.length - 6}</span>}
            </div>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div role="alert" className="dash-card" style={{ marginTop: 12, borderColor: 'var(--err)', color: 'var(--err)', fontSize: 13 }}>
          Could not load: {errors.join(', ')}. The numbers below may be out of date.
        </div>
      )}

      {accounts.length === 0 && !loading && !errors.includes('pages') ? (
        <div className="dash-card fade-up" style={{ marginTop: 14, textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Connect your first Instagram page</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 14px' }}>Add a page to start creating and scheduling posts.</div>
          <button type="button" className="dash-btn primary" onClick={() => onNavigate('accounts')}>Add a page</button>
        </div>
      ) : (
        <>
          <div className="dash-grid" style={{ marginTop: 14 }}>
            <Stat label="Instagram pages" value={accounts.length} tint="violet" icon="pages" delay={60} onClick={() => onNavigate('accounts')} />
            <Stat label="Scheduled" value={scheduled} tint="amber" icon="scheduled" delay={120} onClick={() => onNavigate('history')} />
            <Stat label="Posted" value={count('posted')} tint="green" icon="posted" delay={180} onClick={() => onNavigate('history')} />
            <Stat label="Failed" value={failed.length} tint={failed.length ? 'red' : 'violet'} icon="failed" delay={240} onClick={() => onNavigate('history')} />
          </div>

          {(publishing > 0 || apBusy > 0) && (
            <div className="dash-card" style={{ marginTop: 10, fontSize: 13, color: 'var(--info)', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="live-dot" />
              <div>
                {publishing > 0 && <div>{publishing} post{publishing > 1 ? 's' : ''} publishing now</div>}
                {apBusy > 0 && <div>{apBusy} Autopilot item{apBusy > 1 ? 's' : ''} processing</div>}
              </div>
            </div>
          )}

          <Section title="Last 7 days" delay={300}><Week posts={posts} /></Section>

          {needsAttention && (
            <Section title="Needs attention" delay={340} action={<button type="button" className="dash-link" onClick={() => onNavigate('history')}>Open Posts</button>}>
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
            <Section title="Up next" delay={380} action={<button type="button" className="dash-link" onClick={() => onNavigate('history')}>All posts</button>}>
              <div style={{ display: 'grid', gap: 8 }}>
                {upcoming.map(p => (
                  <div key={p.id} className="dash-card tilt dash-row">
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
            <Section title="Autopilot today" delay={420} action={<button type="button" className="dash-link" onClick={() => onNavigate('autopilot')}>Manage</button>}>
              <div style={{ display: 'grid', gap: 8 }}>
                {pages.map(p => (
                  <div key={p.id} className="dash-card tilt dash-row">
                    <div className="dash-row" style={{ justifyContent: 'flex-start', gap: 12, minWidth: 0 }}>
                      <Ring done={p.today?.posted ?? 0} target={p.today?.target ?? 0} />
                      <div style={{ minWidth: 0 }}>
                        <div className="dash-clip" style={{ fontSize: 14, fontWeight: 600 }}>{p.username || p.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{p.today?.posted ?? 0}/{p.today?.target ?? 0} today · {p.queue?.queued ?? 0} queued</div>
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
            <Section title="Recent activity" delay={460}>
              <div style={{ display: 'grid', gap: 8 }}>
                {recent.map(p => (
                  <div key={p.id} className="dash-card tilt dash-row">
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

          <Section title="Quick actions" delay={500}>
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
