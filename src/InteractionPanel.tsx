import { useEffect, useRef, useState } from "react";
import type { Outcome, Variant } from "../shared/contracts";
import type {
  InteractionCell,
  InteractionCellId,
  InteractionRun,
  InteractionSpecimen,
} from "../shared/interactions";
import "./interactions.css";

const cells: {
  id: InteractionCellId;
  label: string;
  token: string;
  description: string;
}[] = [
  {
    id: "base",
    label: "Shared base",
    token: "BASE",
    description: "The starting point, before either change.",
  },
  {
    id: "a",
    label: "Only PR A",
    token: "BASE + A",
    description: "The first change, checked on its own.",
  },
  {
    id: "b",
    label: "Only PR B",
    token: "BASE + B",
    description: "The second change, checked on its own.",
  },
  {
    id: "combined",
    label: "Combined changes",
    token: "BASE + A + B",
    description: "The combined behavior, under the same contract.",
  },
];
const outcomeLabel: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Inconclusive",
};
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
function Glyph({
  name,
  size = 16,
}: {
  name:
    | "arrow"
    | "download"
    | "check"
    | "close"
    | "branch"
    | "code"
    | "chevron"
    | "play";
  size?: number;
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
    >
      {name === "arrow" ? (
        <path d="M4 12h15m-6-6 6 6-6 6" />
      ) : name === "download" ? (
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      ) : name === "check" ? (
        <path d="m5 12 4 4L19 6" />
      ) : name === "close" ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : name === "branch" ? (
        <>
          <circle cx="6" cy="5" r="3" />
          <circle cx="6" cy="19" r="3" />
          <circle cx="18" cy="6" r="3" />
          <path d="M6 8v8m0-3h5c5 0 7-1 7-4" />
        </>
      ) : name === "code" ? (
        <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" />
      ) : name === "play" ? (
        <path d="m8 4 12 8-12 8z" />
      ) : (
        <path d="m9 5 7 7-7 7" />
      )}
    </svg>
  );
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `The local server returned ${response.status}. Try again.`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") message = body.error;
    } catch {
      /* Keep the HTTP error if the body is unavailable. */
    }
    throw new Error(message);
  }
  return response.json();
}
function overallOutcome(run: InteractionRun): Outcome {
  if (
    run.cells.length !== 4 ||
    run.cells.some((cell) => cell.outcome === "inconclusive")
  )
    return "inconclusive";
  return run.cells.some((cell) => cell.outcome === "failed")
    ? "failed"
    : "passed";
}
function duration(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(1)}ms`;
}
function number(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toPrecision(12)));
}
function saveRun(run: InteractionRun) {
  const href = URL.createObjectURL(
    new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = href;
  link.download = `gecco-interactions-${run.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
function OutcomeBadge({
  outcome,
  pending,
}: {
  outcome?: Outcome;
  pending: boolean;
}) {
  return (
    <span
      className={`interaction-outcome ${outcome || (pending ? "pending" : "waiting")}`}
    >
      {pending ? (
        <span className="spinner" />
      ) : outcome === "passed" ? (
        <Glyph name="check" size={12} />
      ) : outcome === "failed" ? (
        <Glyph name="close" size={12} />
      ) : (
        <span className="small-dot" />
      )}
      {pending ? "Pending" : outcome ? outcomeLabel[outcome] : "Not run"}
    </span>
  );
}
function ObservationDetails({ cell }: { cell: InteractionCell }) {
  return (
    <details className="interaction-evidence" open={cell.outcome === "failed"}>
      <summary>
        <span>Observed cents calculations</span>
        <span>
          {cell.observations.length} cases
          <Glyph name="chevron" size={13} />
        </span>
      </summary>
      <div className="interaction-table-scroll">
        <table>
          <caption className="sr-only">
            {cell.title}: actual quoted and charged cents compared with the
            contract
          </caption>
          <thead>
            <tr>
              <th>Subtotal</th>
              <th>Discount</th>
              <th>Quote</th>
              <th>Charged</th>
              <th>Expected</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {cell.observations.map((observation, index) => (
              <tr className={observation.outcome} key={index}>
                <td>{number(observation.input.subtotalCents)}¢</td>
                <td>{number(observation.input.discountPercent)}%</td>
                <td>{number(observation.quotedCents)}¢</td>
                <td>{number(observation.chargedCents)}¢</td>
                <td>{number(observation.expectedCents)}¢</td>
                <td>
                  <OutcomeBadge outcome={observation.outcome} pending={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="interaction-observation-notes">
        {cell.observations.map((observation, index) => (
          <p key={index}>
            <span className={observation.outcome}>
              {observation.outcome === "passed"
                ? "✓"
                : observation.outcome === "failed"
                  ? "×"
                  : "·"}
            </span>
            {observation.explanation}
          </p>
        ))}
      </div>
    </details>
  );
}
export default function InteractionPanel() {
  const [specimen, setSpecimen] = useState<InteractionSpecimen | null>(null);
  const [run, setRun] = useState<InteractionRun | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestedVariant, setLastRequestedVariant] =
    useState<Variant>("breaking");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedCell, setSelectedCell] = useState<InteractionCellId | null>(
    null,
  );
  const requestLock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    request<InteractionSpecimen>("/api/interactions/specimen", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSpecimen(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load the interaction specimen.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  async function execute(variant: Variant) {
    if (requestLock.current) return;
    requestLock.current = true;
    setLastRequestedVariant(variant);
    setPending(true);
    setRun(null);
    setSelectedCell(null);
    setError(null);
    try {
      const result = await request<InteractionRun>("/api/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant }),
      });
      setRun(result);
      setSelectedCell(
        result.cells.find((cell) => cell.outcome !== "passed")?.id ||
          "combined",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The interaction check did not complete. Try again.",
      );
    } finally {
      requestLock.current = false;
      setPending(false);
    }
  }
  const displayedVariant = run?.variant || lastRequestedVariant;
  const boundaryFixActive = displayedVariant === "compatible";
  const displayedChanges = specimen?.changes.map((change) =>
    boundaryFixActive && change.id === "b"
      ? {
          ...change,
          title: "PR B + boundary fix",
          path: specimen.fix.path,
          rationale: specimen.fix.explanation,
          after: specimen.fix.code,
        }
      : change,
  );
  function displayedCellTitle(id: InteractionCellId, original: string) {
    return boundaryFixActive && id === "b"
      ? "PR B + boundary fix"
      : boundaryFixActive && id === "combined"
        ? "PR A + PR B + boundary fix"
        : original;
  }
  const outcome = run ? overallOutcome(run) : undefined;
  const activeCell = run?.cells.find((cell) => cell.id === selectedCell);
  const sourceMatches =
    !run ||
    Boolean(
      specimen &&
        specimen.inputDigests[run.variant].sourceDigest === run.sourceDigest &&
        specimen.inputDigests[run.variant].fixtureDigest === run.fixtureDigest,
    );
  const isolatedPasses =
    run?.cells.filter((cell) => cell.id !== "combined").length === 3 &&
    run.cells
      .filter((cell) => cell.id !== "combined")
      .every((cell) => cell.outcome === "passed");
  const passed =
    run?.cells.filter((cell) => cell.outcome === "passed").length || 0;
  const failedCombinedObservation = run?.cells
    .find((cell) => cell.id === "combined")
    ?.observations.find((observation) => observation.outcome === "failed");
  return (
    <section className="interaction-panel" aria-labelledby="interaction-title">
      <div className="interaction-header">
        <div className="interaction-heading">
          <span className="interaction-section-icon">
            <Glyph name="branch" size={20} />
          </span>
          <div>
            <span className="eyebrow">REHEARSAL 02 / CHANGE INTERACTIONS</span>
            <h2 id="interaction-title">
              Two green PRs.<span> One broken contract.</span>
            </h2>
          </div>
        </div>
        <span className="interaction-runtime">
          <span className="small-dot lime" />
          Local TypeScript execution
        </span>
      </div>
      <div className="interaction-intro">
        <p>
          A change can work alone and fail beside another. Execute the shared
          base, each change independently, and the combined code against one
          payment contract.
        </p>
        <span className="interaction-specimen-label">
          BUNDLED SYNTHETIC PRs
        </span>
      </div>
      <div className="interaction-contract">
        <span className="subtle-label">PAYMENT CONTRACT</span>
        <p>
          {run?.contract ||
            specimen?.contract ||
            "Loading the declared payment contract…"}
        </p>
      </div>
      <div className="interaction-toolbar">
        <div className="interaction-state" aria-live="polite">
          {pending ? (
            <>
              <span className="spinner" />
              {boundaryFixActive
                ? "Executing four combinations with the boundary fix. Waiting for observed results."
                : "Executing four original combinations. Waiting for observed results."}
            </>
          ) : run ? (
            <>
              <strong className={outcome}>{passed}/4 passed</strong>
              <span>
                {run.variant === "compatible"
                  ? "Payment-boundary fix"
                  : "Original changes"}{" "}
                · {duration(run.durationMs)}
              </span>
            </>
          ) : (
            <>
              <span className="small-dot" />
              {loading
                ? "Loading source…"
                : "Six input cases per combination. Two bundled synthetic changes."}
            </>
          )}
        </div>
        <button
          className="button secondary interaction-run-button"
          onClick={() => execute("breaking")}
          disabled={!specimen || pending}
        >
          {pending ? (
            <span className="spinner" />
          ) : (
            <Glyph name="play" size={13} />
          )}
          {pending
            ? "Executing…"
            : run
              ? "Rerun original changes"
              : "Run interaction check"}
          <Glyph name="arrow" size={14} />
        </button>
      </div>
      {error ? (
        <div className="interaction-error" role="alert">
          <div>
            <strong>Interaction check interrupted</strong>
            <p>{error}</p>
          </div>
          <button
            className="button secondary compact"
            disabled={pending}
            onClick={() =>
              specimen
                ? execute(lastRequestedVariant)
                : setAttempt((value) => value + 1)
            }
          >
            Try again
          </button>
        </div>
      ) : null}
      <div className="interaction-grid">
        {cells.map((cell, index) => {
          const result = run?.cells.find((entry) => entry.id === cell.id);
          const focusedObservation = result?.observations.find(
            (observation) => observation.outcome !== "passed",
          );
          return (
            <button
              key={cell.id}
              className={`interaction-cell ${result?.outcome || ""} ${selectedCell === cell.id ? "selected" : ""}`}
              disabled={!result || pending}
              onClick={() => setSelectedCell(cell.id)}
              aria-pressed={selectedCell === cell.id}
              aria-label={`${displayedCellTitle(cell.id, cell.label)}: ${result ? `${outcomeLabel[result.outcome]}. Show numeric evidence` : pending ? "Pending results" : "Not run"}`}
            >
              <div className="interaction-cell-top">
                <span className="interaction-token">
                  {cell.token}
                  {boundaryFixActive &&
                  (cell.id === "b" || cell.id === "combined")
                    ? " + FIX"
                    : ""}
                </span>
                <OutcomeBadge outcome={result?.outcome} pending={pending} />
              </div>
              <div className="interaction-cell-diagram" aria-hidden="true">
                <span className="interaction-base-node">b</span>
                {index > 0 ? (
                  <>
                    <span className="interaction-plus">+</span>
                    <span className="interaction-change-node">
                      {index === 2 ? "B" : "A"}
                    </span>
                  </>
                ) : (
                  <span className="interaction-baseline-line" />
                )}
                {index === 3 ? (
                  <>
                    <span className="interaction-plus">+</span>
                    <span className="interaction-change-node">B</span>
                  </>
                ) : null}
              </div>
              <h3>{displayedCellTitle(cell.id, cell.label)}</h3>
              <p>{cell.description}</p>
              <div className="interaction-cell-observation">
                {focusedObservation ? (
                  <>
                    <strong>{number(focusedObservation.chargedCents)}¢</strong>
                    <span>
                      charged · expected{" "}
                      {number(focusedObservation.expectedCents)}¢
                    </span>
                  </>
                ) : result ? (
                  <>
                    <strong>{result.observations.length} cases</strong>
                    <span>
                      {result.outcome === "passed"
                        ? "Contract satisfied"
                        : "Inspect the observations"}
                    </span>
                  </>
                ) : (
                  <>
                    <strong>—</strong>
                    <span>
                      {pending
                        ? "Awaiting actual observations"
                        : "No observed result yet"}
                    </span>
                  </>
                )}
              </div>
              <div className="interaction-cell-footer">
                <span>
                  {result ? "Inspect numeric evidence" : "Ready to execute"}
                </span>
                <Glyph name="arrow" size={13} />
              </div>
            </button>
          );
        })}
      </div>
      {run ? (
        <div className={`interaction-verdict ${outcome}`} aria-live="polite">
          <span className="interaction-verdict-symbol">
            <Glyph
              name={
                outcome === "passed"
                  ? "check"
                  : outcome === "failed"
                    ? "close"
                    : "code"
              }
              size={19}
            />
          </span>
          <div>
            <strong>
              {outcome === "failed"
                ? isolatedPasses
                  ? "Individually compatible. Together, a regression."
                  : "A payment contract failure was observed."
                : outcome === "passed"
                  ? "All combinations preserve the payment contract."
                  : "The check did not establish compatibility."}
            </strong>
            <p>{run.summary}</p>
            {failedCombinedObservation ? (
              <p className="interaction-numeric-callout">
                Combined charge:{" "}
                <b>{number(failedCombinedObservation.chargedCents)}¢</b>{" "}
                <span>→</span> contract requires{" "}
                <b>{number(failedCombinedObservation.expectedCents)}¢</b>.
              </p>
            ) : null}
          </div>
          {run.variant === "breaking" && outcome === "failed" ? (
            <button
              className="button primary interaction-fix-button"
              disabled={pending}
              onClick={() => execute("compatible")}
            >
              Restore boundary rounding + rerun
              <Glyph name="arrow" size={14} />
            </button>
          ) : (
            <button className="text-button" onClick={() => saveRun(run)}>
              <Glyph name="download" size={14} />
              Export JSON
            </button>
          )}
        </div>
      ) : null}
      {activeCell ? (
        <div className="interaction-selected-evidence">
          <div className="interaction-evidence-heading">
            <span>
              <Glyph name="code" size={14} />
              {displayedCellTitle(activeCell.id, activeCell.title)}
            </span>
            <span>
              {duration(activeCell.durationMs)} ·{" "}
              {activeCell.activeChanges.length
                ? activeCell.activeChanges
                    .map((change) =>
                      boundaryFixActive && change === "PR B"
                        ? "PR B + boundary fix"
                        : change,
                    )
                    .join(" + ")
                : "Shared base"}
            </span>
          </div>
          <ObservationDetails
            key={`${run?.id}-${activeCell.id}`}
            cell={{
              ...activeCell,
              title: displayedCellTitle(activeCell.id, activeCell.title),
            }}
          />
        </div>
      ) : null}
      <details className="interaction-sources">
        <summary>
          <span>
            <Glyph name="branch" size={15} />
            Inspect the independent changes
          </span>
          <span>
            Source & rationale
            <Glyph name="chevron" size={14} />
          </span>
        </summary>
        {specimen && sourceMatches ? (
          <div className="interaction-source-grid">
            {displayedChanges?.map((change) => (
              <article key={change.id} className="interaction-source">
                <div className="interaction-source-title">
                  <span>{change.id}</span>
                  <h3>{change.title}</h3>
                </div>
                <p>{change.rationale}</p>
                <details>
                  <summary>
                    <span>
                      <Glyph name="code" size={13} />
                      {change.path}
                    </span>
                    <Glyph name="chevron" size={13} />
                  </summary>
                  <div className="interaction-source-code">
                    <span>BEFORE</span>
                    <pre>
                      <code>{change.before}</code>
                    </pre>
                    <span>
                      {boundaryFixActive && change.id === "b"
                        ? "AFTER · BOUNDARY FIX ACTIVE"
                        : "AFTER"}
                    </span>
                    <pre>
                      <code>{change.after}</code>
                    </pre>
                  </div>
                </details>
              </article>
            ))}
            <article className="interaction-fix-source">
              <div>
                <span className="subtle-label">COMPATIBILITY FIX</span>
                <h3>{specimen.fix.path}</h3>
                <p>{specimen.fix.explanation}</p>
              </div>
              <details open={boundaryFixActive}>
                <summary>
                  <span>
                    {boundaryFixActive
                      ? "Active boundary fix source"
                      : "Inspect the proposed fix"}
                  </span>
                  <Glyph name="chevron" size={13} />
                </summary>
                <pre>
                  <code>{specimen.fix.code}</code>
                </pre>
              </details>
            </article>
          </div>
        ) : (
          <p className="interaction-source-unavailable">
            {sourceMatches
              ? "Source is loading. Retry above if the local server is unavailable."
              : "Source changed since this execution. The run retains its original contract and digests; rerun to inspect matching source."}
          </p>
        )}
      </details>
      <div className="interaction-footer">
        <span>
          {run
            ? `Observed ${dateTime.format(new Date(run.completedAt))}`
            : "Synthetic PRs · Six bundled inputs · Local contract checks"}
        </span>
        {run ? (
          <button className="text-button" onClick={() => saveRun(run)}>
            <Glyph name="download" size={13} />
            Export observations
          </button>
        ) : (
          <span>Source and observations are inspectable</span>
        )}
      </div>
      {run ? (
        <details className="interaction-provenance">
          <summary>
            <span>Execution provenance</span>
            <Glyph name="chevron" size={13} />
          </summary>
          <dl>
            <dt>Run ID</dt>
            <dd>{run.id}</dd>
            <dt>Source digest</dt>
            <dd>{run.sourceDigest}</dd>
            <dt>Fixture digest</dt>
            <dd>{run.fixtureDigest}</dd>
          </dl>
          <p>{run.scope}</p>
        </details>
      ) : null}
    </section>
  );
}
