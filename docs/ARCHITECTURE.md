# Architecture

```text
React console → loopback HTTP API → four-trial rehearsal engine → disposable PGlite databases
                       ↓                         ↓
                 optional AI analysis      actual SQL observations
                       ↓                         ↓
                  risk hypotheses        immutable completed run JSON
```

The frontend reads the specimen and completed runs through the API. A rehearsal selects one
of two trusted source variants and evaluates the same compatibility contract in four independent
trials. Each trial owns a fresh database. Upgrade, writes and rollback within a trial share its
state; a reset cannot erase the marked new-version write before the rollback assertion.

The engine exports structured observations, executed SQL, input digests, timing and scope.
The server persists completed observations for reload and export. AI analysis receives the
public specimen and contract; it has no authority to change the evidence or decide a trial's
outcome. An unavailable provider is a visible analysis state, not fabricated output.

This demo's trust boundary is intentionally narrow: only bundled source variants and fixed
operations are accepted. It does not accept arbitrary repository code, SQL or commands.
The broader Gecco product's isolated execution qualification remains separate.
