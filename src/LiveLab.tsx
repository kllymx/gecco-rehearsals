import { useEffect, useRef, useState } from "react";
import type { Variant } from "../shared/contracts";
import type {
  LabAction,
  LabCommand,
  LabEvent,
  LabSnapshot,
} from "../shared/lab";
import "./live-lab.css";

const storageKey = "gecco:live-lab:v1";
const actionLabels: Record<LabAction, string> = {
  "read-old": "Read with v1",
  migrate: "Deploy migration",
  "write-new": "Create a session with v2",
  "read-new": "Read with v2",
  rollback: "Roll back",
};
class RequestError extends Error {
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
    let message = `The local server returned ${response.status}.`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") message = body.error;
    } catch {
      /* Retain the HTTP error when no body is available. */
    }
    throw new RequestError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
function remember(id: string, command?: LabCommand) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ id, command }));
  } catch {
    /* Session remains usable without browser storage. */
  }
}
function forget() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage may be disabled. */
  }
}
function restore(): { id: string; command?: LabCommand } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (!value || typeof value.id !== "string") return null;
    const command = value.command;
    return {
      id: value.id,
      command:
        command &&
        typeof command.commandId === "string" &&
        typeof command.expectedRevision === "number" &&
        command.action in actionLabels
          ? command
          : undefined,
    };
  } catch {
    return null;
  }
}
function Icon({
  kind,
}: {
  kind:
    | "arrow"
    | "check"
    | "cross"
    | "chevron"
    | "database"
    | "download"
    | "refresh";
}) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "arrow" ? (
        <path d="M4 12h15m-6-6 6 6-6 6" />
      ) : kind === "check" ? (
        <path d="m5 12 4 4L19 6" />
      ) : kind === "cross" ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : kind === "chevron" ? (
        <path d="m9 5 7 7-7 7" />
      ) : kind === "database" ? (
        <>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v13c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        </>
      ) : kind === "download" ? (
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      ) : (
        <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
      )}
    </svg>
  );
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The local server did not return a result.";
}
function isExpired(error: unknown) {
  return (
    error instanceof RequestError &&
    (error.status === 404 || error.status === 410)
  );
}
function exportSnapshot(snapshot: LabSnapshot) {
  const href = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = href;
  link.download = `gecco-live-lab-${snapshot.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
function short(value: string, length = 24) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
function nextStep(
  snapshot: LabSnapshot,
): { action: LabAction; title: string; explanation: string } | null {
  const events = snapshot.events;
  const lastIndex = (action: LabAction) =>
    events.map((event) => event.action).lastIndexOf(action);
  if (snapshot.phase === "original")
    return lastIndex("read-old") < 0
      ? {
          action: "read-old",
          title: "First, let the old app read the original session.",
          explanation: "Check the current behavior before you change anything.",
        }
      : {
          action: "migrate",
          title: "Now change the database underneath it.",
          explanation:
            "The old app stays available while the migration changes the schema.",
        };
  if (snapshot.phase === "upgraded") {
    if (lastIndex("read-old") < lastIndex("migrate"))
      return {
        action: "read-old",
        title: "Ask the old app to read the changed database.",
        explanation:
          "This is the overlap between releases. The old code has not changed.",
      };
    if (!snapshot.newSessionId)
      return {
        action: "write-new",
        title: `Create ${snapshot.label}’s session with the new app.`,
        explanation:
          "Watch the stored payload change. This row will stay through rollback.",
      };
    if (lastIndex("read-new") < lastIndex("write-new"))
      return {
        action: "read-new",
        title: "Check that the new app can read its own write.",
        explanation: "Both releases are reading the same selected row.",
      };
    return {
      action: "rollback",
      title: "Roll back the migration. Keep the new write.",
      explanation:
        "Recovery has to work with the data already created by the new version.",
    };
  }
  if (lastIndex("read-old") < lastIndex("rollback"))
    return {
      action: "read-old",
      title: "Can the old app read the session left behind?",
      explanation:
        "The selected row is still in the same database. Try the old reader.",
    };
  return null;
}
function shortReadCause(event: LabEvent) {
  if (event.read?.outcome === "inconclusive")
    return "The read did not complete. See the SQL evidence.";
  const detail = `${event.read?.error || ""} ${event.explanation}`;
  if (/42703|column.+does not exist|renamed that column/i.test(detail))
    return "The migration removed a column this reader still needs.";
  if (/decode|nested principal|session contract/i.test(detail))
    return "The row is still here, but this reader cannot decode its new format.";
  return "The read failed. Open the SQL evidence for the observed error.";
}
function ReadCard({
  release,
  snapshot,
  disabled,
  onRead,
}: {
  release: "v1" | "v2";
  snapshot: LabSnapshot;
  disabled: boolean;
  onRead: () => void;
}) {
  const action = release === "v1" ? "read-old" : "read-new";
  const mutationIndex = snapshot.events.reduce(
    (latest, event, index) =>
      ["migrate", "write-new", "rollback"].includes(event.action)
        ? index
        : latest,
    -1,
  );
  const readIndex = snapshot.events.reduce(
    (latest, event, index) => (event.action === action ? index : latest),
    -1,
  );
  const event = snapshot.events[readIndex];
  const current = Boolean(
    event?.read &&
      readIndex > mutationIndex &&
      event.read.sessionId === snapshot.selectedSessionId,
  );
  return (
    <article className={`live-lab-reader ${current ? event?.outcome : ""}`}>
      <div className="live-lab-reader-heading">
        <span className="live-lab-version">{release}</span>
        <h2>{release === "v1" ? "Old app" : "New app"}</h2>
      </div>
      <p>
        {release === "v1"
          ? "Expects the original session format."
          : "Understands the new session format."}
      </p>
      <div className="live-lab-read-observation" aria-live="polite">
        {current && event?.read ? (
          <>
            <strong>
              {event.read.outcome === "passed" ? (
                <Icon kind="check" />
              ) : (
                <Icon kind="cross" />
              )}
              {event.read.outcome === "passed"
                ? "Session read"
                : event.read.outcome === "failed"
                  ? "Could not read"
                  : "Read incomplete"}
            </strong>
            {event.read.outcome === "passed" ? (
              <dl>
                <dt>User</dt>
                <dd>{event.read.userId || "Not returned"}</dd>
                <dt>Role</dt>
                <dd>{event.read.role || "Not returned"}</dd>
              </dl>
            ) : (
              <p>{shortReadCause(event)}</p>
            )}
          </>
        ) : (
          <>
            <span className="live-lab-read-empty">
              {event
                ? "Database changed since its last read."
                : "No read observed yet."}
            </span>
            <p>Read the selected session to see what happens.</p>
          </>
        )}
      </div>
      <button
        className="live-lab-secondary"
        disabled={disabled || !snapshot.allowedActions.includes(action)}
        onClick={onRead}
      >
        {actionLabels[action]}
        <Icon kind="arrow" />
      </button>
    </article>
  );
}
function EventEvidence({ event }: { event: LabEvent }) {
  return (
    <div className="live-lab-event-evidence">
      <p>{event.explanation}</p>
      {event.sql.map((sql, index) => (
        <div className="live-lab-sql" key={index}>
          <pre>
            <code>{sql.query}</code>
          </pre>
          {sql.parameters?.length ? (
            <p>
              Parameters: <code>{JSON.stringify(sql.parameters)}</code>
            </p>
          ) : null}
          {sql.error ? <p className="live-lab-sql-error">{sql.error}</p> : null}
          {sql.rows ? (
            <details>
              <summary>
                Returned rows ({sql.rows.length})<Icon kind="chevron" />
              </summary>
              <pre>
                <code>{JSON.stringify(sql.rows, null, 2)}</code>
              </pre>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function LiveLab() {
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [label, setLabel] = useState("Avery");
  const [variant, setVariant] = useState<Variant>("breaking");
  const [busy, setBusy] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [unresolved, setUnresolved] = useState<LabCommand | null>(null);
  const [closePending, setClosePending] = useState(false);
  const [changedColumns, setChangedColumns] = useState<string[]>([]);
  const requestLock = useRef(false);
  const restoration = useRef<Promise<LabSnapshot> | null>(null);
  const resetVariant = useRef<Variant | undefined>(undefined);
  const current = useRef<LabSnapshot | null>(null);
  function accept(next: LabSnapshot, pendingCommand?: LabCommand) {
    const before = current.current;
    if (before?.id === next.id && before.revision > next.revision) {
      remember(before.id, pendingCommand);
      return;
    }
    setChangedColumns(
      before
        ? next.columns.filter(
            (column) =>
              !before.columns.includes(column) ||
              JSON.stringify(
                before.rows.find(
                  (row) => row.id === before.selectedSessionId,
                )?.[column],
              ) !==
                JSON.stringify(
                  next.rows.find((row) => row.id === next.selectedSessionId)?.[
                    column
                  ],
                ),
          )
        : [],
    );
    current.current = next;
    setSnapshot(next);
    setLabel(next.label);
    setVariant(next.variant);
    setExpired(false);
    remember(next.id, pendingCommand);
  }
  useEffect(() => {
    const cached = restore();
    if (!cached) {
      setRestoring(false);
      return;
    }
    let live = true;
    restoration.current ||= request<LabSnapshot>(
      `/api/lab/${encodeURIComponent(cached.id)}`,
    );
    restoration.current
      .then((next) => {
        if (!live) return;
        accept(next, cached.command);
        if (cached.command) {
          setUnresolved(cached.command);
          setError(
            "A previous command has no confirmed response in this tab. Retry that same command to recover its result.",
          );
        }
      })
      .catch((reason) => {
        if (!live) return;
        if (isExpired(reason)) {
          forget();
          setExpired(true);
          setError(
            "This database session expired. Start a fresh database to continue.",
          );
        } else
          setError(
            `Could not restore your database session. ${message(reason)}`,
          );
      })
      .finally(() => {
        if (live) setRestoring(false);
      });
    return () => {
      live = false;
    };
  }, []);
  async function start(nextVariant = variant) {
    if (requestLock.current || !label.trim()) return;
    requestLock.current = true;
    setBusy("Starting PostgreSQL…");
    setError(null);
    try {
      const next = await request<LabSnapshot>("/api/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: nextVariant, label: label.trim() }),
      });
      accept(next);
      setUnresolved(null);
      setClosePending(false);
    } catch (reason) {
      setError(
        `${message(reason)} A database may have started without a confirmed response; unused sessions expire automatically.`,
      );
    } finally {
      requestLock.current = false;
      setBusy(null);
    }
  }
  async function refresh(id = snapshot?.id || restore()?.id) {
    if (!id || requestLock.current) return;
    requestLock.current = true;
    setBusy("Refreshing database state…");
    setError(null);
    try {
      const next = await request<LabSnapshot>(
        `/api/lab/${encodeURIComponent(id)}`,
      );
      const outstanding = unresolved || restore()?.command;
      accept(next, outstanding);
      if (outstanding) {
        setUnresolved(outstanding);
        setError(
          "State refreshed. Retry the outstanding command to confirm its recorded outcome.",
        );
      }
    } catch (reason) {
      if (isExpired(reason)) {
        setExpired(true);
        setUnresolved(null);
        forget();
        setError(
          "This database session expired. The observations below are the last recorded state. Start a fresh database to continue.",
        );
      } else setError(`Could not refresh the database. ${message(reason)}`);
    } finally {
      requestLock.current = false;
      setBusy(null);
    }
  }
  async function command(action: LabAction, retry?: LabCommand) {
    if (!snapshot || requestLock.current || expired || (!retry && unresolved))
      return;
    const sent = retry || {
      commandId: crypto.randomUUID(),
      expectedRevision: snapshot.revision,
      action,
    };
    requestLock.current = true;
    setBusy(`${actionLabels[sent.action]}…`);
    setError(null);
    remember(snapshot.id, sent);
    setUnresolved(sent);
    try {
      const next = await request<LabSnapshot>(
        `/api/lab/${encodeURIComponent(snapshot.id)}/commands`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sent),
        },
      );
      accept(next);
      setUnresolved(null);
    } catch (reason) {
      if (isExpired(reason)) {
        setExpired(true);
        setUnresolved(null);
        forget();
        setError(
          "This database session expired. Your last observed state remains visible. Start a fresh database to continue.",
        );
      } else if (reason instanceof RequestError && reason.status === 409) {
        try {
          const next = await request<LabSnapshot>(
            `/api/lab/${encodeURIComponent(snapshot.id)}`,
          );
          accept(next);
          setUnresolved(null);
          setError(
            "The database state changed before this command could run. The current state is now shown. Choose your next action again.",
          );
        } catch (refreshError) {
          setError(
            `The server reported a state conflict, but refresh failed. ${message(refreshError)} Retry the same command or refresh before continuing.`,
          );
        }
      } else if (
        reason instanceof RequestError &&
        reason.status >= 400 &&
        reason.status < 500
      ) {
        setUnresolved(null);
        remember(snapshot.id);
        setError(message(reason));
      } else
        setError(
          `The result is not confirmed. ${message(reason)} Retry the same command to recover its result, or refresh the database state.`,
        );
    } finally {
      requestLock.current = false;
      setBusy(null);
    }
  }
  async function reset(nextVariant?: Variant) {
    if (requestLock.current) return;
    if (nextVariant) resetVariant.current = nextVariant;
    requestLock.current = true;
    setBusy("Closing this database…");
    setError(null);
    try {
      const id = snapshot?.id || restore()?.id;
      if (id && !expired) {
        try {
          await request<void>(`/api/lab/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
        } catch (reason) {
          if (!isExpired(reason)) throw reason;
        }
      }
      forget();
      current.current = null;
      setSnapshot(null);
      setUnresolved(null);
      setExpired(false);
      setClosePending(false);
      setChangedColumns([]);
      if (resetVariant.current) setVariant(resetVariant.current);
      resetVariant.current = undefined;
    } catch (reason) {
      setClosePending(true);
      setError(
        `Could not confirm this database was closed. ${message(reason)} Retry closing it before starting another.`,
      );
    } finally {
      requestLock.current = false;
      setBusy(null);
    }
  }
  const blocked = Boolean(busy || unresolved || closePending || expired);
  const lastEvent = snapshot?.events.at(-1);
  const selectedRow = snapshot?.rows.find(
    (row) => row.id === snapshot.selectedSessionId,
  );
  const payloadColumns =
    snapshot?.columns.filter((column) => column !== "id") || [];
  const guided = snapshot ? nextStep(snapshot) : null;
  const completed = Boolean(
    snapshot && snapshot.phase === "rolled-back" && !guided,
  );
  return (
    <section className="live-lab" aria-labelledby="live-lab-title">
      <header className="live-lab-header">
        <p className="live-lab-eyebrow">Live release experiment</p>
        <h1 id="live-lab-title">Break it yourself.</h1>
        <p>
          Change a real database while two versions of the app try to use it.
          Create your own session, then see what survives a rollback.
        </p>
      </header>
      {error ? (
        <div className="live-lab-error" role="alert">
          <p>{error}</p>
          <div>
            {unresolved && !expired ? (
              <button
                className="live-lab-secondary"
                disabled={Boolean(busy)}
                onClick={() => command(unresolved.action, unresolved)}
              >
                Retry {actionLabels[unresolved.action].toLowerCase()}
              </button>
            ) : null}
            {closePending ? (
              <button
                className="live-lab-secondary"
                disabled={Boolean(busy)}
                onClick={() => reset()}
              >
                Retry closing database
              </button>
            ) : !expired && (snapshot || restore()?.id) ? (
              <button
                className="live-lab-text-button"
                disabled={Boolean(busy)}
                onClick={() => refresh()}
              >
                Refresh state
                <Icon kind="refresh" />
              </button>
            ) : null}
            {expired && snapshot ? (
              <button
                className="live-lab-secondary"
                onClick={() => reset(variant)}
              >
                Start fresh
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!snapshot ? (
        <div className="live-lab-setup">
          <div className="live-lab-setup-fields">
            <label>
              Session name
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={Boolean(busy) || restoring}
                maxLength={48}
                autoComplete="off"
                placeholder="Avery"
              />
            </label>
            <fieldset disabled={Boolean(busy) || restoring}>
              <legend>Migration to try</legend>
              <div className="live-lab-variant">
                <button
                  type="button"
                  aria-pressed={variant === "breaking"}
                  onClick={() => setVariant("breaking")}
                >
                  Original change
                </button>
                <button
                  type="button"
                  aria-pressed={variant === "compatible"}
                  onClick={() => setVariant("compatible")}
                >
                  Compatibility fix
                </button>
              </div>
            </fieldset>
          </div>
          <button
            className="live-lab-primary"
            disabled={
              Boolean(busy) ||
              restoring ||
              !label.trim() ||
              Boolean(restore()?.id)
            }
            onClick={() => start()}
          >
            {busy ||
              (restoring ? "Restoring your session…" : "Start a real database")}
            {busy || restoring ? (
              <span className="live-lab-spinner" />
            ) : (
              <Icon kind="arrow" />
            )}
          </button>
          <p>
            Disposable PostgreSQL. Your session name stays in this local
            example.
          </p>
        </div>
      ) : (
        <>
          <div className="live-lab-session-bar">
            <span>
              <span
                className="live-lab-live-dot"
                style={expired ? { background: "#7c897e" } : undefined}
              />
              {snapshot.label}’s experiment
              <span className="live-lab-session-divider">/</span>
              {snapshot.variant === "breaking"
                ? "Original change"
                : "Compatibility fix"}
            </span>
            <button
              className="live-lab-text-button"
              disabled={Boolean(busy)}
              onClick={() => reset()}
            >
              Close and start over
              <Icon kind="refresh" />
            </button>
          </div>
          {guided &&
          snapshot.allowedActions.includes(guided.action) &&
          !expired ? (
            <div className="live-lab-next live-lab-next-toolbar">
              <div>
                <span className="live-lab-eyebrow">Try this next</span>
                <h2>{guided.title}</h2>
                <p>{guided.explanation}</p>
              </div>
              <button
                className="live-lab-primary"
                disabled={blocked}
                onClick={() => command(guided.action)}
              >
                {actionLabels[guided.action]}
                <Icon kind="arrow" />
              </button>
            </div>
          ) : null}
          {completed && !expired ? (
            <div className="live-lab-next live-lab-next-toolbar">
              <div>
                <span className="live-lab-eyebrow">
                  You reached the rollback
                </span>
                <h2>
                  {snapshot.variant === "breaking"
                    ? "Try the same experiment with the fix."
                    : "You can keep testing the old reader."}
                </h2>
                <p>
                  {snapshot.variant === "breaking"
                    ? `Close this database, then start fresh with the same name, ${snapshot.label}, and a compatibility-preserving migration.`
                    : "The session stays in this database until you close it or it expires."}
                </p>
              </div>
              {snapshot.variant === "breaking" ? (
                <button
                  className="live-lab-primary"
                  disabled={Boolean(busy)}
                  onClick={() => reset("compatible")}
                >
                  Set up the compatibility fix
                  <Icon kind="arrow" />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="live-lab-canvas">
            <ReadCard
              release="v1"
              snapshot={snapshot}
              disabled={blocked}
              onRead={() => command("read-old")}
            />
            <section
              className="live-lab-database"
              aria-labelledby="live-lab-database-title"
            >
              <div className="live-lab-database-heading">
                <span>
                  <Icon kind="database" />
                  <h2 id="live-lab-database-title">Shared database</h2>
                </span>
                <span>
                  {snapshot.phase === "original"
                    ? "Original schema"
                    : snapshot.phase === "upgraded"
                      ? "Migration deployed"
                      : "Migration rolled back"}
                </span>
              </div>
              <div className="live-lab-row-heading">
                <span>
                  Selected session ·{" "}
                  {snapshot.newSessionId === snapshot.selectedSessionId
                    ? "written by v2"
                    : "written by v1"}
                </span>
                <strong>{snapshot.label}</strong>
                <code title={snapshot.selectedSessionId}>
                  {short(snapshot.selectedSessionId, 32)}
                </code>
              </div>
              <div className="live-lab-payloads">
                {selectedRow ? (
                  payloadColumns.map((column) => (
                    <article
                      className={
                        changedColumns.includes(column)
                          ? "live-lab-payload-changed"
                          : ""
                      }
                      key={`${snapshot.revision}-${column}`}
                    >
                      <h3>
                        <code>{column}</code>
                        {changedColumns.includes(column) ? (
                          <span>changed</span>
                        ) : null}
                      </h3>
                      <pre>
                        <code>
                          {JSON.stringify(selectedRow[column], null, 2) ??
                            "undefined"}
                        </code>
                      </pre>
                    </article>
                  ))
                ) : (
                  <p>No row found for the selected session in this snapshot.</p>
                )}
              </div>
              <div className="live-lab-db-footer">
                <span>
                  {snapshot.rows.length}{" "}
                  {snapshot.rows.length === 1 ? "row" : "rows"} · revision{" "}
                  {snapshot.revision}
                </span>
                <span title={snapshot.databaseId}>
                  Database {short(snapshot.databaseId, 8)}
                </span>
              </div>
            </section>
            <ReadCard
              release="v2"
              snapshot={snapshot}
              disabled={blocked}
              onRead={() => command("read-new")}
            />
          </div>
          {busy ? (
            <div className="live-lab-pending" role="status">
              <span className="live-lab-spinner" />
              {busy}
              <span>Waiting for the database response.</span>
            </div>
          ) : null}
          {lastEvent ? (
            <section
              className={`live-lab-last-event ${lastEvent.outcome}`}
              aria-live="polite"
            >
              <span className="live-lab-event-mark">
                <Icon
                  kind={
                    lastEvent.outcome === "passed"
                      ? "check"
                      : lastEvent.outcome === "failed"
                        ? "cross"
                        : "database"
                  }
                />
              </span>
              <div>
                <h2>{lastEvent.title}</h2>
                <p>{lastEvent.explanation}</p>
                <details>
                  <summary>
                    See the SQL
                    <Icon kind="chevron" />
                  </summary>
                  <EventEvidence event={lastEvent} />
                </details>
              </div>
            </section>
          ) : null}
          <div className="live-lab-free-actions">
            {snapshot.allowedActions
              .filter(
                (action) =>
                  ["migrate", "write-new", "rollback"].includes(action) &&
                  action !== guided?.action,
              )
              .map((action) => (
                <button
                  className="live-lab-secondary"
                  key={action}
                  disabled={blocked}
                  onClick={() => command(action)}
                >
                  {actionLabels[action]}
                </button>
              ))}
          </div>
          <details className="live-lab-history">
            <summary>
              <span>
                Experiment history · {snapshot.events.length} observed events
              </span>
              <Icon kind="chevron" />
            </summary>
            <div className="live-lab-history-content">
              <div className="live-lab-history-heading">
                <span>Same database: {snapshot.databaseId}</span>
                <button
                  className="live-lab-text-button"
                  onClick={() => exportSnapshot(snapshot)}
                >
                  <Icon kind="download" />
                  Download JSON
                </button>
              </div>
              {snapshot.events.map((event) => (
                <details className="live-lab-history-event" key={event.id}>
                  <summary>
                    <span>
                      <span
                        className={`live-lab-history-dot ${event.outcome}`}
                      />
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
              <details className="live-lab-provenance">
                <summary>
                  Source and scope
                  <Icon kind="chevron" />
                </summary>
                <dl>
                  <dt>Source digest</dt>
                  <dd>{snapshot.sourceDigest}</dd>
                  <dt>Fixture digest</dt>
                  <dd>{snapshot.fixtureDigest}</dd>
                </dl>
                <p>{snapshot.scope}</p>
              </details>
            </div>
          </details>
        </>
      )}
      <footer className="live-lab-footer">
        Synthetic session example · Real PostgreSQL in PGlite · One database
        retained through this experiment
      </footer>
    </section>
  );
}
