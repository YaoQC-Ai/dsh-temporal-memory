# Methodology: memory that remembers time

This document explains the model behind `dsh-temporal-memory`: what a remembered fact is, how time
and validity are represented, which layers exist, and why several attractive alternatives were
rejected. It is intentionally implementation-independent — the code can change without changing these
commitments — and it is the document to read before proposing a structural change.

The concrete mapping to files and functions is in [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. The problem with transcript memory

A transcript is an excellent record of **what was said** and a poor record of **what happened**.

Three failures follow:

1. **Write time is not event time.** "We deployed on Tuesday" written on Friday is filed under Friday.
   Any question about Tuesday misses it; any answer about Friday is wrong.
2. **A correction is not an append.** Overwriting the old statement destroys the fact that a decision
   changed, who changed it, and when. Keeping both without validity makes every later answer ambiguous.
3. **A summary is not a source.** Once a lossy summary becomes the only copy, "I don't see it" and
   "it never happened" become indistinguishable.

Everything below is a consequence of taking those three failures seriously.

## 2. Principles

| # | Principle | Consequence in this design |
| --- | --- | --- |
| P1 | One immutable fact source | L0 session events are authoritative; every other layer can be rebuilt or is explicitly authored |
| P2 | Derived layers are labelled | The index is rebuilt on start; L1 is replayable from L0 |
| P3 | Time is a first-class field | Every record carries event time, precision, basis, and zone — there is no "no time" record |
| P4 | Append, do not overwrite | Corrections add records; old records receive a validity end, not a deletion |
| P5 | Provenance is mandatory | Every record points to a session and seq range; a claim without evidence is marked as a claim |
| P6 | Unknown is a valid answer | Unparsed time stays `unknown`; it is displayed, not filled in with the record clock |
| P7 | Recall is selective | Injection has triggers, a cooldown, a budget, and an explicit "data, not instructions" boundary |
| P8 | Failures stay distinguishable | Empty, unmatched, pruned, unavailable, and broken are separate statuses |
| P9 | Rules before models | Capture, time parsing, filtering, and deduplication are deterministic; models are optional and offline |
| P10 | Keep the loop small | No graph database, no per-record LLM extraction, no distributed consistency machinery |

P9 and P10 are engineering principles, not philosophy: a memory layer that is slow, expensive, or
non-deterministic will be turned off by its user, and a memory layer that is off remembers nothing.

## 3. The temporal model

### 3.1 Fields

| Field | Question it answers | Source |
| --- | --- | --- |
| `event_start_ms` | When did it begin? | The user's phrase, a tool result, or an inference |
| `event_end_ms` | When did it end (range/ongoing)? | Stated range or unknown |
| `time_precision` | How precisely do we know? | Parser |
| `time_basis` | Why do we believe this time? | `stated` / `inferred` / `recorded` |
| `time_confidence` | How strong is that belief? | Parser |
| `time_text` | Which words produced it? | Original fragment |
| `tz` | In which zone was it interpreted? | Message's client zone or configured default |
| `recorded_at` | When did the system learn it? | Host event time |
| `ingested_at` | When did the store write it? | Plugin clock |

`recorded_at` and `ingested_at` usually differ by milliseconds. Both differ from `event_time`, and that
difference is information, not noise.

### 3.2 Precision

| Precision | Meaning | Query behavior |
| --- | --- | --- |
| `minute` | A clock time was stated | Sortable as a point |
| `day` | Only a date is known | Filed under that day; no fabricated time of day |
| `range` | A stated or inferred interval | Matches any query window it overlaps; displayed as a range |
| `unknown` | No usable time evidence | Excluded from date filters, still reachable by topic |

Two prohibitions follow:

- never pad a `day` with `00:00:00` and display it as a precise time;
- never fill an `unknown` event time with `recorded_at` and call it event time.

### 3.3 Basis

- `stated` — the speaker said it ("on 12 October");
- `inferred` — resolved from context ("the 12th" said in October, or "last week");
- `recorded` — the sentence had no time at all, so the write time is used as a fallback and labelled.

`recorded` records do not disappear from daily recall, but they are not presented as if the event was
observed at that moment.

### 3.4 Zones and relative phrases

A calendar day is a local-day concept. All boundaries go through an IANA zone, and the zone used to
interpret a message is the **message's own zone** when the host provides it. "Yesterday" in the
question uses the **query's** zone. The two anchors are never mixed.

Relative phrases resolve in a fixed order: absolute → relative day → week → "N ago" → month → vague
range → clock-only. A vague phrase becomes a range, not a guessed day. A phrase that cannot be parsed
stays unknown, with its original text retained for audit.

### 3.5 Validity and supersession

Only **state-like** memories get a validity window: decisions, preferences, facts, plans, outcomes,
corrections. One-off events do not — an event does not "expire" because a later event happened.

Rules:

1. A correction creates a new record and points `supersedes` at the old one.
2. The old record receives `valid_to` and `status=superseded`; its body is never edited.
3. Default queries return records whose validity covers the query point; historical queries can select
   the version that was valid at time T.
4. If two sources conflict and neither is clearly newer or stronger, both are `disputed` and returned
   side by side. The system does not pick a winner to look decisive.
5. Repeating a preference is confirmation, not a new version: update the source and last-confirmed
   time instead of creating a chain.

This borrows the useful part of graph-based temporal memory (bi-temporal edges with an invalidation
time) without the graph: the same semantics fit in record fields, and the graph would add operational
cost with no benefit at personal-memory scale.

### 3.6 Displaying uncertainty

| Situation | Display |
| --- | --- |
| Unknown time | `event time unknown (recorded 2026-10-25)` |
| Date only | `2026-10-12 (day precision)` |
| Inferred | `approx. 2026-10-10 (inferred from "last Friday")` |
| Range | `2026-10-12 to 2026-10-14 (range)` |
| Conflict | `conflict: A says X (10-12), B says Y (10-20)` |

The display is part of the contract. Hiding uncertainty is how a memory system teaches its user to
trust it wrongly.

## 4. Layers and ownership

```text
L0  host session log              immutable, host-owned
L1  working memory                captured facts with time and provenance
L2  daily journal                 authored by the Agent from the day's evidence
L3  concept pages                 durable conclusions, source-linked
L4  user / Agent profile          soft traits, monthly, opt-in
    retrieval index               derived, rebuildable, not a layer
```

Ownership matters more than numbering:

- **L0** belongs to the host. The plugin must never rewrite history to make its own life easier.
- **L1** belongs to the plugin but is derived: it stores parsing decisions, not a copy of the
  conversation. The original turn remains in L0.
- **L2** belongs to the Agent. It is a reflection, and reflections are allowed to be lossy. The plugin
  reads it, detects staleness, and scrubs deletions; it does not generate it.
- **L3** is the knowledge authority. A conclusion lives here once it is stable enough to outlive a day.
- **L4** is advisory. It shapes tone and initiative, never facts or permissions.
- **The index** is not a memory. It is a lookup table rebuilt from L1/L3.

### Why the journal is authored, not derived

An earlier design generated journals by summarizing L0 mechanically. It looked complete and was less
useful:

- a projection of the log is a second transcript, not a memory;
- it cannot decide what mattered that day;
- it duplicates storage and drifts from the log;
- it makes "the journal is missing" impossible, which removes a useful signal.

An authored journal can say "today only one thing mattered". That selection is the value. The cost is
that the Agent must actually write it, so the design accepts a missing journal as a legitimate state and
never substitutes L1 for L2.

### The journal as an L0 index

Humans refer to history with fuzzy time: "yesterday", "last week", "the other day". Searching the raw
log for those phrases is expensive and usually unnecessary. The journal is the natural first hop:

- fuzzy time → journal for that day;
- if the journal is missing or predates the day's last record → say so and fall back to L1;
- exact IDs, quotes, and audits → L0.

This keeps the common case cheap without pretending the journal is complete.

## 5. Lifecycle

### 5.1 What gets captured

Capture candidates, in priority order:

1. explicit user statements of preference, decision, fact, plan, or correction;
2. results with tool evidence (success, failure, interruption);
3. assistant conclusions confirmed by the user;
4. milestones, configuration changes, agreements with a time;
5. anything the user explicitly asks to remember.

Excluded:

| Excluded | Why |
| --- | --- |
| Previously injected memory | Prevents feedback loops and self-pollution |
| System prompts, scaffolding, inherited sub-agent history | Not the user's memory |
| Greetings and turns with no new information | Cost without value |
| Pure lookup results with no conclusion | The answer is in L0 |
| "Done" claims without tool evidence | Intent is not fact; stored as `claim` instead |
| Credentials | Redacted at both boundaries; never stored |

### 5.2 Normalization

The capture path is deterministic:

1. read buffered turn events;
2. split sentences and classify each one;
3. resolve time per sentence;
4. extract topics and entities conservatively;
5. deduplicate by content-derived id;
6. append to L1 with fsync;
7. advance the session cursor.

No model call, no network, no dependence on wall-clock ordering between processes.

### 5.3 Compilation

Concept compilation is where generalization happens:

- a topic needs at least `compile.minRecords` stable records;
- existing pages are merged, not replaced;
- human prose outside the auto block is preserved;
- a conflicting new conclusion marks the page `needs-update` instead of silently overwriting;
- pages without sources are not created.

Compilation is rule-based in this package. An LLM can be added later, but it must stay offline, batched,
and optional; it must never run per turn.

### 5.4 Correction and deletion

Correction and deletion are different operations and get different semantics:

| Operation | Intent | Behavior |
| --- | --- | --- |
| Correction | "That was wrong; here is the truth" | New record, old record superseded, history preserved, journal untouched |
| Deletion | "Make this go away" | Body physically removed, tombstones written, journal lines and concept facts scrubbed |

A journal is a record of what was believed at the time. Rewriting it after a correction would erase the
history the system exists to preserve. Deletion is the exception, because the user asked for the content
to be gone.

### 5.5 Retention

L1 is a working memory, not an archive. A record may be pruned only when:

1. it is older than `retentionDays`, **and**
2. its event day has a journal, **and**
3. that journal was written at or after the record.

Otherwise it is retained and counted in health output. A lossy summary must never be the reason the only
copy of an event disappears.

## 6. Recall

### 6.1 Paths

| Query | Primary path | Fallback |
| --- | --- | --- |
| Date or range | Structured interval filter over L1 | Journal for fuzzy days |
| Exact identifier | Literal term match, then L0 | L3 |
| Topic / "why did we…" | Lexical match over L1 | L3 concept page |
| Current state | Active-only filter | — |
| Historical point | Validity window containing T | Supersession chain |

Date questions must be **complete within their window**: fetch all candidates, then truncate with an
explicit count and cursor. A top-k answer cannot claim "that is everything from that day".

### 6.2 Ranking

Hard filters run first: status, namespace, kind, sensitive level, time window. Then:

```text
0.45 * relevance + 0.30 * time_fit + 0.15 * validity + 0.10 * provenance
```

`recorded_at` is a tiebreaker at most. Recency is not relevance: a correct older fact must be able to
outrank a newer irrelevant note.

### 6.3 Budgets and truncation

- interactive search: a page of at most 20 items by default (`limit`, 1–50), never the whole store;
- proactive injection: at most 6 items and 1,200 tokens per block;
- over budget: return `truncated`, the remaining count, and a stable cursor.

Interactive search is bounded by items, not tokens: the caller decides how much of a page to read,
and the cursor makes the next page cheap. Injection is the path that spends context the user did not
ask for, so it is the path that carries a hard token ceiling.

A truncated result is honest; a silently shortened one is not.

### 6.4 Failure semantics

Seven situations that must never collapse into "nothing found":

| Situation | Status |
| --- | --- |
| Nothing was ever recorded | `no_data` |
| Records exist but none match | `no_match` |
| Older than retention | `out_of_retention` |
| Raw log unavailable | `l0_unavailable` |
| Part of the scope missing/stale | `partial` |
| Access denied | `permission_denied` |
| Unexpected fault | `error` |

The wording matters as much as the status: "there is no recorded memory for that period" is a different
sentence from "nothing happened".

## 7. Injection

Memory should enter a conversation the way a good colleague interrupts: rarely, briefly, and with a
reason.

- **Triggers:** time reference, known concept, current-state question, cold start.
- **Suppression:** execution-only requests, clock questions, repeated topic within the cooldown,
  no hits, secret-only hits, or a failing index.
- **Budget:** one block per turn, item and token caps, truncation notice.
- **Boundary:** the block is data, in a user-role message, with a footer saying so. Memory content is
  never promoted into system instructions.

The default is silence. A system that injects every turn trains the model to ignore memory and the user
to distrust it.

## 8. Cost model

| Stage | Frequency | Cost |
| --- | --- | --- |
| Capture + normalization | every turn | rules only; low milliseconds |
| Time parsing | per candidate | regex; no model |
| Journal | once a day, by the Agent | one authored reflection |
| Compilation | on demand / threshold | rules; batchable |
| Index | every start | in-memory rebuild |
| Retrieval | per query | linear scan over a small set |
| Injection | conditional | bounded tokens |

The expensive work is outside the conversational hot path. That is the main trade-off against designs
that extract structured memory with an LLM every turn: they adapt faster, but they pay latency and money
on every message and make behavior harder to explain.

## 9. Privacy stance

This is a local, personal assistant. The threat model is not a cloud provider; it is accidental
persistence of secrets and accidental sharing of one project's memory with another.

- **Credentials are unconditional.** Keys, tokens, private keys, passwords, credentialed URLs, and
  checksum-valid card/ID numbers are redacted at capture and at write.
- **Ordinary life is not a secret.** Preferences, habits, phone numbers, contracts, and salary are not
  discarded or marked private just because they might be sensitive. `privacy.enhanced` is an opt-in
  tightening, not a gatekeeper.
- **Isolation is explicit.** Namespaces separate projects and contexts at every layer.
- **Deletion is real.** Bodies are removed, not hidden; derived content is scrubbed.
- **No network.** Ever, by design.

## 10. Verification

A memory system is judged by whether it can be wrong in visible ways.

| Metric | Target |
| --- | --- |
| Time attribution accuracy on labelled samples | ≥ 90% |
| Day-recall coverage (within retention) | ≥ 95% |
| Correct state after a correction | ≥ 95% |
| Answers with a valid source pointer | 100% |
| Injection precision (used or relevant) | ≥ 70% |
| Injection recall on should-trigger cases | ≥ 85% |
| Correct status among the failure cases | 100% |
| Hot-path latency (capture + index) | < 100 ms p95 |
| Injection overhead | ≤ 1,200 tokens per triggered turn |
| Index rebuild determinism | identical results before/after |

The mandatory edge cases: event day ≠ record day, cross-day ranges, timezone changes, relative dates,
date-only, unknown time, correction, unresolved conflict, deletion propagation, compaction recovery,
index rebuild, no-data vs no-match, out-of-retention, permission denied.

## 11. Rejected designs

| Design | Why it was rejected |
| --- | --- |
| LLM extraction on every turn | Latency and cost on the hot path; non-deterministic records; hard to explain |
| Per-turn memory injection | Trains the model to ignore memory; burns context; no trigger discipline |
| Graph database with temporal edges | Correct semantics, disproportionate operational cost; record fields suffice |
| Journal generated by the plugin | A second transcript, not a reflection; hides the "journal missing" signal |
| Transcript summaries as the only memory | Lossy copy becomes the source; write time masquerades as event time |
| Overwrite-on-correction | Destroys history and the audit trail |
| Vector-only retrieval | Cannot answer "what happened that day" completely; literal identifiers and dates are better served by structure |
| Treating a missing journal as an empty day | Teaches the user that the system knows more than it does |

## 12. A checklist for forks

Before changing the architecture, check whether the change preserves:

- [ ] L0 remains the only immutable source, and the change does not make a derived layer authoritative.
- [ ] Every record still carries event time, precision, basis, and zone.
- [ ] Corrections still append and supersede; nothing silently overwrites history.
- [ ] A missing journal or an empty search still produces a distinguishable status.
- [ ] Capture still runs without a model on the hot path.
- [ ] Injection still requires a trigger, respects a budget, and is framed as data.
- [ ] Credential redaction is still unconditional.
- [ ] The index can still be deleted and rebuilt with identical results.

If a change cannot pass that list, it is not an optimization — it is a different memory model.
