import { useEffect, useRef, useState } from "react";
import type { CloudAction, CloudApp, CloudSnapshot, CloudStatus } from "../shared/cloud";
import type { Variant } from "../shared/contracts";
import type { ReviewRun, ReviewStage, ReviewState } from "../shared/review";
import "./cloud-rehearsal.css";

const storageKey = "gecco:cloud-rehearsal:v1";
const reads = new Map<string, Promise<unknown>>();
type AlternateIntent = {
  fromId: string;
  variant: Variant;
  label: string;
  stage: "closing" | "creating";
};
class CloudError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `The rehearsal server returned ${response.status}.`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") message = body.error;
      else if (typeof body.message === "string") message = body.message;
    } catch { /* Keep the actual HTTP status. */ }
    throw new CloudError(message, response.status);
  }
  return response.json();
}
function read<T>(path: string): Promise<T> {
  const existing = reads.get(path);
  if (existing) return existing as Promise<T>;
  const pending = request<T>(path).finally(() => reads.delete(path));
  reads.set(path, pending);
  return pending;
}
function rememberedId() {
  try {
    const id = sessionStorage.getItem(storageKey);
    return id && /^[\w-]+$/.test(id) ? id : null;
  } catch { return null; }
}
function remember(id: string | null) {
  try {
    if (id) sessionStorage.setItem(storageKey, id);
    else sessionStorage.removeItem(storageKey);
  } catch { /* Provider status can still recover the active pair. */ }
}
function message(reason: unknown) {
  return reason instanceof Error ? reason.message : "The server did not return a result.";
}
function words(value: string) { return value.replace(/[_-]/g, " "); }
function short(value?: string) { return value?.slice(0, 8) || "Pending"; }
function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function previewUrl(app?: CloudApp) {
  if (!app?.previewUrl) return null;
  try {
    const url = new URL(app.previewUrl);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch { return null; }
}
// Signed app links are bearer credentials. They belong only in the actual iframe/link.
function publicEvidence(value: unknown, snapshot?: CloudSnapshot | null): unknown {
  const previewHosts = new Set(Object.values(snapshot?.apps || {}).flatMap(app => {
    const url = previewUrl(app); return url ? [url.hostname] : [];
  }));
  function clean(item: unknown): unknown {
    if (typeof item === "string") return item.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [omitted]").replace(/https?:\/\/[^\s"'<>]+/g, candidate => {
      try {
        const url = new URL(candidate);
        return previewHosts.has(url.hostname) || /daytonaproxy\d+\.net$|\.proxy\..*daytona\./i.test(url.hostname) || /token|signature|auth/i.test(url.search)
          ? "[private app URL omitted]" : candidate;
      } catch { return candidate; }
    });
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !/previewurl|token|secret|password|authorization|credential/i.test(key))
      .map(([key, entry]) => [key, clean(entry)]));
    return item;
  }
  return clean(value);
}
function download(snapshot: CloudSnapshot) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(publicEvidence(snapshot, snapshot), null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = `gecco-daytona-${snapshot.id}.json`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Arrow({ external = false }: { external?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={external ? "M13 3h8v8m0-8L10 14M9 3H3v18h18v-6" : "M4 12h15m-6-6 6 6-6 6"} />
  </svg>;
}
function currentImpact(snapshot: CloudSnapshot) {
  const left = snapshot.apps.left.observation?.outcome;
  const right = snapshot.apps.right.observation?.outcome;
  if (snapshot.status === "closed") return "The sandbox pair is closed.";
  if (snapshot.status === "closing") return "Closing both cloud sandboxes…";
  if (Date.parse(snapshot.expiresAt) <= Date.now()) return "This pair has reached its lifetime limit.";
  if (snapshot.status === "failed") return "The cloud rehearsal needs attention.";
  if (snapshot.status === "provisioning") return "Starting two independent cloud apps.";
  if (left === "failed" && right === "failed" && snapshot.phase === "rollback")
    return "Rollback restored the code. Neither app can open the workspace.";
  if (left === "failed" && right === "passed" && snapshot.phase === "rollout")
    return "The new board works. Existing users are locked out.";
  if (left === "passed" && right === "passed")
    return snapshot.phase === "baseline" ? "Both versions work independently. The rollout still needs testing."
      : snapshot.phase === "rollback" ? "Old code can still open sessions created by the new release."
        : "The new board works, and existing users keep access.";
  if (left === "failed" || right === "failed") return "An app could not read the session.";
  return "Waiting for the next observed app read.";
}
function CloudFrame({ side, snapshot, sourceIdentity = false }: { side: "left" | "right"; snapshot: CloudSnapshot | null; sourceIdentity?: boolean }) {
  const app = snapshot?.apps[side];
  const url = previewUrl(app);
  const closed = snapshot?.status === "closed";
  const closing = snapshot?.status === "closing";
  const expired = Boolean((app?.previewExpiresAt && Date.parse(app.previewExpiresAt) <= Date.now()) || (snapshot && Date.parse(snapshot.expiresAt) <= Date.now()));
  const usable = url && !closed && !closing && !expired;
  const title = side === "left" ? "v1 · Launch note" : app?.release === "v1" && snapshot?.phase === "rollback" ? "Rolled back · Launch note" : "v2 · Launch board";
  const observation = app?.observation;
  return <section className="cloud-rehearsal-browser" aria-label={`${title} cloud sandbox`}>
    <header>
      <div><strong>{title}</strong><span title={app ? `${app.release} · ${app.entrypoint} · ${app.sourceRef}` : undefined}>{sourceIdentity && app?.sourceRef ? short(app.sourceRef) : app?.release || (side === "left" ? "v1" : "v2")}</span></div>
      {usable ? <a href={url.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Open ${title.toLowerCase()} app in a new tab`}>Open app <Arrow external /></a> : <span className="cloud-rehearsal-muted">{closed ? "Closed" : closing ? "Closing" : "Daytona"}</span>}
    </header>
    <div className="cloud-rehearsal-address"><span className="cloud-rehearsal-cloud-dot" /><span title={app?.sandboxId}>{app?.sandboxId ? `Sandbox ${short(app.sandboxId)}` : "Cloud sandbox not created"}</span>{usable ? <span>Live Daytona app</span> : null}</div>
    {usable ? <iframe
      key={app?.instanceId || app?.sandboxId}
      className="cloud-rehearsal-preview"
      src={url.href}
      title={`${title}: independent Fieldnotes app in Daytona`}
      sandbox="allow-scripts allow-forms allow-same-origin"
      referrerPolicy="no-referrer"
    /> : <div className="cloud-rehearsal-placeholder">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M6 18a5 5 0 0 1-1-9.9A7 7 0 0 1 18.5 8a5 5 0 0 1-.5 10H6Z" /></svg>
      <strong>{closed ? "Sandbox closed" : closing ? "Closing sandbox…" : expired ? "App link expired" : app?.state ? words(app.state) : "An independent app will run here"}</strong>
      <p>{closed ? "Cleanup status is retained below." : closing ? "Waiting for the provider to confirm cleanup." : expired ? "Refresh status to check the pair." : snapshot ? "The actual app appears when its cloud preview is available." : "Its own runtime. Its own URL. Open it directly."}</p>
      {snapshot?.status === "provisioning" ? <span className="cloud-rehearsal-waiting">Waiting for provider</span> : null}
    </div>}
    <footer>
      <span className={!closed && !closing && !expired ? observation?.outcome || "" : ""}>{closed ? "Inactive" : closing ? "Cleanup pending" : expired ? "Lifetime reached" : observation?.outcome === "passed" ? "Last read succeeded" : observation?.outcome === "failed" ? "Last read failed" : observation?.outcome === "inconclusive" ? "Read incomplete" : "No current read"}</span>
      <span>{observation?.at ? time(observation.at) : app?.state ? words(app.state) : "Not started"}</span>
    </footer>
  </section>;
}

export function FixtureCloudRehearsal() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [label, setLabel] = useState("Avery");
  const [variant, setVariant] = useState<Variant>("breaking");
  const [uncertain, setUncertain] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [alternateIntent, setAlternateIntent] = useState<AlternateIntent | null>(null);
  const requestLock = useRef(false);
  const mutationLock = useRef(false);
  const pendingRead = useRef<Promise<CloudSnapshot> | null>(null);
  const alternateCreateStarted = useRef<string | null>(null);
  const currentId = useRef<string | null>(null);
  const generation = useRef(0);

  function accept(value: CloudSnapshot) {
    currentId.current = value.id;
    setSnapshot(value); setLabel(value.label);
    if (value.status !== "closed") setVariant(value.variant);
    remember(value.status === "closed" ? null : value.id);
  }
  useEffect(() => {
    let live = true;
    setLoading(true);
    const token = ++generation.current;
    async function restore() {
      try {
        const provider = await read<CloudStatus>("/api/cloud/status");
        if (!live || token !== generation.current) return;
        setStatus(provider);
        const id = provider.activeId || rememberedId();
        if (id) {
          try {
            const restored = await read<CloudSnapshot>(`/api/cloud/${encodeURIComponent(id)}`);
            if (live && token === generation.current) accept(restored);
          } catch (reason) {
            if (!live || token !== generation.current) return;
            if (reason instanceof CloudError && [404, 410].includes(reason.status)) {
              remember(null);
              setError("The previous pair is no longer available to this server. Refresh provider status before starting again.");
            } else throw reason;
          }
        }
      } catch (reason) {
        if (live && token === generation.current) setError(message(reason));
      } finally { if (live && token === generation.current) setLoading(false); }
    }
    void restore();
    return () => { live = false; };
  }, [bootAttempt]);

  const id = snapshot?.id;
  const closed = snapshot?.status === "closed";
  useEffect(() => {
    if (!id || closed) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!live) return;
      if (requestLock.current || mutationLock.current) { timer = setTimeout(poll, 1000); return; }
      requestLock.current = true;
      try {
        pendingRead.current = read<CloudSnapshot>(`/api/cloud/${encodeURIComponent(id!)}`);
        const value = await pendingRead.current;
        if (live && currentId.current === id) {
          accept(value); setPollError(null); setUncertain(false);
        }
      } catch (reason) {
        if (live) setPollError(`Live status is unavailable. ${message(reason)}`);
      } finally {
        pendingRead.current = null;
        requestLock.current = false;
        if (live) timer = setTimeout(poll, 1000);
      }
    }
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [id, closed]);

  // The in-memory intent is deliberately lost on reload. A confirmed closed
  // snapshot is the only boundary that can advance this flow to a new POST.
  useEffect(() => {
    if (!alternateIntent || alternateIntent.stage !== "closing" ||
      snapshot?.id !== alternateIntent.fromId || snapshot.status !== "closed" ||
      !status?.configured || pending || uncertain || mutationLock.current ||
      alternateCreateStarted.current === alternateIntent.fromId) return;
    const intent = alternateIntent;
    alternateCreateStarted.current = intent.fromId;
    setVariant(intent.variant);
    setAlternateIntent({ ...intent, stage: "creating" });
    void create(intent.variant, intent.label).finally(() => {
      setAlternateIntent(current => current?.fromId === intent.fromId ? null : current);
    });
  }, [alternateIntent, snapshot?.id, snapshot?.status, status?.configured, pending, uncertain]);

  async function beginOperation(name: string) {
    if (mutationLock.current) return false;
    mutationLock.current = true; setPending(name);
    await pendingRead.current?.catch(() => undefined);
    requestLock.current = true;
    return true;
  }
  function finishOperation() { requestLock.current = false; mutationLock.current = false; setPending(null); }

  async function refresh() {
    if (!await beginOperation("refresh")) return;
    try {
      const provider = await read<CloudStatus>("/api/cloud/status");
      setStatus(provider);
      const activeId = provider.activeId || currentId.current;
      if (activeId) accept(await read<CloudSnapshot>(`/api/cloud/${encodeURIComponent(activeId)}`));
      setError(null); setPollError(null); setUncertain(false);
    } catch (reason) { setError(message(reason)); }
    finally { finishOperation(); }
  }
  async function create(nextVariant = variant, nextLabel = label) {
    if (!status?.configured || (snapshot && snapshot.status !== "closed") || uncertain || !await beginOperation("create")) return;
    setError(null); generation.current += 1;
    try {
      accept(await request<CloudSnapshot>("/api/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: nextLabel.trim() || "Avery", variant: nextVariant }) }));
    } catch (reason) {
      setError(`The create request did not return a pair. ${message(reason)} Refresh provider status before retrying.`);
      setUncertain(true);
      // Recover a possibly accepted create without ever issuing a duplicate POST.
      try {
        const provider = await read<CloudStatus>("/api/cloud/status"); setStatus(provider);
        if (provider.activeId) accept(await read<CloudSnapshot>(`/api/cloud/${encodeURIComponent(provider.activeId)}`));
      } catch { /* The explicit refresh action remains available. */ }
    } finally { finishOperation(); }
  }
  async function control(action: CloudAction) {
    if (!snapshot || uncertain || !await beginOperation(action)) return;
    setError(null);
    try {
      accept(await request<CloudSnapshot>(`/api/cloud/${encodeURIComponent(snapshot.id)}/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }));
    } catch (reason) {
      setError(`The ${words(action)} request did not return a result. ${message(reason)} Check the latest status before repeating it.`); setUncertain(true);
    } finally { finishOperation(); }
  }
  async function closePair(alternate?: AlternateIntent) {
    if (!snapshot || !await beginOperation("close")) return;
    setAlternateIntent(alternate ?? null);
    setError(null);
    try {
      accept(await request<CloudSnapshot>(`/api/cloud/${encodeURIComponent(snapshot.id)}`, { method: "DELETE" }));
      setUncertain(false);
    } catch (reason) {
      setError(`Cleanup has not been confirmed. ${message(reason)} Refresh status; the pair remains listed until closure is confirmed.`); setUncertain(true);
    } finally { finishOperation(); }
  }
  function rehearseAlternate() {
    if (!snapshot || snapshot.status !== "completed" || pending || uncertain || alternateIntent) return;
    void closePair({ fromId: snapshot.id, variant: snapshot.variant === "breaking" ? "compatible" : "breaking", label: snapshot.label, stage: "closing" });
  }

  const active = snapshot && !closed;
  const manual = snapshot && ["paused", "ready", "completed"].includes(snapshot.status) && !snapshot.busy;
  const disabled = Boolean(pending || uncertain || snapshot?.busy || alternateIntent);
  const hasFailure = Boolean(snapshot && Object.values(snapshot.apps).some(app => app.observation?.outcome === "failed"));
  const lastEvent = snapshot?.events.at(-1);
  const impact = snapshot ? currentImpact(snapshot) : "Two real cloud apps. One release to rehearse.";
  const expired = Boolean(snapshot && Date.parse(snapshot.expiresAt) <= Date.now());
  const caption = snapshot ? ["provisioning", "closing", "failed", "closed"].includes(snapshot.status)
    ? snapshot.progress.detail
    : snapshot.busy && snapshot.automation.action
      ? `Running: ${words(snapshot.automation.action)}`
      : lastEvent?.detail || snapshot.progress.detail : "";
  const sharedDatabase = Boolean(snapshot?.apps.left.databaseId && snapshot.apps.left.databaseId === snapshot.apps.right.databaseId);
  const standalone = snapshot?.events.find(event => event.title === 'The new launch board works on its own');
  const rollout = snapshot?.events.filter(event => event.title === 'Old and new code tested against release data').at(-1);
  const newSessionWritten = snapshot?.events.some(event => event.title === 'The new app created a real session');
  const changeUrl = snapshot?.change && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(snapshot.repository)
    ? `${snapshot.repository}/compare/${snapshot.change.baseRef}...${snapshot.change.proposedRef}` : null;
  const context = snapshot?.phase === "rollback" && sharedDatabase
    ? { title: "After rollback, both apps run v1 with the data v2 created.",
      detail: "Both panes now run v1. Sessions written by v2 are still in the database. We are checking whether going back to old code restores users’ access." }
    : snapshot?.phase === "rollout" && sharedDatabase
      ? { title: "During rollout, both apps use the same database.",
        detail: "Real deployments briefly run both versions together. Each app must still read sessions after the database changes." }
      : { title: "Before deployment, each app has its own database.",
        detail: "Both versions start with the same checklist in separate databases. Gecco opens v2 and completes an item before testing the actual rollout." };
  return <div className="cloud-rehearsal">
    <header className="cloud-rehearsal-heading">
      <div><h1>Can this new launch board ship safely?</h1><p>A plain note becomes an interactive board. Does the upgrade keep existing users working?</p></div>
      <span className="cloud-rehearsal-provider"><span />Daytona</span>
    </header>

    {loading ? <div className="cloud-rehearsal-notice" role="status">Checking cloud setup and recovering any active pair…</div> : null}
    {!loading && status?.configured === false ? <div className="cloud-rehearsal-notice" role="status"><strong>Daytona setup is not ready.</strong><p>{status.reason || "The rehearsal server has no Daytona credentials configured."}</p><button className="cloud-rehearsal-link" onClick={refresh} disabled={Boolean(pending)}>Check setup again <Arrow /></button></div> : null}
    {!loading && !status ? <button className="cloud-rehearsal-secondary" onClick={() => { setError(null); setBootAttempt(n => n + 1); }}>Retry cloud setup</button> : null}
    {error || pollError || snapshot?.error ? <div className="cloud-rehearsal-error" role="alert"><p>{snapshot ? String(publicEvidence(error || pollError || snapshot.error, snapshot)) : error || pollError}</p>{pollError && error ? <p>{snapshot ? String(publicEvidence(pollError, snapshot)) : pollError}</p> : null}<button className="cloud-rehearsal-link" disabled={Boolean(pending)} onClick={refresh}>Refresh status <Arrow /></button></div> : null}

    {alternateIntent ? <div className="cloud-rehearsal-notice" role="status">
      <strong>{alternateIntent.stage === "closing" ? "Closing the current pair before the next rehearsal." : "Previous pair closed. Requesting a fresh sandbox pair…"}</strong>
      <p>{alternateIntent.variant === "compatible" ? "The compatibility fix" : "The original change"} will run with the same session name, {alternateIntent.label}, in new sandboxes. {alternateIntent.stage === "closing" ? "Waiting for confirmed cleanup." : "Waiting for the provider to accept the new pair."}</p>
      {alternateIntent.stage === "closing" ? <button className="cloud-rehearsal-link" onClick={() => setAlternateIntent(null)}>Cancel the next rehearsal</button> : null}
    </div> : null}

    {!active && !alternateIntent ? <form className="cloud-rehearsal-setup" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>Session name<input value={label} onChange={event => setLabel(event.target.value)} maxLength={48} disabled={Boolean(pending || loading)} /></label>
      <label>Release candidate<select value={variant} onChange={event => setVariant(event.target.value as Variant)} disabled={Boolean(pending || loading)}><option value="breaking">New board · original migration</option><option value="compatible">New board · compatible migration</option></select></label>
      <button className="cloud-rehearsal-primary" disabled={!status?.configured || loading || Boolean(pending) || uncertain}>{pending === "create" ? "Requesting sandboxes…" : closed ? "Start a fresh cloud pair" : "Run cloud rehearsal"}<Arrow /></button>
    </form> : null}

    <div className="cloud-rehearsal-stage-row">
      <ol aria-label="Release stages">{(["baseline", "rollout", "rollback"] as const).map((phase, index) => <li key={phase} className={snapshot?.phase === phase ? "current" : ""} aria-current={snapshot?.phase === phase ? "step" : undefined}><span>{index + 1}</span>{phase === "baseline" ? "Try v2" : phase === "rollout" ? "Rehearse deployment" : "Optional rollback"}</li>)}</ol>
      {active ? <div className="cloud-rehearsal-controls">
        {snapshot.status === "running" ? <button className="cloud-rehearsal-secondary" disabled={Boolean(pending || uncertain)} onClick={() => control("pause")}>Pause & explore</button> : ["paused", "ready"].includes(snapshot.status) && !expired ? <button className="cloud-rehearsal-secondary" disabled={disabled} onClick={() => control("play")}>Resume rehearsal <Arrow /></button> : null}
        <button className="cloud-rehearsal-close" disabled={Boolean(pending) || snapshot.status === "closing"} onClick={() => closePair()}>{snapshot.status === "closing" || pending === "close" ? "Closing sandboxes…" : "Close sandbox pair"}</button>
      </div> : null}
    </div>

    <section className={`cloud-rehearsal-narration ${hasFailure && !snapshot?.busy ? "failed" : ""}`} aria-live="polite" aria-atomic="true">
      <div><strong>{impact}</strong><p>{snapshot ? <><span>{words(snapshot.status)}</span>{snapshot.automation.total > 0 && snapshot.status !== "provisioning" ? ` · ${snapshot.automation.step}/${snapshot.automation.total} steps completed` : ""}{snapshot.status === "provisioning" && snapshot.progress.stage ? ` · ${words(snapshot.progress.stage)}` : ""}{snapshot.status !== "completed" && caption && caption !== impact ? ` — ${String(publicEvidence(caption, snapshot))}` : ""}</> : "Clone the pinned public source, install it, and start each app in its own sandbox."}</p>
        {standalone ? <div className="cloud-rehearsal-checkpoints"><span className={standalone.outcome}>New feature alone: {standalone.outcome}</span><span className={rollout?.outcome}>During deployment: {rollout?.outcome || "not checked yet"}</span></div> : null}
      </div>
      {snapshot?.status === "completed" ? <button className="cloud-rehearsal-primary" disabled={disabled || !status?.configured} onClick={rehearseAlternate}>{snapshot.variant === "breaking" ? "Rehearse the compatibility fix" : "Rehearse the original change"}<Arrow /></button> : null}
    </section>


    {snapshot?.apps.left.databaseId && snapshot.apps.right.databaseId && !["provisioning", "closing", "closed"].includes(snapshot.status) ? <div className="cloud-rehearsal-context">
      <strong>{context.title}</strong>
      <details><summary>How edits appear <Arrow /></summary><p>{context.detail}</p>
        <p>{sharedDatabase ? snapshot.phase === 'rollback' ? "Both apps now run v1. Use Refresh workspace to read the latest saved checklist from the shared database." : "The note and board use the same saved checklist. v1 reads again when you choose Refresh workspace; v2 checks for updates automatically while you explore." : "A checked item in v2 changes only its own test database here. Deployment will test the existing users’ database."}</p>
      </details>
    </div> : null}
    <div className="cloud-rehearsal-browsers"><CloudFrame side="left" snapshot={snapshot} /><CloudFrame side="right" snapshot={snapshot} /></div>

    {manual && !expired ? <div className="cloud-rehearsal-manual"><span>Try the apps yourself, or:</span><button disabled={disabled} onClick={() => control("read-both")}>Check access again</button>{snapshot.phase === "baseline" ? <button disabled={disabled} onClick={() => control("deploy")}>Deploy migration</button> : null}{snapshot.phase === "rollout" ? <>{!newSessionWritten ? <button disabled={disabled} onClick={() => control("write-new")}>Create v2 session</button> : null}<button disabled={disabled} onClick={() => control("rollback")}>Test rollback</button></> : null}{changeUrl ? <a href={changeUrl} target="_blank" rel="noopener noreferrer">View the actual change <Arrow external /></a> : null}</div> : null}

    <div className="cloud-rehearsal-topology">{snapshot ? <><span>{snapshot.apps.left.databaseId && snapshot.apps.right.databaseId ? snapshot.apps.left.databaseId === snapshot.apps.right.databaseId ? "Both apps connected to the same database" : "Two independent databases" : "Database connections pending"}</span><span>{snapshot.variant === "compatible" ? "Compatibility fix" : "Original migration"} · {snapshot.label}</span><span>{closed ? "Pair closed" : `Pair expires ${time(snapshot.expiresAt)}`}</span></> : <span>Two cloud sandboxes · Direct app URLs · 60-minute lifetime</span>}</div>
    {lastEvent ? <p className="cloud-rehearsal-last-event"><strong>{lastEvent.title}</strong> {String(publicEvidence(lastEvent.detail, snapshot!))}</p> : null}

    {snapshot ? <details className="cloud-rehearsal-evidence"><summary>Source, events & cleanup <span>{snapshot.events.length} recorded events <Arrow /></span></summary>
      <div className="cloud-rehearsal-evidence-heading"><p>Actual provider and application observations. Private app links are omitted from evidence exports.</p><button className="cloud-rehearsal-link" onClick={() => download(snapshot)}>Download JSON <Arrow /></button></div>
      <div className="cloud-rehearsal-provenance">{(["left", "right"] as const).map(side => { const app = snapshot.apps[side]; return <section key={side}><h2>{side === "left" ? "Previous app" : "Proposed app"}</h2><dl><dt>Sandbox</dt><dd>{app.sandboxId || "Not created"}</dd><dt>Source ref</dt><dd>{app.sourceRef || "Pending"}</dd><dt>Entrypoint</dt><dd>{app.entrypoint || "Pending"}</dd><dt>Instance</dt><dd>{app.instanceId || "Not observed"}</dd><dt>Database</dt><dd>{app.databaseId || "Not observed"}{app.databaseKind ? ` (${app.databaseKind})` : ""}</dd><dt>PostgreSQL</dt><dd>{app.postgresVersion || "Not observed"}</dd></dl></section>; })}</div>
      <p className="cloud-rehearsal-repository">Repository: <code>{snapshot.repository}</code></p>
      {snapshot.events.map(event => <details className="cloud-rehearsal-event" key={event.id}><summary><span>{event.title}</span><span>{event.outcome || "Recorded"} · {time(event.at)} <Arrow /></span></summary><p>{String(publicEvidence(event.detail, snapshot))}</p>{event.evidence !== undefined ? <pre>{JSON.stringify(publicEvidence(event.evidence, snapshot), null, 2)}</pre> : null}</details>)}
      <details className="cloud-rehearsal-event" open={snapshot.status === "closing" || snapshot.status === "closed" || snapshot.status === "failed"}><summary>Cleanup evidence <Arrow /></summary><pre>{snapshot.cleanup === undefined ? "No cleanup result has been reported." : JSON.stringify(publicEvidence(snapshot.cleanup, snapshot), null, 2)}</pre></details>
    </details> : null}
    <p className="cloud-rehearsal-disclosure">Public Fieldnotes example with pinned v1/v2 entrypoints. A fixed rehearsal journey drives the release; pause to use the apps yourself.</p>
  </div>;
}

const fixingStages = new Set<ReviewStage>(["generating", "validating", "publishing"]);
const activeReviewStages = new Set<ReviewStage>(["rehearsing", "generating", "validating", "publishing", "rerunning"]);

function githubLink(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function reviewRepository(value?: string) {
  const safe = githubLink(value);
  if (!safe) return null;
  const parts = new URL(safe).pathname.split("/").filter(Boolean);
  return parts.length >= 2 ? { name: `${parts[0]}/${parts[1]}`, url: `https://github.com/${parts[0]}/${parts[1]}` } : null;
}
function RunCheckpoint({ title, run, active }: { title: string; run?: ReviewRun; active: boolean }) {
  const outcome = run?.status;
  return <li className={`${active ? "current" : ""} ${outcome || ""}`} aria-current={active ? "step" : undefined}>
    <span className="cloud-review-step-dot" aria-hidden="true">{outcome === "passed" ? "✓" : outcome === "failed" ? "!" : "·"}</span>
    <span><strong>{title}</strong><small>{outcome === "running" ? "Running in Daytona" : outcome === "passed" ? "Passed" : outcome === "failed" ? "Failure reproduced" : outcome === "inconclusive" ? "No verdict" : "Not run"}{run?.headRef ? ` · ${short(run.headRef)}` : ""}</small></span>
  </li>;
}
function ReviewEvidence({ review, snapshot }: { review: ReviewState; snapshot: CloudSnapshot | null }) {
  return <details className="cloud-rehearsal-evidence cloud-review-evidence">
    <summary>Patch, source & execution evidence <span>{snapshot ? `${snapshot.events.length} recorded events` : "Review record"} <Arrow /></span></summary>
    {review.fix ? <section className="cloud-review-patch">
      <div><h2>Astra’s patch</h2>{review.fix.commitUrl && githubLink(review.fix.commitUrl) ? <a href={githubLink(review.fix.commitUrl)!} target="_blank" rel="noopener noreferrer">Commit {short(review.fix.commitSha)} <Arrow external /></a> : null}</div>
      <p>{String(publicEvidence(review.fix.summary || "The patch has not been returned yet.", snapshot))}</p>
      {review.fix.files?.length ? <ul>{review.fix.files.map(file => <li key={file}><code>{file}</code></li>)}</ul> : null}
      <p>Requested model: {review.fix.requestedModel}. Reported model: {review.fix.reportedModel || "Not reported"}.</p>
      {review.fix.generatedAt ? <p>Generated {time(review.fix.generatedAt)}.</p> : null}
      {review.fix.validation ? <pre>{String(publicEvidence(review.fix.validation, snapshot))}</pre> : null}
    </section> : null}
    <div className="cloud-rehearsal-evidence-heading"><p>Results are pinned to the recorded source revisions. App bearer links are omitted from downloads.</p><button className="cloud-rehearsal-link" onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(publicEvidence({ review, rehearsal: snapshot }, snapshot), null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `gecco-pr-${review.id || "review"}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>Download JSON <Arrow /></button></div>
    {snapshot ? <>
      <div className="cloud-rehearsal-provenance">{(["left", "right"] as const).map(side => { const app = snapshot.apps[side]; return <section key={side}><h2>{side === "left" ? "Base app" : "PR head app"}</h2><dl><dt>Sandbox</dt><dd>{app.sandboxId || "Not created"}</dd><dt>Source ref</dt><dd>{app.sourceRef || "Pending"}</dd><dt>Entrypoint</dt><dd>{app.entrypoint || "Pending"}</dd><dt>Instance</dt><dd>{app.instanceId || "Not observed"}</dd><dt>Database</dt><dd>{app.databaseId || "Not observed"}</dd><dt>PostgreSQL</dt><dd>{app.postgresVersion || "Not observed"}</dd></dl></section>; })}</div>
      {snapshot.events.map(event => <details className="cloud-rehearsal-event" key={event.id}><summary><span>{event.title}</span><span>{event.outcome || "Recorded"} · {time(event.at)} <Arrow /></span></summary><p>{String(publicEvidence(event.detail, snapshot))}</p>{event.evidence !== undefined ? <pre>{JSON.stringify(publicEvidence(event.evidence, snapshot), null, 2)}</pre> : null}</details>)}
      <details className="cloud-rehearsal-event" open={["closing", "closed", "failed"].includes(snapshot.status)}><summary>Cleanup evidence <Arrow /></summary><pre>{snapshot.cleanup === undefined ? "No cleanup result has been reported." : JSON.stringify(publicEvidence(snapshot.cleanup, snapshot), null, 2)}</pre></details>
    </> : null}
    <details className="cloud-rehearsal-event"><summary>Complete PR review record <Arrow /></summary><pre>{JSON.stringify(publicEvidence(review, snapshot), null, 2)}</pre></details>
  </details>;
}

export default function CloudRehearsal() {
  const [review, setReview] = useState<ReviewState | null>(null);
  const [provider, setProvider] = useState<CloudStatus | null>(null);
  const [pair, setPair] = useState<CloudSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [prUrl, setPrUrl] = useState("");
  const [label, setLabel] = useState("Avery");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const reviewRef = useRef<ReviewState | null>(null);
  const operation = useRef(false);
  const readInFlight = useRef<Promise<void> | null>(null);
  const uncertainRequest = useRef<{ action: "create" | "fix" | "close" | "control"; priorId?: string; runId?: string } | null>(null);

  function acceptReview(value: ReviewState) {
    if (value.id && value.id !== reviewRef.current?.id && value.label) setLabel(value.label);
    reviewRef.current = value;
    setReview(value);
    setPrUrl(current => current || value.pullRequest?.url || value.defaultPrUrl);
    const unknown = uncertainRequest.current;
    if (unknown && ((unknown.action === "create" && value.id && value.id !== unknown.priorId) ||
      (unknown.action === "fix" && (value.stage !== "failure_observed" || value.fix)))) {
      uncertainRequest.current = null; setUncertain(false); setError(null);
    }
  }

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    async function poll() {
      if (!live) return;
      if (operation.current || readInFlight.current) { timer = setTimeout(poll, 500); return; }
      const currentRead = (async () => {
        try {
          const [next, configuration] = await Promise.all([
            read<ReviewState>("/api/review"),
            first ? read<CloudStatus>("/api/cloud/status") : Promise.resolve(null),
          ]);
          if (!live) return;
          if (configuration) setProvider(configuration);
          acceptReview(next);
          if (next.currentRunId) {
            const latestPair = await read<CloudSnapshot>(`/api/cloud/${encodeURIComponent(next.currentRunId)}`);
            if (!live || reviewRef.current?.currentRunId !== latestPair.id) return;
            setPair(latestPair);
            const unknown = uncertainRequest.current;
            if (unknown?.runId === latestPair.id &&
              ((unknown.action === "close" && ["closing", "closed"].includes(latestPair.status)) || unknown.action === "control")) {
              uncertainRequest.current = null; setUncertain(false); setError(null);
            }
          } else setPair(null);
          setPollError(null);
        } catch (reason) {
          if (live) setPollError(message(reason));
        } finally {
          first = false;
          if (live) setLoading(false);
        }
      })();
      readInFlight.current = currentRead;
      await currentRead;
      if (readInFlight.current === currentRead) readInFlight.current = null;
      if (live) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [refreshCount]);

  async function mutate(action: "create" | "fix" | "close" | "control", controlAction?: CloudAction) {
    if (operation.current || uncertain) return;
    const before = reviewRef.current;
    if (action !== "create" && !before?.id) return;
    operation.current = true; setPending(action); setError(null);
    await readInFlight.current;
    try {
      if (action === "create" || action === "fix") {
        const value = await request<ReviewState>(action === "create" ? "/api/review" : "/api/review/fix", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action === "create" ? { prUrl: prUrl.trim(), label: label.trim() || "Avery" } : {}),
        });
        acceptReview(value);
      } else if (before?.currentRunId) {
        const path = `/api/cloud/${encodeURIComponent(before.currentRunId)}`;
        const value = await request<CloudSnapshot>(action === "close" ? path : `${path}/control`, action === "close"
          ? { method: "DELETE" }
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: controlAction }) });
        if (reviewRef.current?.currentRunId === value.id) setPair(value);
      }
    } catch (reason) {
      const isUnknown = !(reason instanceof CloudError && reason.status >= 400 && reason.status < 500);
      if (isUnknown) {
        uncertainRequest.current = { action, priorId: before?.id, runId: before?.currentRunId };
        setUncertain(true);
      }
      setError(`${message(reason)}${isUnknown ? " The request may have been accepted. Checking its status; it will not be sent again automatically." : ""}`);
    } finally {
      operation.current = false; setPending(null); setRefreshCount(current => current + 1);
    }
  }

  const snapshot = pair?.id === review?.currentRunId ? pair : null;
  const repository = reviewRepository(review?.pullRequest?.url || review?.defaultPrUrl);
  const pullRequest = review?.pullRequest;
  const busy = Boolean(pending || uncertain || loading);
  const fixing = Boolean(review && fixingStages.has(review.stage));
  const repairActive = fixing || review?.stage === "rerunning";
  const running = Boolean(review && activeReviewStages.has(review.stage));
  const expired = Boolean(snapshot && Date.parse(snapshot.expiresAt) <= Date.now());
  const activePair = snapshot && snapshot.status !== "closed";
  const manual = snapshot && ["ready", "paused", "completed"].includes(snapshot.status) && !snapshot.busy && !expired;
  const observedFailure = review?.originalRun?.status === "failed";
  const fixAllowed = review?.stage === "failure_observed" && observedFailure;
  const fixed = Boolean(review?.fix?.commitSha);
  const initial = !review?.id && (!review || review.stage === "waiting");
  const canStart = initial || Boolean(review && !running && snapshot?.status === "closed");
  const currentOutcome = review?.retestRun?.status || review?.originalRun?.status;
  const impact = fixing ? (review?.stage === "generating" ? "Astra is working from the reproduced failure." : review?.stage === "validating" ? "Checking Astra’s patch before it is committed." : "Publishing the fix to the same pull request.")
    : review?.stage === "rerunning" ? snapshot ? currentImpact(snapshot) : "Starting fresh sandboxes at the fix commit."
      : review?.stage === "verified" ? review.retestRun?.status === "passed" ? "The fix passed the fresh release rehearsal." : "This PR passed the release rehearsal."
        : fixAllowed ? snapshot?.apps.left.observation?.outcome === "failed" && snapshot.apps.right.observation?.outcome === "passed" ? "The new board works. Existing users are locked out." : "The PR failed the release rehearsal."
          : review?.stage === "failed" || review?.stage === "inconclusive" ? "This review needs attention."
            : snapshot ? currentImpact(snapshot) : "Run the PR in two independent cloud apps.";
  const commitUrl = githubLink(review?.fix?.commitUrl);
  const showError = error || pollError || review?.error;

  return <div className="cloud-rehearsal cloud-review">
    <header className="cloud-rehearsal-heading cloud-review-heading">
      <div><div className="cloud-review-source">{repository ? <a href={repository.url} target="_blank" rel="noopener noreferrer">{repository.name} <Arrow external /></a> : <span>Public GitHub pull request</span>}<span>Open source · MIT</span></div>
        <h1>{pullRequest?.title || "Rehearse a PR. Fix what breaks."}</h1>
        <div className="cloud-review-revision">{pullRequest && githubLink(pullRequest.url) ? <><a href={githubLink(pullRequest.url)!} target="_blank" rel="noopener noreferrer">PR #{pullRequest.number} <Arrow external /></a><span>Base <code title={pullRequest.baseRef}>{short(pullRequest.baseRef)}</code></span><span>Head <code title={pullRequest.headRef}>{short(pullRequest.headRef)}</code></span></> : <p>Reproduce the failure, let Astra commit a fix, then test that commit in fresh sandboxes.</p>}</div>
      </div><span className="cloud-rehearsal-provider"><span />Daytona</span>
    </header>

    {loading ? <div className="cloud-rehearsal-notice" role="status">Loading the public PR and recovering any accepted review…</div> : null}
    {!loading && provider?.configured === false ? <div className="cloud-rehearsal-notice" role="status"><strong>Daytona setup is not ready.</strong><p>{provider.reason || "The rehearsal server has no Daytona credentials configured."}</p></div> : null}
    {showError ? <div className="cloud-rehearsal-error" role="alert"><p>{String(publicEvidence(showError, snapshot))}</p><button className="cloud-rehearsal-link" disabled={Boolean(pending)} onClick={() => setRefreshCount(current => current + 1)}>Check accepted job status <Arrow /></button></div> : null}

    {canStart ? <form className="cloud-rehearsal-setup cloud-review-setup" onSubmit={event => { event.preventDefault(); void mutate("create"); }}>
      <label>Public PR<input type="url" value={prUrl} onChange={event => setPrUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" required disabled={busy} /></label>
      <label>Session<input value={label} onChange={event => setLabel(event.target.value)} maxLength={48} disabled={busy} /></label>
      <button className="cloud-rehearsal-primary" disabled={busy || !provider?.configured || !prUrl.trim()}>{pending === "create" ? "Starting review…" : "Run PR rehearsal"}<Arrow /></button>
    </form> : null}

    <div className="cloud-review-loop-row"><ol className="cloud-review-loop" aria-label="PR review stages">
      <RunCheckpoint title="Test PR" run={review?.originalRun} active={review?.stage === "rehearsing"} />
      <li className={`${fixing ? "current" : ""} ${fixed ? "published" : ""}`} aria-current={fixing ? "step" : undefined}><span className="cloud-review-step-dot" aria-hidden="true">{fixed ? "✓" : "·"}</span><span><strong>Astra fix</strong><small>{fixed ? `Committed · ${short(review?.fix?.commitSha)}` : fixing ? words(review!.stage) : review?.originalRun?.status === "passed" ? "Not needed" : review?.fix ? "Not committed" : "Awaiting reproduced failure"}</small></span></li>
      <RunCheckpoint title="Retest" run={review?.retestRun} active={review?.stage === "rerunning"} />
    </ol>{activePair ? <button className="cloud-rehearsal-close" title={repairActive ? "The repair closes the old pair before starting its fresh retest. Cleanup controls return when it finishes." : undefined} disabled={Boolean(pending || uncertain || repairActive || snapshot.status === "closing")} onClick={() => void mutate("close")}>{snapshot.status === "closing" || pending === "close" ? "Closing sandboxes…" : "Close sandbox pair"}</button> : null}</div>

    <section className={`cloud-rehearsal-narration cloud-review-narration ${currentOutcome === "failed" && !fixing ? "failed" : ""}`} aria-live="polite" aria-atomic="true">
      <div><strong>{impact}</strong><p>{review ? String(publicEvidence(review.message, snapshot)) : "The test uses the PR’s actual base and head commits. No sandbox is created until you start."}</p>{snapshot?.status === "provisioning" ? <p>{snapshot.progress.stage} — {String(publicEvidence(snapshot.progress.detail, snapshot))}</p> : null}{repairActive ? <p>The repair closes the previous pair before starting its fresh retest.</p> : null}</div>
      {fixAllowed ? <div className="cloud-review-fix-action"><button className="cloud-rehearsal-primary" disabled={busy || !provider?.configured || snapshot?.status !== "completed" || expired} onClick={() => void mutate("fix")}>{pending === "fix" ? "Requesting Astra…" : "Ask Astra to fix & rerun"}<Arrow /></button><small>Commits the fix to this PR.</small></div> : null}
    </section>

    {fixed ? <div className="cloud-review-commit"><span><strong>Fix committed</strong>{review?.fix?.summary ? ` — ${String(publicEvidence(review.fix.summary, snapshot))}` : ""}</span>{commitUrl ? <a href={commitUrl} target="_blank" rel="noopener noreferrer">View {short(review?.fix?.commitSha)} <Arrow external /></a> : <code>{short(review?.fix?.commitSha)}</code>}</div> : null}
    <div className="cloud-rehearsal-context"><strong>{snapshot?.phase === "rollout" ? "Base and PR head now share the same PostgreSQL database." : snapshot?.phase === "rollback" ? "Old code is reading the data written by the proposed release." : "Each source revision starts in its own Daytona sandbox."}</strong>{snapshot ? <span className="cloud-review-pair-label">{review?.retestRun?.id === snapshot.id ? "Fresh retest" : "Original PR test"} · {short(snapshot.id)}</span> : null}</div>
    <div className="cloud-rehearsal-browsers"><CloudFrame side="left" snapshot={snapshot} sourceIdentity /><CloudFrame side="right" snapshot={snapshot} sourceIdentity /></div>

    {snapshot ? <div className="cloud-rehearsal-manual"><span>{expired ? "This pair has reached its lifetime limit." : manual ? "Explore the apps directly." : fixing ? "Astra is preparing the next source revision." : "The rehearsal is running the recorded journey."}</span>{snapshot.status === "running" && !fixing ? <button disabled={busy} onClick={() => void mutate("control", "pause")}>Pause & explore</button> : ["paused", "ready"].includes(snapshot.status) && !expired && !fixing ? <button disabled={busy || snapshot.busy} onClick={() => void mutate("control", "play")}>Resume rehearsal</button> : null}{manual && !running ? <button disabled={busy} onClick={() => void mutate("control", "read-both")}>Read both apps again</button> : null}<span className="cloud-review-expiry">{snapshot.status === "closed" ? "Pair closed" : `Pair expires ${time(snapshot.expiresAt)}`}</span></div> : null}
    {review ? <ReviewEvidence review={review} snapshot={snapshot} /> : null}
    <p className="cloud-rehearsal-disclosure">Public Fieldnotes sample · Real source checkouts and PostgreSQL reads in Daytona. Astra generates the patch; a fixed test journey checks the release. Only the configured public sample PRs are supported.</p>
  </div>;
}
