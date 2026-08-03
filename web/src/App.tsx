import { useEffect, useState } from 'react';

type Offer = {
  id: string;
  credentialOfferUri: string;
  transactionCode: string;
};

type PartnerRequest = {
  id: string;
  requestUri: string;
};

type PartnerResult =
  | { state: 'awaiting_wallet' | 'expired' }
  | { state: 'denied'; reason: string }
  | {
      state: 'granted';
      disclosed: {
        name: string;
        employer: string;
        employment_status: string;
      };
      accessExpiresIn: number;
    };

type Summary = {
  issuedCredentials: number;
  activeExchanges: number;
  auditEvents: number;
};

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    throw new Error(error.message ?? error.error ?? 'Request failed');
  }
  return response.json() as Promise<T>;
}

function qrSource(uri: string): string {
  return `/api/qr?uri=${encodeURIComponent(uri)}`;
}

export function App() {
  const [area, setArea] = useState<'issuer' | 'partner'>('issuer');
  const [token, setToken] = useState(() => sessionStorage.getItem('operatorToken') ?? '');
  const [unlocked, setUnlocked] = useState(false);
  const [summary, setSummary] = useState<Summary>();
  const [offer, setOffer] = useState<Offer>();
  const [offerState, setOfferState] = useState('not created');
  const [partnerRequest, setPartnerRequest] = useState<PartnerRequest>();
  const [partnerResult, setPartnerResult] = useState<PartnerResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function unlockIssuer() {
    setBusy(true);
    setError(undefined);
    try {
      const next = await json<Summary>(
        await fetch('/api/operator/summary', {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      sessionStorage.setItem('operatorToken', token);
      setSummary(next);
      setUnlocked(true);
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Unable to unlock');
    } finally {
      setBusy(false);
    }
  }

  async function createOffer() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await json<Offer>(
        await fetch('/api/operator/offers', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      setOffer(created);
      setOfferState('waiting for wallet');
    } catch (offerError) {
      setError(offerError instanceof Error ? offerError.message : 'Offer failed');
    } finally {
      setBusy(false);
    }
  }

  async function revokeCredential() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/operator/credentials/active/revoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Unable to revoke active credential');
      setOfferState('revoked');
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Revocation failed');
    } finally {
      setBusy(false);
    }
  }

  async function createPartnerRequest() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await json<PartnerRequest>(
        await fetch('/api/rp/requests', {
          method: 'POST',
          credentials: 'same-origin',
        }),
      );
      setPartnerRequest(created);
      setPartnerResult({ state: 'awaiting_wallet' });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!offer || offerState === 'accepted') return;
    const timer = window.setInterval(() => {
      void fetch(`/issuer/offers/${offer.id}/status`)
        .then((response) => json<{ state: string }>(response))
        .then((result) => setOfferState(result.state))
        .catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [offer, offerState]);

  useEffect(() => {
    if (!partnerRequest || partnerResult?.state === 'granted' || partnerResult?.state === 'denied') {
      return;
    }
    const timer = window.setInterval(() => {
      void fetch(`/api/rp/requests/${partnerRequest.id}`, {
        credentials: 'same-origin',
      })
        .then((response) => json<PartnerResult>(response))
        .then(setPartnerResult)
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [partnerRequest, partnerResult?.state]);

  return (
    <div className="app-shell">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Credential Exchange Demo home">
          <span className="brand-mark">CE</span>
          <span>
            <strong>Credential Exchange</strong>
            <small>DOMAIN IDENTITY LAB</small>
          </span>
        </a>
        <div className="protocol-state">
          <span className="pulse" />
          DID:WEB · HTTPS
        </div>
      </header>

      <nav className="area-nav" aria-label="Demo areas">
        <button
          className={area === 'issuer' ? 'active' : ''}
          onClick={() => setArea('issuer')}
        >
          <span>01</span> Issuer desk
        </button>
        <button
          className={area === 'partner' ? 'active' : ''}
          onClick={() => setArea('partner')}
        >
          <span>02</span> Partner access
        </button>
      </nav>

      {error ? <div className="error" role="alert">{error}</div> : null}

      <main>
        {area === 'issuer' ? (
          <section className="workspace issuer">
            <ol className="exchange-steps" aria-label="Credential exchange progress">
              <li className="complete">
                <span>1</span>
                <div><strong>Employee</strong><small>Synthetic record ready</small></div>
              </li>
              <li className={offer ? 'complete' : 'current'}>
                <span>2</span>
                <div><strong>Offer</strong><small>{offer ? 'Credential offer created' : 'Ready to create'}</small></div>
              </li>
              <li className={offerState === 'accepted' ? 'complete' : ''}>
                <span>3</span>
                <div><strong>Wallet accepted</strong><small>{offerState === 'accepted' ? 'Stored on device' : 'Awaiting wallet'}</small></div>
              </li>
            </ol>

            <div className="intro">
              <h1>Issue trusted proof, without the paperwork.</h1>
              <p>
                Create one short-lived offer for a synthetic employee. The QR
                carries a reference only; the credential is holder-bound after
                the iPhone proves control of its DID key.
              </p>
            </div>

            {!unlocked ? (
              <div className="operator-card">
                <h2>Unlock the issuer desk</h2>
                <label htmlFor="operator-token">Operator token</label>
                <input
                  id="operator-token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Token printed at Companion startup"
                />
                <button aria-label="Unlock issuer" className="primary" disabled={busy} onClick={unlockIssuer}>
                  {busy ? 'Unlocking…' : 'Unlock issuer'}
                </button>
                <p className="microcopy">Kept in this browser tab only.</p>
              </div>
            ) : (
              <div className="desk-grid">
                <article className="employee-sheet">
                  <div className="sheet-top">
                    <span className="card-index">SYNTHETIC RECORD · 001</span>
                    <span className="active-pill">ACTIVE</span>
                  </div>
                  <div className="avatar" aria-hidden="true">AP</div>
                  <h2>Alya Pratama</h2>
                  <p className="role">Digital Trust Lab</p>
                  <dl>
                    <div><dt>Employee ID</dt><dd>EMP-DEMO-001</dd></div>
                    <div><dt>Email</dt><dd>alya.pratama@employee.test</dd></div>
                    <div><dt>Employer</dt><dd>DUMMY-CORP</dd></div>
                  </dl>
                  <button aria-label="Create credential offer" className="primary amber" disabled={busy} onClick={createOffer}>
                    {busy ? 'Creating offer…' : 'Create credential offer'}
                  </button>
                </article>

                <aside className="exchange-panel">
                  {offer ? (
                    <>
                      <div className="panel-heading">
                        <span className="card-index">OPENID4VCI · 05:00</span>
                        <span className="state">{offerState.toUpperCase()}</span>
                      </div>
                      <h2>Scan with Identity Wallet</h2>
                      <div className="qr-wrap">
                        <img
                          alt="Employee credential offer QR"
                          src={qrSource(offer.credentialOfferUri)}
                        />
                      </div>
                      <p className="code-label">TRANSACTION CODE</p>
                      <p className="transaction-code">{offer.transactionCode}</p>
                      <p className="safe-note">
                        Share the code separately. This reference expires and
                        can be redeemed once.
                      </p>
                      {offerState === 'accepted' ? (
                        <button
                          aria-label="Revoke active credential"
                          className="secondary revoke"
                          disabled={busy}
                          onClick={revokeCredential}
                        >
                          {busy ? 'Revoking…' : 'Revoke active credential'}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <div className="panel-empty">
                      <span className="empty-symbol">⌁</span>
                      <h2>No open offer</h2>
                      <p>Select the employee record to begin a credential exchange.</p>
                    </div>
                  )}
                </aside>
                <div className="evidence-strip">
                  <span>ISSUED</span><strong>{summary?.issuedCredentials ?? 0}</strong>
                  <span>ACTIVE EXCHANGES</span><strong>{summary?.activeExchanges ?? 0}</strong>
                  <span>AUDIT EVENTS</span><strong>{summary?.auditEvents ?? 0}</strong>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="workspace partner">
            <div className="intro partner-intro">
              <h1>One proof. Three necessary facts.</h1>
              <p>
                Ask for name, employer, and active employment status. Email,
                employee number, department, and the credential itself stay
                with the holder.
              </p>
            </div>
            <div className="partner-stage">
              {!partnerRequest ? (
                <div className="request-start">
                  <div className="policy">
                    <h2>Active DUMMY-CORP employee</h2>
                    {['Name', 'Employer', 'Employment status'].map((claim) => (
                      <div className="policy-row" key={claim}>
                        <span aria-hidden="true" />{claim}
                      </div>
                    ))}
                    <div className="not-requested">
                      NOT REQUESTED · email, employee ID, department
                    </div>
                  </div>
                  <button aria-label="Request wallet proof" className="primary teal" disabled={busy} onClick={createPartnerRequest}>
                    {busy ? 'Creating request…' : 'Request wallet proof'}
                  </button>
                </div>
              ) : partnerResult?.state === 'granted' ? (
                <div className="workspace-granted">
                  <div aria-hidden="true" className="grant-mark" />
                  <h2>Access granted. Welcome, {partnerResult.disclosed.name}</h2>
                  <p>
                    {partnerResult.disclosed.employer} ·{' '}
                    {partnerResult.disclosed.employment_status}
                  </p>
                  <div className="protected-area">
                    <span>PROTECTED WORKSPACE</span>
                    <strong>Digital Partner Briefing</strong>
                    <p>This browser session closes in about {Math.ceil(partnerResult.accessExpiresIn / 60)} minutes.</p>
                  </div>
                </div>
              ) : partnerResult?.state === 'denied' ? (
                <div className="result-denied">
                  <h2>Request closed. No data was shared.</h2>
                  <p>{partnerResult.reason}</p>
                  <button className="secondary" onClick={() => {
                    setPartnerRequest(undefined);
                    setPartnerResult(undefined);
                  }}>Start again</button>
                </div>
              ) : (
                <div className="partner-waiting">
                  <div className="panel-heading">
                    <span className="card-index">OPENID4VP · 05:00</span>
                    <span className="state">WAITING</span>
                  </div>
                  <h2>Scan to review request</h2>
                  <div className="qr-wrap blue">
                    <img
                      alt="Partner proof request QR"
                      src={qrSource(partnerRequest.requestUri)}
                    />
                  </div>
                  <div className="waiting-line"><span /> Waiting for wallet decision</div>
                  <p className="safe-note">
                    Access is bound to this browser. Scanning on another device
                    cannot unlock a different browser.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <footer>
        <span>DEMO DATA ONLY</span>
        <p>OpenID4VCI 1.0 · OpenID4VP 1.0 · SD-JWT VC draft 17 · no chain / no node</p>
      </footer>
    </div>
  );
}
