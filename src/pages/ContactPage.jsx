import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../App';
import { getT } from '../constants';
import { CONTACT_EMAIL, openMail } from '../utils/mailto';


function ExternalLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      color: 'rgba(74,143,204,0.88)', textDecoration: 'none',
    }}
      onMouseOver={e => e.currentTarget.style.textDecoration = 'underline'}
      onMouseOut={e => e.currentTarget.style.textDecoration = 'none'}
    >
      {children}
    </a>
  );
}

function LinkCard({ href, icon, label, sub }) {
  const { theme } = useTheme();
  const t = getT(theme);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', borderRadius: 6,
      border: `1px solid ${t.panelBorder}`,
      backgroundColor: t.cardBg || t.panel,
      textDecoration: 'none',
      transition: 'border-color 0.15s',
      flex: 1, minWidth: 180,
    }}
      onMouseOver={e => e.currentTarget.style.borderColor = 'rgba(74,143,204,0.45)'}
      onMouseOut={e => e.currentTarget.style.borderColor = t.panelBorder}
    >
      <div style={{ color: 'rgba(74,143,204,0.7)', flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{ fontSize: '0.68rem', fontWeight: 600, color: t.lbl }}>{label}</div>
        {sub && <div style={{ fontSize: '0.55rem', color: t.lblMuted, marginTop: 1 }}>{sub}</div>}
      </div>
    </a>
  );
}

export default function ContactPage() {
  const { theme } = useTheme();
  const t = getT(theme);
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState('idle');
  const [req, setReq] = useState('');
  const [reqStatus, setReqStatus] = useState('idle');

  const divider = { borderColor: t.panelBorder, margin: '28px 0' };

  function handleRequestSubmit(e) {
    e.preventDefault();
    if (!req.trim()) return;
    openMail('EPM Data Explorer: request', req);
    setReqStatus('sent');
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!msg.trim()) return;
    openMail('EPM Data Explorer: feedback', msg);
    setStatus('sent');
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', backgroundColor: t.bg, color: t.text }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 32px 80px' }}>

        {/* Back */}
        <div style={{ marginBottom: 28 }}>
          <Link to="/" style={{ fontSize: '0.65rem', color: t.muted, letterSpacing: '1px' }}>
            ← Back to map
          </Link>
        </div>

        {/* Header */}
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: t.text, marginBottom: 6 }}>
          About
        </h1>
        <p style={{ fontSize: '0.75rem', color: t.muted, lineHeight: 1.65, marginBottom: 10 }}>
          A{' '}<ExternalLink href="https://www.worldbank.org">World Bank</ExternalLink>{' '}
          tool for exploring open-access power sector data at the country level.
          It brings together data on power plants, transmission infrastructure, renewable energy
          resources, and demand indicators — providing an overview and understanding of national
          power systems, and supporting data access for energy planning studies.
        </p>
        {/* The World Bank is already named above; only ESMAP needs adding, and
            quietly — this is a credit line, not a badge. */}
        <p style={{ fontSize: '0.65rem', color: t.muted, opacity: 0.75, lineHeight: 1.6, marginBottom: 32 }}>
          Developed with support from ESMAP.
        </p>

        {/* GitHub — main repo */}
        <a href="https://github.com/ESMAP-World-Bank-Group/epm-data-explorer"
          target="_blank" rel="noopener noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: 18,
            padding: '22px 24px', borderRadius: 8, marginBottom: 32,
            border: `1px solid ${t.panelBorder}`,
            backgroundColor: t.panel,
            textDecoration: 'none', transition: 'border-color 0.15s',
          }}
          onMouseOver={e => e.currentTarget.style.borderColor = 'rgba(74,143,204,0.45)'}
          onMouseOut={e => e.currentTarget.style.borderColor = t.panelBorder}
        >
          <div style={{ color: 'rgba(74,143,204,0.7)', flexShrink: 0 }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '0.95rem', fontWeight: 700, color: t.text, marginBottom: 4 }}>EPM Data Explorer</div>
            <div style={{ fontSize: '0.6rem', color: t.muted }}>github.com/ESMAP-World-Bank-Group/epm-data-explorer</div>
          </div>
        </a>

        <hr style={divider} />

        {/* See also */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: '0.48rem', letterSpacing: '2px', fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase', marginBottom: 14 }}>
            See also
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <LinkCard
              href="https://github.com/ESMAP-World-Bank-Group/EPM"
              label="EPM"
              sub="Electricity Planning Model"
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
                </svg>
              }
            />
            <LinkCard
              href="https://github.com/ESMAP-World-Bank-Group/regional-power-explorer"
              label="Regional Explorer"
              sub="Regional Power Explorer"
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
                </svg>
              }
            />
          </div>
        </div>

        {/* ── Request a feature or data ────────────────────────────── */}
        <div style={{
          marginBottom: 28, padding: '16px 18px', borderRadius: 8,
          border: '1px solid rgba(74,143,204,0.35)',
          borderLeft: '3px solid rgba(74,143,204,0.85)',
          background: t.isDark ? 'rgba(74,143,204,0.06)' : 'rgba(74,143,204,0.05)',
        }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: t.text, marginBottom: 3 }}>
            Want something added?
          </div>
          <p style={{ fontSize: '0.66rem', color: t.muted, lineHeight: 1.6, marginBottom: 12 }}>
            Missing a region, scenario, or feature? Write it here and send it from your email app.
          </p>

          {reqStatus === 'sent' ? (
            <div style={{
              padding: '12px 14px', borderRadius: 6,
              backgroundColor: 'rgba(64,192,87,0.08)', border: '1px solid rgba(64,192,87,0.25)',
              fontSize: '0.7rem', color: t.muted,
            }}>
              Your email app should now be open with the request ready to send. If it isn't,
              write to {CONTACT_EMAIL}.
            </div>
          ) : (
            <form onSubmit={handleRequestSubmit}>
              <textarea
                value={req} required rows={3}
                onChange={e => setReq(e.target.value)}
                placeholder="What would you like added or changed? (region, scenario, feature…)"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 6,
                  border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.text,
                  fontSize: '0.72rem', lineHeight: 1.6, resize: 'vertical', outline: 'none', fontFamily: 'inherit',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <button
                  type="submit"
                  disabled={!req.trim()}
                  style={{
                    padding: '7px 18px', borderRadius: 5, border: '1px solid rgba(74,143,204,0.4)',
                    backgroundColor: 'rgba(74,143,204,0.14)',
                    color: !req.trim() ? t.muted : 'rgba(74,143,204,0.95)',
                    fontSize: '0.65rem', fontWeight: 700,
                    cursor: !req.trim() ? 'default' : 'pointer',
                  }}
                >
                  Send request
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Feedback form */}
        <div>
          <div style={{ fontSize: '0.44rem', letterSpacing: '2px', fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase', marginBottom: 14 }}>
            Questions or feedback
          </div>
          {status === 'sent' ? (
            <div style={{
              padding: '14px 16px', borderRadius: 6,
              backgroundColor: 'rgba(64,192,87,0.08)',
              border: '1px solid rgba(64,192,87,0.25)',
              fontSize: '0.7rem', color: t.muted,
            }}>
              Your email app should now be open with the message ready to send. If it isn't,
              write to {CONTACT_EMAIL}.
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <textarea
                value={msg}
                onChange={e => setMsg(e.target.value)}
                placeholder="Your message…"
                rows={4}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 12px', borderRadius: 6,
                  border: `1px solid ${t.panelBorder}`,
                  backgroundColor: t.panel, color: t.text,
                  fontSize: '0.72rem', lineHeight: 1.6,
                  resize: 'vertical', outline: 'none',
                  fontFamily: 'inherit',
                }}
                onFocus={e => e.target.style.borderColor = 'rgba(74,143,204,0.5)'}
                onBlur={e => e.target.style.borderColor = t.panelBorder}
              />
              <div style={{ fontSize: '0.58rem', color: t.lblMuted, marginTop: 6 }}>
                Or write directly:{' '}
                <a href={`mailto:${CONTACT_EMAIL}`}
                  style={{ color: 'rgba(74,143,204,0.7)', textDecoration: 'none' }}
                  onMouseOver={e => e.currentTarget.style.textDecoration = 'underline'}
                  onMouseOut={e => e.currentTarget.style.textDecoration = 'none'}
                >
                  {CONTACT_EMAIL}
                </a>
              </div>
              <button
                type="submit"
                disabled={!msg.trim()}
                style={{
                  marginTop: 10, padding: '7px 18px', borderRadius: 5,
                  border: '1px solid rgba(74,143,204,0.35)',
                  backgroundColor: 'rgba(74,143,204,0.12)',
                  color: !msg.trim() ? t.muted : 'rgba(74,143,204,0.9)',
                  fontSize: '0.65rem', fontWeight: 600, cursor: !msg.trim() ? 'default' : 'pointer',
                  transition: 'opacity 0.15s',
                }}
              >
                Send
              </button>
            </form>
          )}
        </div>

      </div>
    </div>
  );
}
