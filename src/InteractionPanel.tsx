import { useEffect, useRef, useState } from "react";
import type { Outcome, Variant } from "../shared/contracts";
import type {
  InteractionCellId,
  InteractionRun,
  InteractionSpecimen,
} from "../shared/interactions";
import "./interactions.css";

const combinations: { id: InteractionCellId; label: string }[] = [
  { id: "base", label: "Before either change" },
  { id: "a", label: "Change A alone" },
  { id: "b", label: "Change B alone" },
  { id: "combined", label: "A + B together" },
];
const outcomeLabels: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Incomplete",
};
function Mark({
  kind,
}: {
  kind: "arrow" | "check" | "cross" | "chevron" | "download";
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
      ) : kind === "check" ? (
        <path d="m5 12 4 4L19 6" />
      ) : kind === "cross" ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : kind === "download" ? (
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      ) : (
        <path d="m9 5 7 7-7 7" />
      )}
    </svg>
  );
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `The local server returned ${response.status}. Please try again.`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") message = body.error;
    } catch {
      /* Keep the HTTP status if no error body is available. */
    }
    throw new Error(message);
  }
  return response.json();
}
function exportRun(run: InteractionRun) {
  const href = URL.createObjectURL(
    new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = href;
  link.download = `gecco-interactions-${run.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
function outcomeOf(run: InteractionRun): Outcome {
  if (
    run.cells.length !== 4 ||
    run.cells.some((cell) => cell.outcome === "inconclusive")
  )
    return "inconclusive";
  return run.cells.some((cell) => cell.outcome === "failed")
    ? "failed"
    : "passed";
}
function amount(value: number) {
  return String(value);
}
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function InteractionPanel() {
  const [specimen, setSpecimen] = useState<InteractionSpecimen | null>(null);
  const [run, setRun] = useState<InteractionRun | null>(null);
  const [lastVariant, setLastVariant] = useState<Variant>("breaking");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const executionLock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    request<InteractionSpecimen>("/api/interactions/specimen", {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setSpecimen(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "The example could not load.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadAttempt]);
  async function execute(variant: Variant) {
    if (executionLock.current) return;
    executionLock.current = true;
    setLastVariant(variant);
    setPending(true);
    setRun(null);
    setError(null);
    try {
      setRun(
        await request<InteractionRun>("/api/interactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variant }),
        }),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The test could not finish.",
      );
    } finally {
      executionLock.current = false;
      setPending(false);
    }
  }
  const variant = run?.variant || lastVariant;
  const fixed = variant === "compatible";
  const outcome = run ? outcomeOf(run) : undefined;
  const combined = run?.cells.find((cell) => cell.id === "combined");
  const observation =
    combined?.observations.find((entry) => entry.outcome === "failed") ||
    combined?.observations.find(
      (entry) => !Number.isInteger(entry.quotedCents),
    ) ||
    combined?.observations[0];
  const independentPassed = Boolean(
    run &&
      ["base", "a", "b"].every(
        (id) => run.cells.find((cell) => cell.id === id)?.outcome === "passed",
      ),
  );
  const fractionalFailure =
    combined?.outcome === "failed" &&
    observation &&
    !Number.isInteger(observation.chargedCents);
  const sourceMatches =
    !run ||
    Boolean(
      specimen &&
        specimen.inputDigests[run.variant].sourceDigest === run.sourceDigest &&
        specimen.inputDigests[run.variant].fixtureDigest === run.fixtureDigest,
    );
  const changes = specimen?.changes.map((change) =>
    fixed && change.id === "b"
      ? {
          ...change,
          title: "Change B + checkout rounding",
          path: specimen.fix.path,
          rationale: specimen.fix.explanation,
          after: specimen.fix.code,
        }
      : change,
  );
  function cellLabel(id: InteractionCellId, fallback: string) {
    return fixed && id === "b"
      ? "B with rounding restored"
      : fixed && id === "combined"
        ? "A + B with rounding restored"
        : fallback;
  }
  return (
    <section
      className="interactions-demo"
      aria-labelledby="interactions-demo-title"
    >
      <header className="interactions-demo-header">
        <p className="interactions-demo-eyebrow">Change interactions</p>
        <h1 id="interactions-demo-title">
          Two changes.
          <br />
          One broken checkout.
        </h1>
        <p>
          Both changes work on their own. Gecco tests what happens when they run
          together.
        </p>
      </header>
      <div className="interactions-demo-changes">
        <article>
          <span className="interactions-demo-letter">A</span>
          <div>
            <h2>Keep precision in the quote</h2>
            <p>The quote keeps fractional cents for later calculations.</p>
          </div>
        </article>
        <article>
          <span className="interactions-demo-letter">B</span>
          <div>
            <h2>
              {fixed
                ? "Restore rounding at checkout"
                : "Remove rounding at checkout"}
            </h2>
            <p>
              {fixed
                ? "The checkout converts the final charge to whole cents."
                : "Checkout trusts the quote to already contain whole cents."}
            </p>
          </div>
        </article>
      </div>
      {!run && !error ? (
        <div className="interactions-demo-action">
          <button
            className="interactions-demo-primary"
            disabled={!specimen || pending || loading}
            onClick={() => execute(lastVariant)}
          >
            {pending ? <span className="interactions-demo-spinner" /> : null}
            {pending
              ? fixed
                ? "Testing the rounding fix…"
                : "Testing the changes…"
              : "Test them together"}
            {pending ? null : <Mark kind="arrow" />}
          </button>
          <span>
            {pending
              ? "Waiting for actual execution results."
              : "Runs the example locally."}
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="interactions-demo-error" role="alert">
          <div>
            <strong>The test could not finish.</strong>
            <p>{error}</p>
          </div>
          <button
            className="interactions-demo-primary"
            disabled={pending}
            onClick={() =>
              specimen
                ? execute(lastVariant)
                : setLoadAttempt((value) => value + 1)
            }
          >
            Try again
            <Mark kind="arrow" />
          </button>
        </div>
      ) : null}
      <div
        className="interactions-demo-results"
        aria-label="Results for each combination"
      >
        {combinations.map((combination) => {
          const result = run?.cells.find((cell) => cell.id === combination.id);
          return (
            <div
              className={`interactions-demo-result ${result?.outcome || ""}`}
              key={combination.id}
            >
              <span>{cellLabel(combination.id, combination.label)}</span>
              <strong>
                {result?.outcome === "passed" ? (
                  <Mark kind="check" />
                ) : result?.outcome === "failed" ? (
                  <Mark kind="cross" />
                ) : (
                  <span className="interactions-demo-status-dot" />
                )}
                {result
                  ? outcomeLabels[result.outcome]
                  : pending
                    ? "Pending"
                    : "Not tested"}
              </strong>
            </div>
          );
        })}
      </div>
      {run ? (
        <section
          className={`interactions-demo-finding ${outcome}`}
          aria-live="polite"
        >
          <div className="interactions-demo-finding-copy">
            <p className="interactions-demo-eyebrow">
              {outcome === "passed"
                ? "Fix verified on this example"
                : outcome === "failed"
                  ? "The interaction matters"
                  : "Execution incomplete"}
            </p>
            <h2>
              {fractionalFailure
                ? "Checkout charges a fraction of a cent."
                : outcome === "failed"
                  ? "The checkout contract failed."
                  : outcome === "passed"
                    ? "Checkout rounds the final charge correctly."
                    : "The test did not reach a complete result."}
            </h2>
            <p>
              {outcome === "failed" && independentPassed
                ? "Each change passed alone. Together, they removed the last rounding step."
                : outcome === "passed"
                  ? "All four combinations passed the same checks."
                  : run.summary}
            </p>
          </div>
          {observation ? (
            <div className="interactions-demo-amounts">
              <div>
                <span>Actually charged</span>
                <strong>
                  {amount(observation.chargedCents)}
                  <small>¢</small>
                </strong>
              </div>
              <span className="interactions-demo-amount-divider" />
              <div>
                <span>Should charge</span>
                <strong>
                  {amount(observation.expectedCents)}
                  <small>¢</small>
                </strong>
              </div>
              <p>
                For {amount(observation.input.subtotalCents)}¢ with{" "}
                {amount(observation.input.discountPercent)}% off.
              </p>
            </div>
          ) : null}
          {run.variant === "breaking" && outcome === "failed" ? (
            <button
              className="interactions-demo-primary"
              onClick={() => execute("compatible")}
            >
              Restore rounding and test again
              <Mark kind="arrow" />
            </button>
          ) : (
            <button
              className="interactions-demo-secondary"
              onClick={() => execute("breaking")}
            >
              Test the original changes again
              <Mark kind="arrow" />
            </button>
          )}
        </section>
      ) : null}
      <details className="interactions-demo-evidence">
        <summary>
          <span>{run ? "See the evidence" : "Inspect the example code"}</span>
          <Mark kind="chevron" />
        </summary>
        <div className="interactions-demo-evidence-content">
          <div className="interactions-demo-contract">
            <h3>What we checked</h3>
            <p>
              {run?.contract || specimen?.contract || "Loading the example…"}
            </p>
          </div>
          {run ? (
            <>
              <div className="interactions-demo-evidence-heading">
                <h3>Actual observations</h3>
                <button
                  className="interactions-demo-text-button"
                  onClick={() => exportRun(run)}
                >
                  <Mark kind="download" />
                  Download JSON
                </button>
              </div>
              {run.cells.map((cell) => (
                <details
                  className="interactions-demo-observations"
                  key={`${run.id}-${cell.id}`}
                  open={cell.id === "combined"}
                >
                  <summary>
                    <span>{cellLabel(cell.id, cell.title)}</span>
                    <span>
                      {outcomeLabels[cell.outcome]}
                      <Mark kind="chevron" />
                    </span>
                  </summary>
                  <div className="interactions-demo-table-scroll">
                    <table>
                      <caption>
                        All values are in cents, except the discount percentage.
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
                        {cell.observations.map((entry, index) => (
                          <tr className={entry.outcome} key={index}>
                            <td>{amount(entry.input.subtotalCents)}</td>
                            <td>{amount(entry.input.discountPercent)}%</td>
                            <td>{amount(entry.quotedCents)}</td>
                            <td>{amount(entry.chargedCents)}</td>
                            <td>{amount(entry.expectedCents)}</td>
                            <td>{outcomeLabels[entry.outcome]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="interactions-demo-observation-notes">
                    {cell.observations
                      .filter((entry) => entry.outcome !== "passed")
                      .map((entry, index) => (
                        <p key={index}>{entry.explanation}</p>
                      ))}
                  </div>
                </details>
              ))}
            </>
          ) : null}
          <h3 className="interactions-demo-source-heading">
            {fixed ? "Code with the rounding fix" : "The two source changes"}
          </h3>
          {specimen && sourceMatches ? (
            <div className="interactions-demo-source-grid">
              {changes?.map((change) => (
                <details className="interactions-demo-source" key={change.id}>
                  <summary>
                    <span>
                      {change.id.toUpperCase()} · {change.path}
                    </span>
                    <Mark kind="chevron" />
                  </summary>
                  <div>
                    <h4>{change.title}</h4>
                    <p>{change.rationale}</p>
                    <span>Before</span>
                    <pre>
                      <code>{change.before}</code>
                    </pre>
                    <span>
                      {fixed && change.id === "b"
                        ? "After · rounding fix active"
                        : "After"}
                    </span>
                    <pre>
                      <code>{change.after}</code>
                    </pre>
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <p>
              {sourceMatches
                ? "Source is loading."
                : "The source changed after this execution. Run the test again to inspect matching code. The recorded observations retain their original source digest."}
            </p>
          )}
          {run ? (
            <details className="interactions-demo-provenance">
              <summary>
                <span>Run details</span>
                <Mark kind="chevron" />
              </summary>
              <dl>
                <dt>Completed</dt>
                <dd>{timestamp(run.completedAt)}</dd>
                <dt>Run</dt>
                <dd>{run.id}</dd>
                <dt>Source digest</dt>
                <dd>{run.sourceDigest}</dd>
                <dt>Fixture digest</dt>
                <dd>{run.fixtureDigest}</dd>
              </dl>
              <p>{run.scope}</p>
            </details>
          ) : null}
        </div>
      </details>
      <footer className="interactions-demo-footer">
        Synthetic checkout example · Executed locally in TypeScript
      </footer>
    </section>
  );
}
