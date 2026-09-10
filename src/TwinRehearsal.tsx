import { useEffect, useRef, useState } from "react";
import type { Variant } from "../shared/contracts";
import type {
  TwinAction,
  TwinEvent,
  TwinSide,
  TwinSnapshot,
} from "../shared/twin";
import "./twin-rehearsal.css";

const sessionKey = "gecco:twin-rehearsal:v1";
const inFlightSnapshots = new Map<string, Promise<TwinSnapshot>>();
const phaseLabels = {
  baseline: "Before",
  rollout: "Rollout",
  rollback: "Rollback",
};
const actionCaptions: Record<TwinAction, string> = {
  "read-both": "Read the session in both apps",
  "read-left": "Check the previous app",
  "read-right": "Check the proposed app",
  "save-left": "Save through the previous app",
  "save-right": "Save through the proposed app",
  deploy: "Deploy the migration",
  "write-new": "Create a session with the new version",
  rollback: "Roll back and preserve the new write",
};
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `The local server returned ${response.status}.`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") detail = body.error;
    } catch {
      /* Retain HTTP status when the body is unavailable. */
    }
    throw new ApiError(detail, response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
function readSnapshot(id: string) {
  const existing = inFlightSnapshots.get(id);
  if (existing) return existing;
  const pending = request<TwinSnapshot>(
    `/api/twins/${encodeURIComponent(id)}`,
  ).finally(() => inFlightSnapshots.delete(id));
  inFlightSnapshots.set(id, pending);
  return pending;
}
function savedId(): string | null {
  try {
    const value = sessionStorage.getItem(sessionKey);
    return value && /^[\w-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
function remember(id: string | null) {
  try {
    if (id) sessionStorage.setItem(sessionKey, id);
    else sessionStorage.removeItem(sessionKey);
  } catch {
    /* The active experiment still works without storage. */
  }
}
function errorMessage(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "The local server did not return a result.";
}
function expiredError(reason: unknown) {
  return reason instanceof ApiError && [404, 410].includes(reason.status);
}
function short(id: string) {
  return id.slice(0, 8);
}
function Icon({
  kind,
}: {
  kind:
    | "arrow"
    | "chevron"
    | "pause"
    | "play"
    | "download"
    | "check"
    | "cross"
    | "refresh"
    | "database";
}) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "arrow" ? (
        <path d="M4 12h15m-6-6 6 6-6 6" />
      ) : kind === "chevron" ? (
        <path d="m9 5 7 7-7 7" />
      ) : kind === "pause" ? (
        <path d="M8 5v14M16 5v14" />
      ) : kind === "play" ? (
        <path d="m8 4 12 8-12 8z" />
      ) : kind === "download" ? (
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      ) : kind === "check" ? (
        <path d="m5 12 4 4L19 6" />
      ) : kind === "cross" ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : kind === "database" ? (
        <>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v13c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        </>
      ) : (
        <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
      )}
    </svg>
  );
}
function exportSnapshot(snapshot: TwinSnapshot) {
  const href = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = href;
  link.download = `gecco-paired-rehearsal-${snapshot.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
function affectsSide(action: TwinAction | undefined, side: TwinSide) {
  return (
    action === "read-both" ||
    action === "rollback" ||
    (side === "left" && (action === "read-left" || action === "save-left")) ||
    (side === "right" &&
      ["read-right", "save-right", "deploy", "write-new"].includes(
        action || "",
      ))
  );
}
function EventEvidence({ event }: { event: TwinEvent }) {
  return (
    <div className="twin-rehearsal-event-content">
      <p>{event.explanation}</p>
      {event.sql.map((statement, index) => (
        <div className="twin-rehearsal-sql" key={index}>
          <span>Database {statement.databaseId}</span>
          <pre>
            <code>{statement.query}</code>
          </pre>
          {statement.parameters?.length ? (
            <p>
              Parameters: <code>{JSON.stringify(statement.parameters)}</code>
            </p>
          ) : null}
          {statement.error ? (
            <p className="twin-rehearsal-query-error">{statement.error}</p>
          ) : null}
          {statement.rows ? (
            <details>
              <summary>
                Observed rows ({statement.rows.length})<Icon kind="chevron" />
              </summary>
              <pre>
                <code>{JSON.stringify(statement.rows, null, 2)}</code>
              </pre>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}
function BrowserFrame({
  side,
  snapshot,
}: {
  side: TwinSide;
  snapshot: TwinSnapshot | null;
}) {
  const app = snapshot?.apps[side];
  const running = Boolean(
    snapshot?.busy && affectsSide(snapshot.automation.currentAction, side),
  );
  const observation = app?.observation;
  const title =
    side === "left"
      ? "Previous version"
      : app?.release === "v1" && snapshot?.phase === "rollback"
        ? "Rolled back to v1"
        : "Proposed version";
  return (
    <section
      className={`twin-rehearsal-browser ${running ? "active" : ""}`}
      aria-label={title}
    >
      <div className="twin-rehearsal-browser-label">
        <span>
          {title}
          <small
            title={
              app
                ? `App instance: ${app.instanceId} · Database: ${app.databaseId}`
                : undefined
            }
          >
            {app?.release || (side === "left" ? "v1" : "v2")}
          </small>
        </span>
        {snapshot ? (
          <span
            className={`twin-rehearsal-read-status ${app?.stale ? "stale" : observation?.outcome || ""}`}
          >
            {running ? (
              <>
                <span className="twin-rehearsal-spinner" />
                Running
              </>
            ) : app?.stale ? (
              "Needs a fresh read"
            ) : observation ? (
              observation.outcome === "passed" ? (
                <>
                  <Icon kind="check" />
                  Read succeeded
                </>
              ) : observation.outcome === "failed" ? (
                <>
                  <Icon kind="cross" />
                  Read failed
                </>
              ) : (
                "Read incomplete"
              )
            ) : (
              "Not read yet"
            )}
          </span>
        ) : (
          <span className="twin-rehearsal-ready">Ready to open</span>
        )}
      </div>
      <div className="twin-rehearsal-browser-chrome" aria-hidden="true">
        <span className="twin-rehearsal-window-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="twin-rehearsal-address">
          {side === "left" ? "previous.app" : "proposed.app"} / session
        </span>
        <span className="twin-rehearsal-local">local</span>
      </div>
      {snapshot ? (
        <iframe
          className="twin-rehearsal-preview"
          title={`${title}: interactive session app`}
          src={`/preview.html?experiment=${encodeURIComponent(snapshot.id)}&side=${side}`}
        />
      ) : (
        <div
          className="twin-rehearsal-ghost"
          aria-label={`${title} preview opens when the rehearsal starts`}
        >
          <div className="twin-rehearsal-ghost-toolbar">
            <span />
            <span />
          </div>
          <div className="twin-rehearsal-ghost-content">
            <div className="twin-rehearsal-ghost-avatar" />
            <span className="twin-rehearsal-ghost-name" />
            <span className="twin-rehearsal-ghost-line" />
            <div className="twin-rehearsal-ghost-box">
              <span />
              <span />
            </div>
            <p>Your running app appears here.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function observedImpact(snapshot: TwinSnapshot): string {
  const left = !snapshot.apps.left.stale
    ? snapshot.apps.left.observation?.outcome
    : undefined;
  const right = !snapshot.apps.right.stale
    ? snapshot.apps.right.observation?.outcome
    : undefined;
  if (left === "failed" && right === "failed") {
    return snapshot.phase === "rollback" &&
      snapshot.apps.left.release === "v1" &&
      snapshot.apps.right.release === "v1"
      ? "Rollback restored the code, but neither app can open the workspace."
      : "Neither app can open its workspace.";
  }
  if (left === "failed" && right === "passed")
    return "The new app works. The previous app lost access.";
  if (left === "passed" && right === "failed")
    return "The previous app works. The proposed app lost access.";
  if (left === "passed" && right === "passed")
    return snapshot.apps.left.databaseId === snapshot.apps.right.databaseId
      ? "Both apps can open the same workspace."
      : "Both versions work independently.";
  if (left === "failed") return "The previous app cannot open the workspace.";
  if (right === "failed") return "The proposed app cannot open the workspace.";
  if (left === "passed")
    return "The previous app opened the workspace. Check the other app next.";
  if (right === "passed")
    return "The proposed app opened the workspace. Check the other app next.";
  if (left === "inconclusive" || right === "inconclusive")
    return "A read did not finish. The outcome is not established yet.";
  return "The database changed. Waiting for the apps to read it.";
}

export default function TwinRehearsal() {
  const [id, setId] = useState<string | null>(savedId);
  const [snapshot, setSnapshot] = useState<TwinSnapshot | null>(null);
  const [label, setLabel] = useState("Avery");
  const [variant, setVariant] = useState<Variant>("breaking");
  const [requesting, setRequesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [controlRetry, setControlRetry] = useState<"play" | "pause" | null>(
    null,
  );
  const [closeRetry, setCloseRetry] = useState(false);
  const current = useRef<TwinSnapshot | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const restartVariant = useRef<Variant | null>(null);
  function accept(next: TwinSnapshot) {
    if (
      current.current?.id === next.id &&
      current.current.revision > next.revision
    )
      return;
    current.current = next;
    setSnapshot(next);
    setLabel(next.label);
    setVariant(next.variant);
    setExpired(false);
  }
  useEffect(() => {
    if (!id || expired) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = generation.current;
    const poll = async () => {
      if (lock.current) {
        if (live) timer = setTimeout(poll, 700);
        return;
      }
      try {
        const next = await readSnapshot(id);
        if (!live || generation.current !== token) return;
        accept(next);
        setPollError(null);
      } catch (reason) {
        if (!live || generation.current !== token) return;
        if (expiredError(reason)) {
          setExpired(true);
          remember(null);
          setPollError(
            "This experiment expired. Its last observations remain visible. Start a fresh rehearsal to continue.",
          );
          return;
        }
        setPollError(
          `Live state is temporarily unavailable. ${errorMessage(reason)}`,
        );
      }
      if (live) timer = setTimeout(poll, 700);
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, expired, refreshKey]);
  async function control(action: "play" | "pause", activeId = id) {
    if (!activeId || lock.current || expired) return;
    lock.current = true;
    setRequesting(
      action === "play"
        ? "Starting the journey…"
        : "Pausing after the current action…",
    );
    setError(null);
    setControlRetry(action);
    try {
      await inFlightSnapshots.get(activeId)?.catch(() => undefined);
      const next = await request<TwinSnapshot>(
        `/api/twins/${encodeURIComponent(activeId)}/control`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      accept(next);
      setControlRetry(null);
    } catch (reason) {
      if (expiredError(reason)) {
        setExpired(true);
        remember(null);
      }
      if (reason instanceof ApiError && reason.status === 409) {
        setControlRetry(null);
        setRefreshKey((value) => value + 1);
      }
      setError(
        `Could not confirm ${action === "play" ? "resume" : "pause"}. ${errorMessage(reason)} The live state below is refreshed from the server.`,
      );
    } finally {
      lock.current = false;
      setRequesting(null);
    }
  }
  async function start(nextVariant = variant) {
    if (lock.current || !label.trim()) return;
    lock.current = true;
    setRequesting("Opening both apps…");
    setError(null);
    setPollError(null);
    setExpired(false);
    let created: TwinSnapshot | undefined;
    try {
      created = await request<TwinSnapshot>("/api/twins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: nextVariant, label: label.trim() }),
      });
      generation.current += 1;
      current.current = null;
      accept(created);
      setId(created.id);
      remember(created.id);
      setCloseRetry(false);
    } catch (reason) {
      setError(
        `${errorMessage(reason)} If the server created an experiment without returning its ID, that unused experiment will expire automatically.`,
      );
    } finally {
      lock.current = false;
      setRequesting(null);
    }
    if (created) await control("play", created.id);
  }
  async function close(restart?: Variant) {
    if (lock.current) return;
    if (restart) restartVariant.current = restart;
    lock.current = true;
    setRequesting("Closing the previous experiment…");
    setError(null);
    setCloseRetry(true);
    const activeId = id;
    let closed = false;
    try {
      if (activeId)
        await inFlightSnapshots.get(activeId)?.catch(() => undefined);
      if (activeId && !expired) {
        try {
          await request<void>(`/api/twins/${encodeURIComponent(activeId)}`, {
            method: "DELETE",
          });
        } catch (reason) {
          if (!expiredError(reason)) throw reason;
        }
      }
      generation.current += 1;
      remember(null);
      setId(null);
      setSnapshot(null);
      current.current = null;
      setExpired(false);
      setPollError(null);
      setControlRetry(null);
      setCloseRetry(false);
      closed = true;
    } catch (reason) {
      setError(
        `Could not confirm the experiment was closed. ${errorMessage(reason)} Retry closing before starting another.`,
      );
    } finally {
      lock.current = false;
      setRequesting(null);
    }
    if (closed && restartVariant.current) {
      const nextVariant = restartVariant.current;
      restartVariant.current = null;
      setVariant(nextVariant);
      await start(nextVariant);
    }
  }
  const status = snapshot?.automation.status;
  const paused = status === "paused";
  const completed = status === "completed";
  const running = status === "running";
  const latestEvent = snapshot?.events.at(-1);
  const activeAction = snapshot?.automation.currentAction;
  const sameDatabase =
    snapshot &&
    snapshot.apps.left.databaseId === snapshot.apps.right.databaseId;
  const currentObservations = snapshot
    ? [snapshot.apps.left, snapshot.apps.right].filter(
        (app) => app.observation && !app.stale,
      )
    : [];
  const observedFailure = currentObservations.some(
    (app) => app.observation?.outcome === "failed",
  );
  const bothPassed =
    currentObservations.length === 2 &&
    currentObservations.every((app) => app.observation?.outcome === "passed");
  const awaiting = Boolean(requesting || (id && !snapshot));
  return (
    <section className="twin-rehearsal" aria-labelledby="twin-rehearsal-title">
      <header className="twin-rehearsal-header">
        <div>
          <h1 id="twin-rehearsal-title">See the release before you ship it.</h1>
          <p>
            Watch both apps use real data through a rollout and rollback. Pause
            whenever you want to take control.
          </p>
        </div>
        {snapshot ? (
          <span className="twin-rehearsal-session">
            {snapshot.label}
            <span>·</span>
            {snapshot.variant === "compatible"
              ? "Compatibility fix"
              : "Original change"}
          </span>
        ) : null}
      </header>
      {!snapshot ? (
        <div className="twin-rehearsal-setup">
          <label>
            Session name
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={48}
              disabled={awaiting}
              autoComplete="off"
            />
          </label>
          <div
            className="twin-rehearsal-variants"
            aria-label="Migration variant"
          >
            <button
              aria-pressed={variant === "breaking"}
              disabled={awaiting}
              onClick={() => setVariant("breaking")}
            >
              Original change
            </button>
            <button
              aria-pressed={variant === "compatible"}
              disabled={awaiting}
              onClick={() => setVariant("compatible")}
            >
              Compatibility fix
            </button>
          </div>
          <button
            className="twin-rehearsal-primary"
            disabled={awaiting || !label.trim() || Boolean(id)}
            onClick={() => start()}
          >
            {awaiting ? (
              <span className="twin-rehearsal-spinner" />
            ) : (
              <Icon kind="play" />
            )}
            {requesting ||
              (id ? "Restoring your experiment…" : "Run release rehearsal")}
          </button>
        </div>
      ) : null}
      {error || pollError ? (
        <div className="twin-rehearsal-error" role="alert">
          <p>{error || pollError}</p>
          <div>
            {controlRetry && !expired ? (
              <button
                className="twin-rehearsal-secondary"
                disabled={Boolean(requesting)}
                onClick={() => control(controlRetry)}
              >
                Retry {controlRetry === "play" ? "resume" : "pause"}
              </button>
            ) : null}
            {closeRetry ? (
              <button
                className="twin-rehearsal-secondary"
                disabled={Boolean(requesting)}
                onClick={() => close()}
              >
                Retry closing
              </button>
            ) : null}
            {expired ? (
              <button
                className="twin-rehearsal-secondary"
                disabled={Boolean(requesting)}
                onClick={() => close(variant)}
              >
                Start a fresh rehearsal
              </button>
            ) : id ? (
              <button
                className="twin-rehearsal-text-button"
                disabled={Boolean(requesting)}
                onClick={() => {
                  setError(null);
                  setRefreshKey((value) => value + 1);
                }}
              >
                Refresh state
                <Icon kind="refresh" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="twin-rehearsal-stage-row">
        <ol className="twin-rehearsal-stages" aria-label="Release stages">
          {(["baseline", "rollout", "rollback"] as const).map(
            (phase, index) => (
              <li
                className={snapshot?.phase === phase ? "current" : ""}
                aria-current={snapshot?.phase === phase ? "step" : undefined}
                key={phase}
              >
                <span>{index + 1}</span>
                {phaseLabels[phase]}
                {index < 2 ? <Icon kind="chevron" /> : null}
              </li>
            ),
          )}
        </ol>
        {snapshot ? (
          <div className="twin-rehearsal-controls">
            {running ? (
              <button
                className="twin-rehearsal-secondary"
                disabled={Boolean(requesting) || expired}
                onClick={() => control("pause")}
              >
                <Icon kind="pause" />
                Pause & take control
              </button>
            ) : paused || status === "idle" || status === "stopped" ? (
              <button
                className="twin-rehearsal-secondary"
                disabled={Boolean(requesting) || expired}
                onClick={() => control("play")}
              >
                <Icon kind="play" />
                {paused ? "Resume rehearsal" : "Run journey"}
              </button>
            ) : null}
            {completed ? (
              <button
                className="twin-rehearsal-text-button"
                disabled={Boolean(requesting) || expired}
                onClick={() => control("pause")}
              >
                <Icon kind="pause" />
                Take control
              </button>
            ) : null}
            <button
              className="twin-rehearsal-text-button"
              disabled={Boolean(requesting)}
              onClick={() => close()}
              aria-label="Close this experiment and start over"
            >
              <Icon kind="refresh" />
            </button>
          </div>
        ) : null}
      </div>
      {snapshot ? (
        <div
          className={`twin-rehearsal-narration twin-rehearsal-impact ${observedFailure ? "failed" : bothPassed ? "passed" : ""}`}
          aria-live="polite"
        >
          <div className="twin-rehearsal-impact-copy">
            <strong>
              {snapshot.busy || expired ? "Last observed: " : ""}
              {observedImpact(snapshot)}
            </strong>
            <div className="twin-rehearsal-impact-meta">
              <span
                className={`twin-rehearsal-journey-state ${running ? "running" : ""}`}
              >
                {requesting || snapshot.busy ? (
                  <span className="twin-rehearsal-spinner" />
                ) : null}
                {requesting ||
                  (expired
                    ? "Experiment expired"
                    : paused
                      ? "You have control"
                      : completed
                        ? "Journey complete"
                        : running
                          ? `${snapshot.automation.stepIndex}/${snapshot.automation.totalSteps} steps completed`
                          : "Journey ready")}
              </span>
              <p>
                {paused
                  ? snapshot.busy
                    ? "The current action is finishing. Controls unlock afterward."
                    : "Use either app below. Your changes reach the real database."
                  : snapshot.busy && activeAction
                    ? actionCaptions[activeAction]
                    : running && activeAction
                      ? `Next: ${actionCaptions[activeAction].toLowerCase()}`
                      : latestEvent
                        ? `Last action: ${latestEvent.title.toLowerCase()}`
                        : "Waiting for the first observed action."}
              </p>
            </div>
          </div>
          {completed && observedFailure && snapshot.variant === "breaking" ? (
            <button
              className="twin-rehearsal-primary"
              disabled={Boolean(requesting)}
              onClick={() => close("compatible")}
            >
              Try compatibility fix
              <Icon kind="arrow" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="twin-rehearsal-browsers">
        <BrowserFrame side="left" snapshot={snapshot} />
        <BrowserFrame side="right" snapshot={snapshot} />
      </div>
      <div className="twin-rehearsal-topology">
        <Icon kind="database" />
        {snapshot ? (
          sameDatabase ? (
            <>
              <strong>Same database</strong>
              <span>
                {short(snapshot.apps.left.databaseId)} · shared through{" "}
                {snapshot.phase === "rollback" ? "rollback" : "rollout"}
              </span>
            </>
          ) : (
            <>
              <strong>Separate baseline databases</strong>
              <span>
                {short(snapshot.apps.left.databaseId)}
                <Icon kind="arrow" />
                {short(snapshot.apps.right.databaseId)}
              </span>
            </>
          )
        ) : (
          <span>
            Separate baselines first. One shared database through rollout and
            rollback.
          </span>
        )}
      </div>
      {snapshot && (completed || observedFailure || paused) ? (
        <div
          className={`twin-rehearsal-result ${observedFailure ? "failed" : bothPassed ? "passed" : ""}`}
          aria-live="polite"
        >
          <div>
            <h2>
              {observedFailure
                ? snapshot.phase === "rollback"
                  ? "The rollback left data the old app cannot read."
                  : snapshot.phase === "rollout"
                    ? snapshot.apps.left.observation?.outcome === "failed" &&
                      !snapshot.apps.left.stale
                      ? "The previous app breaks during the rollout."
                      : "The proposed app cannot read this session."
                    : "An app cannot read its session."
                : bothPassed
                  ? snapshot.phase === "rollback"
                    ? "Both old apps can read the retained write."
                    : "Both apps read the selected session."
                  : "Inspect the apps at this point in the release."}
            </h2>
            <p>
              {latestEvent?.explanation ||
                "Read either app to observe its behavior."}
            </p>
          </div>
          {completed && snapshot.variant === "compatible" ? (
            <button
              className="twin-rehearsal-secondary"
              disabled={Boolean(requesting)}
              onClick={() => close("breaking")}
            >
              Run original change again
              <Icon kind="arrow" />
            </button>
          ) : null}
        </div>
      ) : null}
      {snapshot ? (
        <details className="twin-rehearsal-evidence">
          <summary>
            <span>Source, SQL & observed history</span>
            <span>
              {snapshot.events.length} events
              <Icon kind="chevron" />
            </span>
          </summary>
          <div className="twin-rehearsal-evidence-content">
            <div className="twin-rehearsal-evidence-heading">
              <p>
                Observed on local PostgreSQL. The release journey follows a
                fixed script.
              </p>
              <button
                className="twin-rehearsal-text-button"
                onClick={() => exportSnapshot(snapshot)}
              >
                <Icon kind="download" />
                Download JSON
              </button>
            </div>
            {snapshot.events.map((event) => (
              <details className="twin-rehearsal-event" key={event.id}>
                <summary>
                  <span>
                    <i className={event.outcome} />
                    {event.title}
                  </span>
                  <span>
                    {new Date(event.at).toLocaleTimeString()}
                    <Icon kind="chevron" />
                  </span>
                </summary>
                <EventEvidence event={event} />
              </details>
            ))}
            <details className="twin-rehearsal-provenance">
              <summary>
                Source identity & scope
                <Icon kind="chevron" />
              </summary>
              <dl>
                <dt>Experiment</dt>
                <dd>{snapshot.id}</dd>
                <dt>Source digest</dt>
                <dd>{snapshot.sourceDigest}</dd>
                <dt>Fixture digest</dt>
                <dd>{snapshot.fixtureDigest}</dd>
              </dl>
              <p>{snapshot.scope}</p>
            </details>
          </div>
        </details>
      ) : null}
      <footer className="twin-rehearsal-footer">
        Synthetic session app · Real browser previews and PostgreSQL execution
        {snapshot
          ? ` · ${snapshot.variant === "compatible" ? "Fresh experiment with the compatibility fix" : "Original migration"}`
          : ""}
      </footer>
    </section>
  );
}
