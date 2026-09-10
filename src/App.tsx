import { useEffect, useRef, useState } from "react";
import InteractionPanel from "./InteractionPanel";
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
  versions: string[];
}[] = [
  {
    id: "control",
    eyebrow: "01 / BASELINE",
    name: "Current release",
    description: "Does the current app still work on the current schema?",
    versions: ["App v1", "Schema v1"],
  },
  {
    id: "upgrade",
    eyebrow: "02 / FORWARD",
    name: "Upgraded release",
    description: "Does the new app work after the migration?",
    versions: ["App v2", "Schema v2"],
  },
  {
    id: "mixed",
    eyebrow: "03 / COEXISTENCE",
    name: "Mixed versions",
    description: "Can the old app survive while the new version rolls out?",
    versions: ["App v1 + v2", "Schema v2"],
  },
  {
    id: "rollback",
    eyebrow: "04 / RECOVERY",
    name: "After rollback",
    description: "Can the old app read a write made by the new version?",
    versions: ["App v1", "New writes kept"],
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
function Status({
  outcome,
  pending,
  small = false,
}: {
  outcome?: Outcome;
  pending?: boolean;
  small?: boolean;
}) {
  return (
    <span
      className={`status ${outcome || (pending ? "running" : "waiting")} ${small ? "small" : ""}`}
    >
      {pending ? (
        <span className="spinner" />
      ) : outcome === "passed" ? (
        <Icon name="check" size={13} />
      ) : outcome === "failed" ? (
        <Icon name="close" size={12} />
      ) : (
        <span className="status-dot" />
      )}
      {pending ? "Pending" : outcome ? labels[outcome] : "Not run"}
    </span>
  );
}
function Logo() {
  return (
    <div className="wordmark">
      <span className="logo-mark" aria-hidden="true">
        <svg viewBox="0 0 28 28" fill="none">
          <path
            d="M20 6H9L4 14l5 8h12V12H12l-3 5h7"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>
        gecco<span className="wordmark-dot">.</span>
      </span>
    </div>
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
function CodePanel({
  specimen,
  variant,
  onVariant,
  disabled,
  sourceChanged,
}: {
  specimen: Specimen | null;
  variant: Variant;
  onVariant: (variant: Variant) => void;
  disabled: boolean;
  sourceChanged: boolean;
}) {
  const [fileIndex, setFileIndex] = useState(0);
  const file = specimen?.files[fileIndex] || specimen?.files[0];
  const before = file?.before.split("\n") || [];
  const after = file?.[variant].split("\n") || [];
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return (
    <section className="panel source-panel" aria-labelledby="source-title">
      <div className="panel-heading">
        <div className="heading-with-icon">
          <Icon name="code" />
          <h2 id="source-title">The proposed change</h2>
        </div>
        <span className="subtle-label">SOURCE</span>
      </div>
      <div className="variant-switch" aria-label="Change variant">
        <button
          aria-pressed={variant === "breaking"}
          disabled={disabled}
          onClick={() => onVariant("breaking")}
        >
          Original change
        </button>
        <button
          aria-pressed={variant === "compatible"}
          disabled={disabled}
          onClick={() => onVariant("compatible")}
        >
          <Icon name="shield" size={14} />
          Compatibility fix
        </button>
      </div>
      {sourceChanged ? (
        <div className="source-mismatch">
          <Icon name="history" size={22} />
          <strong>Source changed since this run.</strong>
          <p>
            The selected evidence retains its original source digest. Run a new
            rehearsal to inspect the current source with matching observations.
          </p>
        </div>
      ) : (
        <>
          <div className="file-tabs" aria-label="Source files">
            {specimen ? (
              specimen.files.map((entry, index) => (
                <button
                  key={entry.path}
                  className={index === fileIndex ? "active" : ""}
                  onClick={() => setFileIndex(index)}
                >
                  <Icon name="code" size={13} />
                  {entry.path}
                </button>
              ))
            ) : (
              <span>Loading specimen…</span>
            )}
          </div>
          <div className="diff-grid">
            <div className="code-side">
              <div className="code-side-label">
                <span>BEFORE</span>
                <span>{specimen?.currentRelease || "Current release"}</span>
              </div>
              <div className="code-scroll">
                {file ? (
                  before.map((line, i) => (
                    <div
                      className={`code-line ${afterSet.has(line) ? "" : "removed"}`}
                      key={i}
                    >
                      <span className="line-number">{i + 1}</span>
                      <span className="line-sign">
                        {afterSet.has(line) ? " " : "−"}
                      </span>
                      <code>{line || " "}</code>
                    </div>
                  ))
                ) : (
                  <div className="code-placeholder">Waiting for source</div>
                )}
              </div>
            </div>
            <div className="code-side">
              <div className="code-side-label">
                <span>AFTER</span>
                <span>
                  {variant === "compatible"
                    ? "Compatibility fix"
                    : specimen?.proposedRelease || "Proposed release"}
                </span>
              </div>
              <div className="code-scroll">
                {file ? (
                  after.map((line, i) => (
                    <div
                      className={`code-line ${beforeSet.has(line) ? "" : "added"}`}
                      key={i}
                    >
                      <span className="line-number">{i + 1}</span>
                      <span className="line-sign">
                        {beforeSet.has(line) ? " " : "+"}
                      </span>
                      <code>{line || " "}</code>
                    </div>
                  ))
                ) : (
                  <div className="code-placeholder">Waiting for source</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
      <div className="source-footnote">
        <span
          className={`small-dot ${variant === "compatible" ? "lime" : "amber"}`}
        />
        <span>
          {variant === "compatible"
            ? "A compatibility-preserving variant. Run the same contract to check it."
            : "Both versions can pass independently. Rehearse what happens between them."}
        </span>
      </div>
    </section>
  );
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

function App() {
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
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand-link" href="#" aria-label="Gecco Rehearsals home">
          <Logo />
        </a>
        <span className="topbar-divider" />
        <span className="product-name">Rehearsals</span>
        <span className="preview-label">LABS</span>
        <div className="topbar-right">
          <span className="environment">
            <span className="small-dot lime" />
            Local PostgreSQL
          </span>
          <span className="topbar-divider" />
          <span className="hackathon-label">GPT-6 ASTRA HACKATHON</span>
          <span className="avatar">G</span>
        </div>
      </header>
      <main className="main-content">
        <div className="workspace-line">
          <span className="breadcrumb">
            <Icon name="code" size={14} />
            gecco / release-rehearsals <Icon name="chevron" size={12} />
            <strong>Schema evolution</strong>
          </span>
          <span className="specimen-tag">
            <span className="small-dot" />
            Synthetic specimen
          </span>
        </div>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow lime-text">
              <span className="eyebrow-line" />
              REVIEW THE RELEASE, NOT JUST THE DIFF
            </div>
            <h1>
              Your tests pass.
              <br />
              <span>Your rollout breaks.</span>
            </h1>
            <p>
              See what happens when this change ships.
              <br className="desktop-break" /> Rehearse the upgrade, the
              overlap, and the way back.
            </p>
            <div className="hero-proof">
              <span>
                <Icon name="database" size={14} />
                Real PostgreSQL execution
              </span>
              <span className="proof-separator">/</span>
              <span>Every result has evidence</span>
            </div>
          </div>
          <aside className={`verdict-card ${outcome || ""}`} aria-live="polite">
            <div className="verdict-top">
              <span className="subtle-label">RELEASE REHEARSAL</span>
              <span
                className={`verdict-indicator ${running ? "pulsing" : ""}`}
              />
            </div>
            <div className="verdict-number">
              {activeRun ? (
                <>
                  {passed}
                  <span>/4</span>
                </>
              ) : running ? (
                <span className="running-glyph">↻</span>
              ) : (
                <span className="unrun-number">
                  —<span>/4</span>
                </span>
              )}
            </div>
            <strong className="verdict-title">
              {running
                ? "Rehearsing the release…"
                : outcome === "failed"
                  ? "This rollout breaks the contract."
                  : outcome === "passed"
                    ? "All four trials passed."
                    : outcome === "inconclusive"
                      ? "The result is inconclusive."
                      : "The transition is the test."}
            </strong>
            <p>
              {running
                ? "Executing the declared trials on disposable fixtures. Results appear when execution completes."
                : activeRun
                  ? `${failures.length ? `${failures.length} compatibility ${failures.length === 1 ? "failure" : "failures"} observed. ` : ""}Completed ${timeLabel(activeRun.completedAt)} · ${durationLabel(activeRun.durationMs)}`
                  : "Four release states. One compatibility contract. No observed results yet."}
            </p>
            <button
              className="button primary run-button"
              disabled={running || !specimen}
              onClick={() => runRehearsal()}
            >
              {running ? (
                <span className="spinner" />
              ) : (
                <Icon name={activeRun ? "refresh" : "play"} size={16} />
              )}
              {running
                ? "Execution in progress"
                : activeRun
                  ? "Run rehearsal again"
                  : "Run rehearsal"}
            </button>
          </aside>
        </section>
        {error ? (
          <div className="error-banner" role="alert">
            <Icon name="close" />
            <div>
              <strong>Something interrupted the rehearsal</strong>
              <p>{error}</p>
            </div>
            <button
              className="button secondary compact"
              onClick={() =>
                specimen
                  ? runRehearsal()
                  : setLoadAttempt((attempt) => attempt + 1)
              }
              disabled={running}
            >
              Try again
            </button>
          </div>
        ) : null}
        <div className="contract-bar">
          <span className="contract-icon">
            <Icon name="shield" size={20} />
          </span>
          <div>
            <span className="subtle-label">THE CONTRACT</span>
            <p>
              {activeRun?.contract ||
                specimen?.contract ||
                "Loading the declared compatibility contract…"}
            </p>
          </div>
          <span className="contract-badge">SAME CONTRACT · EVERY TRIAL</span>
        </div>
        <section className="release-section" aria-labelledby="release-title">
          <div className="section-heading">
            <div>
              <h2 id="release-title">What happens between releases</h2>
              <p>
                {activeRun
                  ? "Observed results from the selected execution. Open any trial to inspect its evidence."
                  : "Each trial starts with its own fixture. State is preserved throughout that trial."}
              </p>
            </div>
            <div className="section-heading-right">
              {activeRun ? (
                <button
                  className="text-button"
                  onClick={() => downloadRun(activeRun)}
                >
                  <Icon name="download" size={15} />
                  Export run
                </button>
              ) : (
                <span className="planned-label">
                  {running ? "EXECUTING" : "READY TO REHEARSE"}
                </span>
              )}
            </div>
          </div>
          <div className={`phase-grid ${running ? "is-running" : ""}`}>
            {phaseInfo.map((phase, index) => {
              const result = activeRun?.scenarios.find(
                (scenario) => scenario.id === phase.id,
              );
              return (
                <button
                  className={`phase-card ${result?.outcome || ""}`}
                  key={phase.id}
                  disabled={!result || running}
                  onClick={() => result && setEvidence(result)}
                  aria-label={`${phase.name}: ${result ? labels[result.outcome] + ". View execution evidence" : running ? "pending execution result" : "not run"}`}
                >
                  <div className="phase-top">
                    <span className="phase-eyebrow">{phase.eyebrow}</span>
                    <Status outcome={result?.outcome} pending={running} small />
                  </div>
                  <div className="phase-visual" aria-hidden="true">
                    <span
                      className={`version-node ${phase.id === "upgrade" ? "new-node" : ""}`}
                    >
                      {phase.id === "upgrade" ? "v2" : "v1"}
                    </span>
                    <span className="transition-line">
                      <span />
                    </span>
                    {phase.id === "mixed" ? (
                      <span className="version-node new-node">v2</span>
                    ) : (
                      <span
                        className={`database-node ${phase.id !== "control" ? "new-node" : ""}`}
                      >
                        <Icon name="database" size={23} />
                        {phase.id === "rollback" ? <i /> : null}
                      </span>
                    )}
                    {index < 3 ? (
                      <span className="phase-connector">
                        <Icon name="arrow" size={15} />
                      </span>
                    ) : null}
                  </div>
                  <h3>{phase.name}</h3>
                  <p>{phase.description}</p>
                  <div className="version-labels">
                    {phase.versions.map((version) => (
                      <span key={version}>{version}</span>
                    ))}
                  </div>
                  <div className="phase-footer">
                    {result ? (
                      <>
                        <span>
                          {result.outcome === "failed"
                            ? "Inspect the failure"
                            : result.outcome === "inconclusive"
                              ? "Inspect the interruption"
                              : "View execution evidence"}
                        </span>
                        <Icon name="arrow" size={15} />
                      </>
                    ) : (
                      <>
                        <span>
                          {running
                            ? "Waiting for observed results"
                            : "Awaiting execution"}
                        </span>
                        {running ? (
                          <span className="spinner" />
                        ) : (
                          <span className="empty-dot" />
                        )}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
        {activeRun ? (
          <div className={`result-strip ${outcome}`} role="status">
            <div className="result-strip-icon">
              <Icon
                name={
                  outcome === "passed"
                    ? "check"
                    : outcome === "failed"
                      ? "close"
                      : "terminal"
                }
                size={19}
              />
            </div>
            <div>
              <strong>
                {outcome === "failed"
                  ? "The diff is only part of the story."
                  : outcome === "passed"
                    ? "Compatibility preserved in this rehearsal."
                    : "Execution did not establish compatibility."}
              </strong>
              <p>{activeRun.summary}</p>
            </div>
            {variant === "breaking" && outcome === "failed" ? (
              <button
                className="button primary fix-button"
                onClick={() => runRehearsal("compatible")}
                disabled={running}
              >
                <Icon name="shield" size={15} />
                Apply compatibility fix + rerun
                <Icon name="arrow" size={15} />
              </button>
            ) : (
              <button
                className="text-button"
                onClick={() =>
                  setEvidence(
                    activeRun.scenarios.find(
                      (scenario) => scenario.outcome !== "passed",
                    ) || activeRun.scenarios[3],
                  )
                }
              >
                Inspect evidence
                <Icon name="arrow" size={15} />
              </button>
            )}
          </div>
        ) : null}
        <div className="detail-grid">
          <CodePanel
            specimen={specimen}
            variant={variant}
            onVariant={changeVariant}
            disabled={running}
            sourceChanged={sourceChanged}
          />
          <section
            className="panel analysis-panel"
            aria-labelledby="analysis-title"
          >
            <div className="panel-heading">
              <div className="heading-with-icon">
                <Icon name="spark" />
                <h2 id="analysis-title">A hypothesis, then a test</h2>
              </div>
              <span className="ai-label">AI</span>
            </div>
            <div className="analysis-content">
              <div className="analysis-intro">
                <span className="analysis-orbit">
                  <Icon name="spark" size={24} />
                </span>
                <h3>
                  Reason about the change.
                  <br />
                  <span>Let execution settle it.</span>
                </h3>
                <p>
                  Ask the configured model to examine this source change and
                  contract. Its reasoning stays separate from the database
                  observations.
                </p>
              </div>
              {currentAnalysis ? (
                <div className={`analysis-result ${currentAnalysis.status}`}>
                  <div className="analysis-status">
                    <span
                      className={`small-dot ${currentAnalysis.status === "completed" ? "lime" : "amber"}`}
                    />
                    <strong>
                      {currentAnalysis.status === "completed"
                        ? recordedAnalysis[variant]
                          ? "Recorded analysis"
                          : "Analysis completed"
                        : currentAnalysis.status === "unavailable"
                          ? "AI analysis unavailable"
                          : "Provider request failed"}
                    </strong>
                  </div>
                  <p>{currentAnalysis.summary}</p>
                  {currentAnalysis.status === "completed" &&
                  currentAnalysis.hypotheses.length ? (
                    <div className="hypotheses">
                      {currentAnalysis.hypotheses.map((hypothesis, index) => (
                        <details key={`${hypothesis.scenarioId}-${index}`}>
                          <summary>
                            <span>
                              {phaseInfo.find(
                                (phase) => phase.id === hypothesis.scenarioId,
                              )?.name || hypothesis.scenarioId}
                            </span>
                            <Icon name="chevron" size={13} />
                          </summary>
                          <strong>{hypothesis.risk}</strong>
                          <p>{hypothesis.rationale}</p>
                        </details>
                      ))}
                    </div>
                  ) : null}
                  {currentAnalysis.status === "completed" &&
                  currentAnalysis.suggestedFix ? (
                    <div className="suggested-fix">
                      <span className="subtle-label">MODEL-SUGGESTED FIX</span>
                      <p>{currentAnalysis.suggestedFix}</p>
                    </div>
                  ) : null}
                  {currentAnalysis.error ? (
                    <p className="provider-error">{currentAnalysis.error}</p>
                  ) : null}
                  <div className="analysis-provenance">
                    {currentAnalysis.provider}
                    {currentAnalysis.model
                      ? ` / ${currentAnalysis.model}`
                      : ""}{" "}
                    · {timeLabel(currentAnalysis.generatedAt)}
                  </div>
                </div>
              ) : (
                <div className="analysis-empty">
                  <span className="small-dot" />
                  <span>
                    {sourceChanged
                      ? "AI analysis is available after a new rehearsal with the current source."
                      : "No model response requested yet."}
                  </span>
                </div>
              )}
              {analysisError ? (
                <p className="inline-error" role="alert">
                  {analysisError}
                </p>
              ) : null}
              <button
                className="button secondary analyze-button"
                onClick={analyze}
                disabled={Boolean(analyzing) || !specimen || sourceChanged}
              >
                {analyzing === variant ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="spark" size={15} />
                )}
                {analyzing === variant
                  ? "Waiting for the model…"
                  : currentAnalysis
                    ? "Request analysis again"
                    : "Analyze this change"}
                <Icon name="arrow" size={15} />
              </button>
              <p className="analysis-disclosure">
                Optional. Rehearsals run even when AI is unavailable.
              </p>
            </div>
          </section>
        </div>
        <InteractionPanel />
        <section
          className="panel history-panel"
          aria-labelledby="history-title"
        >
          <div className="panel-heading">
            <div className="heading-with-icon">
              <Icon name="history" />
              <h2 id="history-title">Rehearsal history</h2>
              <span className="count-badge">{runs.length}</span>
            </div>
            <span className="subtle-label">RECORDED EXECUTIONS</span>
          </div>
          {historyError ? (
            <p className="history-error">{historyError}</p>
          ) : null}
          {runs.length ? (
            <div className="history-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Run / completed</th>
                    <th>Change</th>
                    <th>Release trials</th>
                    <th>Duration</th>
                    <th>Result</th>
                    <th>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 12).map((run) => (
                    <tr
                      key={run.id}
                      className={activeRun?.id === run.id ? "selected" : ""}
                    >
                      <td>
                        <button
                          className="run-link"
                          disabled={running}
                          onClick={() => selectRun(run)}
                        >
                          <span className="run-id">{run.id.slice(0, 12)}</span>
                          <span>{timeLabel(run.completedAt, true)}</span>
                        </button>
                      </td>
                      <td>
                        <span className={`variant-badge ${run.variant}`}>
                          {run.variant === "breaking"
                            ? "Original change"
                            : "Compatibility fix"}
                        </span>
                      </td>
                      <td>
                        <div className="history-phases">
                          {phaseInfo.map((phase) => {
                            const result = run.scenarios.find(
                              (scenario) => scenario.id === phase.id,
                            );
                            return (
                              <span
                                title={`${phase.name}: ${result ? labels[result.outcome] : "No result"}`}
                                className={result?.outcome || ""}
                                key={phase.id}
                              >
                                {result?.outcome === "passed" ? (
                                  <Icon name="check" size={12} />
                                ) : result?.outcome === "failed" ? (
                                  <Icon name="close" size={12} />
                                ) : (
                                  "·"
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="mono">{durationLabel(run.durationMs)}</td>
                      <td>
                        <Status outcome={runOutcome(run)} small />
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          onClick={() => selectRun(run)}
                          disabled={running}
                          aria-label={`Open run completed ${timeLabel(run.completedAt, true)}`}
                        >
                          <Icon name="arrow" size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="history-empty">
              <Icon name="history" size={22} />
              <div>
                <strong>
                  {loading
                    ? "Loading recorded runs…"
                    : "Your first rehearsal starts here."}
                </strong>
                <p>
                  Completed runs appear here with their original evidence and
                  timestamps.
                </p>
              </div>
            </div>
          )}
        </section>
        <footer className="page-footer">
          <div>
            <span className="footer-logo">g.</span>
            <span>Release confidence, with receipts.</span>
          </div>
          <span>
            Bundled synthetic specimen · PGlite / PostgreSQL in WASM · Local
            execution
          </span>
        </footer>
        <p className="scope-note">
          {activeRun?.scope ||
            "This rehearsal checks a declared compatibility contract against disposable, local fixtures. It does not execute arbitrary repository scripts or prove a release is production-safe."}
        </p>
      </main>
      {evidence && activeRun ? (
        <EvidenceDrawer
          scenario={evidence}
          run={activeRun}
          close={() => setEvidence(null)}
        />
      ) : null}
    </div>
  );
}
export default App;
