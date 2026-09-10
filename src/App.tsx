import { useEffect, useRef, useState } from "react";
import InteractionPanel from "./InteractionPanel";
import LiveLab from "./LiveLab";
import TwinRehearsal from "./TwinRehearsal";
import CloudRehearsal, { FixtureCloudRehearsal } from "./CloudRehearsal";
import type {
  AnalysisResult,
  Outcome,
  RehearsalRun,
  ScenarioId,
  ScenarioResult,
  Specimen,
  Variant,
} from "../shared/contracts";
type IconName =
  | "arrow"
  | "check"
  | "close"
  | "code"
  | "database"
  | "download"
  | "history"
  | "play"
  | "refresh"
  | "spark"
  | "terminal"
  | "shield"
  | "chevron"
  | "external";
const iconPaths: Record<IconName, React.ReactNode> = {
  arrow: (
    <>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  code: (
    <>
      <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  history: (
    <>
      <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8z" />,
  refresh: (
    <>
      <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 6 6 6-6 6m9 0h7" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  external: (
    <>
      <path d="M13 3h8v8m0-8L10 14M9 3H3v18h18v-6" />
    </>
  ),
};
function Icon({
  name,
  size = 18,
  className = "",
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {iconPaths[name]}
    </svg>
  );
}
const phaseInfo: {
  id: ScenarioId;
  eyebrow: string;
  name: string;
  description: string;
}[] = [
  {
    id: "control",
    eyebrow: "Before the change",
    name: "Current app",
    description: "Read sessions in the original format.",
  },
  {
    id: "upgrade",
    eyebrow: "After the upgrade",
    name: "New app",
    description: "Read sessions in the new format.",
  },
  {
    id: "mixed",
    eyebrow: "During the rollout",
    name: "Old + new apps",
    description: "Keep older instances working.",
  },
  {
    id: "rollback",
    eyebrow: "If you roll back",
    name: "Old app, new data",
    description: "Read sessions the new app created.",
  },
];
const labels: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Inconclusive",
};
const dateTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const fullDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
function timeLabel(value: string, full = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : (full ? fullDateTime : dateTime).format(date);
}
function durationLabel(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
function runOutcome(run: RehearsalRun): Outcome {
  return run.scenarios.some((s) => s.outcome === "failed")
    ? "failed"
    : run.scenarios.length !== 4 ||
        run.scenarios.some((s) => s.outcome === "inconclusive")
      ? "inconclusive"
      : "passed";
}
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail =
        typeof body.error === "string"
          ? body.error
          : typeof body.message === "string"
            ? body.message
            : "";
    } catch {
      /* Fall back to HTTP status. */
    }
    throw new Error(
      detail ||
        `Request failed (${response.status}). Check that the local server is running and try again.`,
    );
  }
  return response.json();
}
function Status({ outcome }: { outcome?: Outcome }) {
  return (
    <span className={`status ${outcome || "waiting"}`}>
      {outcome ? labels[outcome] : "Not run"}
    </span>
  );
}
function downloadRun(run: RehearsalRun) {
  const href = URL.createObjectURL(
    new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = href;
  link.download = `gecco-rehearsal-${run.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
function Rows({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length)
    return <div className="empty-rows">Query returned no rows.</div>;
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="rows-scroll">
      <table className="rows-table">
        <thead>
          <tr>
            {keys.map((key) => (
              <th key={key}>{key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {keys.map((key) => (
                <td key={key}>
                  {row[key] === null ? (
                    <span className="null-value">NULL</span>
                  ) : typeof row[key] === "object" ? (
                    JSON.stringify(row[key])
                  ) : (
                    String(row[key] ?? "")
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function EvidenceDrawer({
  scenario,
  run,
  close,
}: {
  scenario: ScenarioResult;
  run: RehearsalRun;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const snapshotHasMarkedRow = (label: string) =>
    scenario.steps.some(
      (step) =>
        step.label === label &&
        step.outcome === "passed" &&
        step.rows?.some(
          (row) =>
            Array.isArray(row.sessions) &&
            row.sessions.some(
              (session: unknown) =>
                session !== null &&
                typeof session === "object" &&
                "id" in session &&
                session.id === scenario.markedWriteId,
            ),
        ),
    );
  const rollbackObserved =
    scenario.id === "rollback" &&
    scenario.steps.some(
      (step) =>
        step.label === "Roll back migration on the same database" &&
        step.outcome === "passed",
    ) &&
    snapshotHasMarkedRow(
      "Capture state with the marked v2 write before rollback · SQL",
    ) &&
    snapshotHasMarkedRow("Capture final preserved database state · SQL");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="evidence-drawer"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="drawer-content">
        <div className="drawer-top">
          <div className="heading-with-icon">
            <Icon name="terminal" />
            <span className="subtle-label">EXECUTION EVIDENCE</span>
          </div>
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close evidence"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-title">
          <div className="eyebrow">
            {phaseInfo.find((p) => p.id === scenario.id)?.eyebrow}
          </div>
          <h2>{scenario.title}</h2>
          <Status outcome={scenario.outcome} />
          <p>{scenario.explanation}</p>
        </div>
        <div className="expectation">
          <span className="subtle-label">CONTRACT EXPECTATION</span>
          <p>{scenario.expected}</p>
        </div>
        <div className="trace-heading">
          <h3>What PostgreSQL observed</h3>
          <span>
            {scenario.steps.length} steps · {durationLabel(scenario.durationMs)}
          </span>
        </div>
        <ol className="trace-timeline">
          {scenario.steps.map((step, index) => (
            <li key={step.id} className={`trace-step ${step.outcome}`}>
              <span className="trace-marker">
                {step.outcome === "passed" ? (
                  <Icon name="check" size={12} />
                ) : step.outcome === "failed" ? (
                  <Icon name="close" size={12} />
                ) : (
                  index + 1
                )}
              </span>
              <details
                open={
                  step.outcome !== "passed" ||
                  index === scenario.steps.length - 1
                }
              >
                <summary>
                  <span>{step.label}</span>
                  <span className="trace-duration">
                    {durationLabel(step.durationMs)}
                    <Icon name="chevron" size={13} />
                  </span>
                </summary>
                <div className="step-content">
                  {step.sql ? (
                    <pre className="sql-block">
                      <code>{step.sql}</code>
                    </pre>
                  ) : null}
                  <p className="step-observation">{step.observation}</p>
                  {step.rows ? <Rows rows={step.rows} /> : null}
                </div>
              </details>
            </li>
          ))}
        </ol>
        {scenario.markedWriteId ? (
          <div className="retained-write">
            <Icon name="database" />
            <div>
              <strong>
                {rollbackObserved
                  ? "New-version write retained through rollback"
                  : "Marked trial write"}
              </strong>
              <p>
                {rollbackObserved
                  ? "The rollback trial preserved row "
                  : "This trial identifies its write as "}
                <code>{scenario.markedWriteId}</code>. Inspect the steps above
                for the observed write and read outcomes.
              </p>
            </div>
          </div>
        ) : null}
        <details className="provenance">
          <summary>
            Run provenance
            <Icon name="chevron" size={14} />
          </summary>
          <dl>
            <dt>Engine</dt>
            <dd>PGlite · PostgreSQL in WASM</dd>
            <dt>Run</dt>
            <dd>{run.id}</dd>
            <dt>Completed</dt>
            <dd>{timeLabel(run.completedAt, true)}</dd>
            <dt>Fixture</dt>
            <dd>{scenario.fixtureId}</dd>
            <dt>State fingerprint</dt>
            <dd>{scenario.stateFingerprint}</dd>
            <dt>Source digest</dt>
            <dd>{run.sourceDigest}</dd>
            <dt>Fixture digest</dt>
            <dd>{run.fixtureDigest}</dd>
          </dl>
          <p>{run.scope}</p>
        </details>
        <div className="drawer-footer">
          <span>Observed locally. Inspectable by you.</span>
          <button
            className="button secondary compact"
            onClick={() => downloadRun(run)}
          >
            <Icon name="download" size={15} />
            Export JSON
          </button>
        </div>
      </div>
    </dialog>
  );
}

function analysisSource(specimen: Specimen, variant: Variant): string {
  return JSON.stringify({
    contract: specimen.contract,
    files: specimen.files.map((file) => ({
      path: file.path,
      before: file.before,
      after: file[variant],
    })),
  });
}
function readAnalysisCache(
  specimen: Specimen,
  variant: Variant,
): AnalysisResult | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(`gecco:analysis:v1:${variant}`) || "null",
    );
    const result = value?.result;
    if (
      value?.source !== analysisSource(specimen, variant) ||
      result?.status !== "completed" ||
      typeof result.summary !== "string" ||
      typeof result.provider !== "string" ||
      typeof result.generatedAt !== "string" ||
      !Array.isArray(result.hypotheses) ||
      typeof result.suggestedFix !== "string"
    )
      return null;
    return result;
  } catch {
    return null;
  }
}
function writeAnalysisCache(
  specimen: Specimen,
  variant: Variant,
  result: AnalysisResult,
) {
  try {
    localStorage.setItem(
      `gecco:analysis:v1:${variant}`,
      JSON.stringify({ source: analysisSource(specimen, variant), result }),
    );
  } catch {
    /* The live result remains usable when browser storage is unavailable. */
  }
}

function ReleaseDemo() {
  const [specimen, setSpecimen] = useState<Specimen | null>(null);
  const [runs, setRuns] = useState<RehearsalRun[]>([]);
  const [activeRun, setActiveRun] = useState<RehearsalRun | null>(null);
  const [variant, setVariant] = useState<Variant>("breaking");
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<
    Partial<Record<Variant, AnalysisResult>>
  >({});
  const [recordedAnalysis, setRecordedAnalysis] = useState<
    Partial<Record<Variant, boolean>>
  >({});
  const [analyzing, setAnalyzing] = useState<Variant | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ScenarioResult | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const requestLock = useRef(false);
  const selectionGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setHistoryError(null);
    Promise.allSettled([
      api<Specimen>("/api/specimen", { signal: controller.signal }),
      api<RehearsalRun[]>("/api/runs", { signal: controller.signal }),
    ]).then(([specimenResult, historyResult]) => {
      if (controller.signal.aborted) return;
      if (specimenResult.status === "fulfilled") {
        setSpecimen(specimenResult.value);
        const restored: Partial<Record<Variant, AnalysisResult>> = {};
        const recorded: Partial<Record<Variant, boolean>> = {};
        for (const cachedVariant of ["breaking", "compatible"] as const) {
          const result = readAnalysisCache(specimenResult.value, cachedVariant);
          if (result) {
            restored[cachedVariant] = result;
            recorded[cachedVariant] = true;
          }
        }
        setAnalysis(restored);
        setRecordedAnalysis(recorded);
      } else
        setError(
          `Couldn’t load the specimen. ${specimenResult.reason instanceof Error ? specimenResult.reason.message : "Try again."}`,
        );
      if (historyResult.status === "fulfilled") setRuns(historyResult.value);
      else
        setHistoryError(
          "Run history is unavailable. You can still start a new rehearsal.",
        );
      setLoading(false);
    });
    return () => controller.abort();
  }, [loadAttempt]);
  const sourceChanged = Boolean(
    activeRun &&
    specimen &&
    (!specimen.inputDigests ||
      activeRun.sourceDigest !==
        specimen.inputDigests[activeRun.variant].sourceDigest ||
      activeRun.fixtureDigest !==
        specimen.inputDigests[activeRun.variant].fixtureDigest),
  );
  const currentAnalysis = sourceChanged ? undefined : analysis[variant];
  const outcome = activeRun ? runOutcome(activeRun) : undefined;
  const passed =
    activeRun?.scenarios.filter((scenario) => scenario.outcome === "passed")
      .length || 0;
  const failures =
    activeRun?.scenarios.filter((scenario) => scenario.outcome === "failed") ||
    [];
  function changeVariant(next: Variant) {
    selectionGeneration.current += 1;
    setVariant(next);
    setActiveRun(null);
    setError(null);
    setAnalysisError(null);
    setEvidence(null);
  }
  async function runRehearsal(next = variant) {
    if (requestLock.current) return;
    selectionGeneration.current += 1;
    requestLock.current = true;
    setRunning(true);
    setVariant(next);
    setActiveRun(null);
    setError(null);
    setEvidence(null);
    try {
      const result = await api<RehearsalRun>("/api/rehearse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: next }),
      });
      setActiveRun(result);
      setRuns((history) => [
        result,
        ...history.filter((run) => run.id !== result.id),
      ]);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The rehearsal could not complete. Try again.",
      );
    } finally {
      requestLock.current = false;
      setRunning(false);
    }
  }
  async function analyze() {
    if (analyzing) return;
    const requestedVariant = variant;
    setAnalyzing(requestedVariant);
    setAnalysisError(null);
    try {
      const result = await api<AnalysisResult>("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: requestedVariant }),
      });
      setAnalysis((previous) => ({ ...previous, [requestedVariant]: result }));
      setRecordedAnalysis((previous) => ({
        ...previous,
        [requestedVariant]: false,
      }));
      if (specimen && result.status === "completed")
        writeAnalysisCache(specimen, requestedVariant, result);
    } catch (reason) {
      setAnalysisError(
        reason instanceof Error
          ? reason.message
          : "Analysis could not complete. Try again.",
      );
    } finally {
      setAnalyzing(null);
    }
  }
  async function selectRun(run: RehearsalRun) {
    if (running) return;
    const generation = ++selectionGeneration.current;
    setError(null);
    try {
      const saved = await api<RehearsalRun>(
        `/api/runs/${encodeURIComponent(run.id)}`,
      );
      if (generation !== selectionGeneration.current) return;
      setVariant(saved.variant);
      setActiveRun(saved);
      setEvidence(null);
    } catch (reason) {
      if (generation === selectionGeneration.current)
        setError(
          reason instanceof Error ? reason.message : "Could not load this run.",
        );
    }
  }

  const current = (id: ScenarioId) =>
    activeRun?.scenarios.find((s) => s.id === id);
  const transitionFailure =
    current("control")?.outcome === "passed" &&
    current("upgrade")?.outcome === "passed" &&
    current("mixed")?.outcome === "failed" &&
    current("rollback")?.outcome === "failed";
  const outcomeTitle = transitionFailure
    ? "Both versions work. The rollout breaks."
    : outcome === "passed"
      ? variant === "compatible"
        ? "The fix keeps sessions readable."
        : "Sessions stayed readable in all four checks."
      : outcome === "inconclusive"
        ? "The rehearsal could not finish."
        : outcome === "failed"
          ? "This change failed a compatibility check."
          : "";
  return (
    <>
      <header className="page-heading">
        <span className="page-kicker">Release rehearsal</span>
        <h1>Will sessions survive this release?</h1>
        <p>
          A change updates how sessions are stored. Gecco runs the upgrade,
          rollout, and rollback to find where older code stops working.
        </p>
      </header>
      <div className="change-summary">
        <span className="change-icon">
          <Icon name="code" size={19} />
        </span>
        <div>
          <strong>
            {variant === "compatible"
              ? "Keep both session formats readable"
              : "Move sessions to a new data format"}
          </strong>
          <p>
            {variant === "compatible"
              ? "Write both formats so older instances can still read new sessions."
              : "A small database migration and an updated session reader."}
          </p>
        </div>
        <button
          className="text-button"
          onClick={() => setShowSource(!showSource)}
        >
          {showSource ? "Hide change" : "View change"}
          <Icon name="chevron" size={14} />
        </button>
      </div>
      {showSource && (
        <section className="source-panel panel">
          <div className="section-title">
            <h2>
              {variant === "compatible"
                ? "Prepared compatibility fix"
                : "The proposed change"}
            </h2>
            <span>Bundled example</span>
          </div>
          {sourceChanged ? (
            <p className="muted">
              This result used different source inputs. Its original
              observations and input digests are available in Export result.
            </p>
          ) : (
            specimen?.files.map((file) => (
              <details key={file.path} className="source-file">
                <summary>{file.path}</summary>
                <div className="source-columns">
                  <div>
                    <span>Current version</span>
                    <pre>{file.before}</pre>
                  </div>
                  <div>
                    <span>
                      {variant === "compatible"
                        ? "Compatibility fix"
                        : "Proposed version"}
                    </span>
                    <pre>{file[variant]}</pre>
                  </div>
                </div>
              </details>
            ))
          )}
        </section>
      )}
      <section
        className="rehearsal-card panel"
        aria-label="Release checks"
        aria-busy={running}
      >
        <div className="rehearsal-heading">
          <div>
            <h2>Rehearse the release</h2>
            <p>Four checks. The same session must stay readable.</p>
          </div>
          {!activeRun && (
            <button
              className="button primary"
              disabled={running || !specimen}
              onClick={() => runRehearsal()}
            >
              {running ? (
                <span className="spinner" />
              ) : (
                <Icon name="play" size={15} />
              )}{" "}
              {running
                ? "Running checks…"
                : variant === "compatible"
                  ? "Test compatibility fix"
                  : "Rehearse this change"}
            </button>
          )}
          {activeRun && (
            <span className={`result-count ${outcome}`}>
              <Icon
                name={
                  outcome === "passed"
                    ? "check"
                    : outcome === "failed"
                      ? "close"
                      : "refresh"
                }
                size={16}
              />
              {passed} of 4 checks passed
            </span>
          )}
        </div>
        <div className="checks-grid">
          {phaseInfo.map((phase, index) => {
            const observed = current(phase.id);
            return (
              <button
                key={phase.id}
                className={`check-card ${observed?.outcome || ""}`}
                disabled={!observed || running}
                onClick={() => setEvidence(observed!)}
                aria-label={`${phase.name}: ${observed ? labels[observed.outcome] : running ? "pending" : "not run"}${observed ? ". Inspect evidence" : ""}`}
              >
                <span className="check-stage">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {phase.eyebrow}
                </span>
                <span className={`check-symbol ${observed?.outcome || ""}`}>
                  <Icon
                    name={
                      observed?.outcome === "passed"
                        ? "check"
                        : observed?.outcome === "failed"
                          ? "close"
                          : observed?.outcome === "inconclusive"
                            ? "refresh"
                            : index > 1
                              ? "history"
                              : "code"
                    }
                    size={23}
                  />
                </span>
                <h3>{phase.name}</h3>
                <p>{phase.description}</p>
                <span className="check-footer">
                  {observed ? (
                    <>
                      <Status outcome={observed.outcome} />
                      <Icon name="arrow" size={16} />
                    </>
                  ) : (
                    <span>
                      {running ? "Waiting for results" : "Ready to check"}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {!activeRun && (
          <p className="execution-note">
            {running
              ? "Executing in disposable databases. Results appear when all checks finish."
              : "Each check starts from the same fixture. Rollback keeps the new writes."}
          </p>
        )}
        {activeRun && (
          <div className={`release-result ${outcome}`} aria-live="polite">
            <div>
              <h3>{outcomeTitle}</h3>
              <p>
                {transitionFailure
                  ? "Older instances can’t read sessions during rollout. Rolling back still leaves them unable to read the new data."
                  : outcome === "passed"
                    ? "Current, upgraded, mixed-version, and rollback checks all passed for this example."
                    : outcome === "inconclusive"
                      ? "A setup or execution problem left incomplete evidence. Inspect the affected check before drawing a conclusion."
                      : `${failures.length} ${failures.length === 1 ? "check violated" : "checks violated"} the declared session compatibility contract. Open a failed check to see why.`}
              </p>
            </div>
            {variant === "breaking" && outcome === "failed" ? (
              <button
                className="button primary"
                onClick={() => runRehearsal("compatible")}
                disabled={running}
              >
                Test compatibility fix
                <Icon name="arrow" size={16} />
              </button>
            ) : (
              <button
                className="button secondary"
                onClick={() => runRehearsal()}
                disabled={running}
              >
                <Icon name="refresh" size={15} />
                Run again
              </button>
            )}
          </div>
        )}
      </section>
      {error && (
        <div className="error-banner" role="alert">
          <div>
            <strong>Couldn’t complete the rehearsal</strong>
            <p>{error}</p>
          </div>
          <button
            className="button secondary"
            disabled={running}
            onClick={() =>
              specimen ? runRehearsal() : setLoadAttempt((n) => n + 1)
            }
          >
            Try again
          </button>
        </div>
      )}
      <div className="below-checks">
        <p>
          {activeRun ? (
            <>
              Executed {timeLabel(activeRun.completedAt)} ·{" "}
              {durationLabel(activeRun.durationMs)} · PostgreSQL
            </>
          ) : (
            "Runs in a disposable PostgreSQL database."
          )}
        </p>
        <div>
          {activeRun && (
            <button
              className="text-button"
              onClick={() => downloadRun(activeRun)}
            >
              <Icon name="download" size={14} />
              Export result
            </button>
          )}
          {(activeRun || variant === "compatible") && (
            <button
              className="text-button"
              disabled={running}
              onClick={() => changeVariant("breaking")}
            >
              Start over
            </button>
          )}
        </div>
      </div>
      <details className="disclosure ai-disclosure">
        <summary>
          <span>
            <Icon name="spark" size={17} />{" "}
            {variant === "compatible"
              ? "Ask Astra about the fix"
              : "Ask Astra about this change"}
          </span>
          <Icon name="chevron" size={16} />
        </summary>
        <div className="disclosure-body">
          <p className="muted">
            Astra reads the selected change and explains possible failure
            points. The database checks establish what actually happens.
          </p>
          {currentAnalysis?.status === "completed" && (
            <div className="analysis-copy">
              <div className="analysis-label">
                {recordedAnalysis[variant]
                  ? "Recorded analysis"
                  : "Live analysis"}{" "}
                · {currentAnalysis.model || currentAnalysis.provider} ·{" "}
                {timeLabel(currentAnalysis.generatedAt, true)}
              </div>
              <p>{currentAnalysis.summary}</p>
              {currentAnalysis.hypotheses.map((h) => (
                <details key={h.scenarioId}>
                  <summary>
                    {phaseInfo.find((p) => p.id === h.scenarioId)?.name}:{" "}
                    {h.risk}
                  </summary>
                  <p>{h.rationale}</p>
                </details>
              ))}
              <p>
                <strong>Suggested approach</strong>
                <br />
                {currentAnalysis.suggestedFix}
              </p>
            </div>
          )}
          {currentAnalysis && currentAnalysis.status !== "completed" && (
            <p role="status">
              {currentAnalysis.error || currentAnalysis.summary}
            </p>
          )}
          {analysisError && (
            <p className="error-text" role="alert">
              {analysisError}
            </p>
          )}
          {sourceChanged && (
            <p className="muted">
              Analysis is unavailable for this older source snapshot.
            </p>
          )}
          <button
            className="button secondary"
            disabled={Boolean(analyzing) || !specimen || sourceChanged}
            onClick={analyze}
          >
            {analyzing ? (
              <span className="spinner" />
            ) : (
              <Icon name="spark" size={15} />
            )}{" "}
            {analyzing
              ? "Astra is analyzing…"
              : currentAnalysis
                ? "Request fresh analysis"
                : "Ask Astra"}
          </button>
        </div>
      </details>
      <details className="disclosure">
        <summary>
          <span>What is being checked?</span>
          <Icon name="chevron" size={16} />
        </summary>
        <div className="disclosure-body">
          <p>
            {activeRun?.contract || specimen?.contract || "Loading contract…"}
          </p>
          <p className="muted">
            The fix selects a supplied, inspectable variant that keeps both
            formats readable. It does not apply generated code.
          </p>
        </div>
      </details>
      <section className="history-section">
        <button
          className="text-button"
          onClick={() => setShowHistory(!showHistory)}
          aria-expanded={showHistory}
        >
          <Icon name="history" size={15} />
          {showHistory ? "Hide previous runs" : "Previous runs"}
          <span className="history-count">{runs.length}</span>
        </button>
        {historyError && <p className="muted">{historyError}</p>}
        {showHistory && (
          <div className="history-list panel">
            {runs.length ? (
              runs.map((saved) => (
                <button
                  key={saved.id}
                  className="history-row"
                  onClick={() => selectRun(saved)}
                  disabled={running}
                >
                  <span>
                    <strong>
                      {saved.variant === "compatible"
                        ? "Compatibility fix"
                        : "Original change"}
                    </strong>
                    <small>{timeLabel(saved.completedAt, true)}</small>
                  </span>
                  <Status outcome={runOutcome(saved)} />
                  <Icon name="chevron" size={15} />
                </button>
              ))
            ) : (
              <p className="muted">
                {loading ? "Loading previous runs…" : "No completed runs yet."}
              </p>
            )}
          </div>
        )}
      </section>
      <p className="demo-scope">
        Bundled example · Real execution · No production data
      </p>
      {evidence && activeRun && (
        <EvidenceDrawer
          scenario={evidence}
          run={activeRun}
          close={() => setEvidence(null)}
        />
      )}
    </>
  );
}
function App() {
  const [view, setView] = useState<"cloud" | "fixtures" | "twins" | "release" | "interactions" | "checks">("cloud");
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Demo navigation">
        <a
          className="brand"
          href="https://gecco.sh"
          target="_blank"
          rel="noreferrer"
        >
          <img
            src="/brand/gecco-lockup-dark.svg"
            alt="Gecco"
            width="143"
            height="35"
          />
        </a>
        <div className="workspace">
          <span className="workspace-mark">G</span>
          <div>
            <strong>Rehearsals</strong>
            <span>Hackathon preview</span>
          </div>
        </div>
        <nav>
          <button className={`nav-item ${view === "cloud" ? "active" : ""}`} onClick={() => setView("cloud")}>
            <Icon name="play" size={17} />PR review & fix
          </button>
          <button
            className={`nav-item ${view === "interactions" ? "active" : ""}`}
            onClick={() => setView("interactions")}
          >
            <Icon name="code" size={17} />
            Change interactions
          </button>
          <details>
            <summary className="nav-item"><Icon name="code" size={17} />More examples<Icon name="chevron" size={13} /></summary>
            <button className={`nav-item ${view === "fixtures" ? "active" : ""}`} onClick={() => setView("fixtures")}><Icon name="play" size={17} />Daytona fixtures</button>
            <button className={`nav-item ${view === "twins" ? "active" : ""}`} onClick={() => setView("twins")}><Icon name="play" size={17} />Local sample</button>
            <button className={`nav-item ${view === "release" ? "active" : ""}`} onClick={() => setView("release")}><Icon name="database" size={17} />Database lab</button>
            <button className={`nav-item ${view === "checks" ? "active" : ""}`} onClick={() => setView("checks")}><Icon name="check" size={17} />Automated checks</button>
          </details>
        </nav>
        <div className="sidebar-bottom">
          <a
            href="https://github.com/kllymx/gecco-rehearsals"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="code" size={16} />
            Public source
            <Icon name="external" size={13} />
          </a>
          <a href="https://gecco.sh" target="_blank" rel="noreferrer">
            Open Gecco
            <Icon name="external" size={13} />
          </a>
          <span>Built with GPT-6 Astra</span>
        </div>
      </aside>
      <div className="workspace-content">
        <div className="topbar">
          <span>Gecco</span>
          <span className="breadcrumb-divider">/</span>
          <span>
            {view === "cloud" ? "PR review & fix" : view === "fixtures" ? "Daytona fixtures" : view === "twins" ? "Local sample" : view === "release" ? "Database lab" : view === "checks" ? "Automated checks" : "Change interactions"}
          </span>
          <span className="preview-badge">Demo</span>
        </div>
        <main className="main-content">
          <div hidden={view !== "cloud"}><CloudRehearsal /></div>
          {view === "fixtures" ? <FixtureCloudRehearsal /> : null}
          <div hidden={view !== "twins"}><TwinRehearsal /></div>
          <div hidden={view !== "release"}>
            <LiveLab />
          </div>
          <div hidden={view !== "checks"}>
            <ReleaseDemo />
          </div>
          <div hidden={view !== "interactions"}>
            <InteractionPanel />
          </div>
        </main>
      </div>
    </div>
  );
}
export default App;
