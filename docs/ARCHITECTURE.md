# Architecture

This document describes how `dsh-temporal-memory` is put together: the layers, the write and read
paths, the durability guarantees, and the failure modes the code is designed to distinguish. It is
written for maintainers and for readers who want to verify the behavior rather than take the README's
word for it.

The public methodology — why the design looks like this and what was rejected — is in
[METHODOLOGY.md](METHODOLOGY.md).

## 1. Constraints

Five constraints shape every decision below:

1. **The host owns history.** DSH's session log is the only immutable fact source. The plugin can
   read it through `sessionQuery`; it cannot rewrite it.
2. **No model on the hot path.** Capture runs on every turn, so it is deterministic rule matching:
   same input, same records, no network, no latency spikes.
3. **Zero runtime dependencies, no build step.** Plain Node ESM (≥ 20). The package must keep working
   offline and be auditable in an afternoon.
4. **Local only.** All state lives under `$DSH_HOME/memory/temporal/`; nothing is uploaded.
5. **Failure must stay distinguishable.** "No record", "pruned", "no match", "L0 unavailable", and
   "broken" are different answers and stay different all the way to the tool result.

## 2. Layers

| Layer | Implementation | Authority | Rebuildable |
| --- | --- | --- | --- |
| L0 | Host session events | Highest; immutable | By the host, not this plugin |
| L1 | `events/YYYY-MM.jsonl` | High; derived from L0 plus parsing decisions | Yes, by replaying L0 |
| L2 | `journal/YYYY-MM-DD.md` | Low; a reflection, not a ledger | No; authored by the Agent |
| L3 | `knowledge/*.md` | High for conclusions | Partly; from L1/L2 by recompilation |
| L4 | `profile/` | Advisory; soft traits only | Yes; monthly rule-based regeneration |
| index | Process memory | None | Yes; rebuilt on every start |

Two points that are easy to get wrong:

- **L2 is not derived by the plugin.** Earlier versions generated journals from L0. That produced a
  transcript-shaped projection, not a memory. Since 1.4 the Agent writes the journal from the day's
  evidence; the plugin only reads it, detects staleness, and scrubs deleted content. A journal is a
  reflection: it may compress, omit, and interpret, because the authoritative record still exists.
- **The index is not a layer.** It is a derived in-memory term table (Chinese bigrams, English words)
  rebuilt at startup. It occupies no layer number, is never exported, and is never a source of truth.

## 3. Write path

### 3.1 Turn assembly

`index.js` subscribes to `session/event` and keeps a small per-session buffer in a `WeakMap`:

- `turn/start` resets the buffer;
- `user/message` appends text plus the event timestamp and the client's `clientTimeZone`, when present;
- `assistant/message` accumulates text and tool-call ids;
- `tool/result` records name, success flag, a 300-character summary, timestamp, and seq;
- `turn/end` classifies the buffer and flushes it.

Only events needed to reconstruct a turn are tracked. The whole handler is wrapped so a capture bug can
never break a session.

Each message also triggers `persistPending`, a snapshot of the in-flight turn under `state/pending/`.
If the process dies before `turn/end`, the next `agent/created` recovers the snapshot as a turn with
status `error` instead of losing it.

### 3.2 Classification

`lib/classify.js` splits user text on newlines and sentence punctuation, then assigns one kind per
sentence with a fixed precedence:

```text
correction > preference > decision > plan > fact > event
```

Assistant output produces at most one record per turn. A sentence claiming completion becomes an
`outcome` only if a tool call succeeded in the same turn; otherwise it is stored as a `claim` with
`time_precision=unknown`. Plans and results are deliberately not merged: an intention is not evidence.

Topics come from a small noun-phrase pattern, quoted strings, and CamelCase identifiers (maximum five).
Entities are configured names plus quoted proper nouns. Both are conservative: a missed tag is cheaper
than a wrong tag polluting every future search.

### 3.3 Time resolution

`lib/time.js` parses a phrase relative to an anchor instant in a configured IANA zone. Rules are tried
most-specific first:

1. explicit range (`10月12日到14日`);
2. absolute date, optionally with clock time (`2026-10-12 14:30`);
3. relative day (`今天`, `昨天`, `前天`, `明天`, …);
4. week expression (`上周三`, `这周` → a seven-day range);
5. `N days/weeks/months ago`;
6. month expression (`上个月`, `2026年7月`, `7月`);
7. vague recent range (`最近`, `前几天` → the last seven days);
8. clock time without a date → anchor day, marked `inferred`.

The parser returns a start, an end, a precision (`minute` / `day` / `range` / `unknown`), a basis
(`stated` / `inferred` / `recorded`), a confidence, and the original phrase. It returns `null` when
nothing matches; callers fall back to record time with `time_basis=recorded` and never to "now".

Two invariants prevent quiet date corruption:

- **Time belongs to its sentence.** A date phrase in one sentence must not shift a neighbouring
  sentence. There is no "fall back to the whole message" retry.
- **Object time is not event time.** "Backfill yesterday's journal" uses a time word as the object of
  the request; it is recorded at write time, not filed under yesterday.

Day boundaries and `dateKey` go through `Intl` in the message's zone, so DST transitions and
non-hour offsets do not move an event to the wrong calendar day.

### 3.4 Persistence and idempotency

Records are appended to the monthly shard of their `recorded_at` month, one JSON object per line,
with `fsync` before the call returns. Record ids are content-derived
(`session + turn + seq + normalized text`), so re-processing the same turn produces the same id and
`Store.append` skips duplicates.

Ordering is deliberate: **records first, cursor second**. A crash between the two causes a turn to be
reprocessed, which the id check absorbs. The reverse order could silently lose a turn.

Two operations rewrite a shard atomically (write temp file, then rename):

- **deletion** replaces a line with a tombstone, so the body is physically gone while other line
  offsets stay valid;
- **supersession** writes `status`, `valid_to`, and `superseded_by` onto the old record.

### 3.5 Supersession

A `correction` record can carry an explicit target. When it does not, `findSupersedeTarget` looks for
candidates within 30 days sharing a topic or entity. It links only when there is exactly one candidate.
Ambiguity is resolved by the user (`memory_correct`), not by a guess.

The link is persisted on both records, and `applySupersedes` is also applied at read time so logs
written by older versions still resolve correctly.

### 3.6 Crash and compaction recovery

- Pending snapshots are consumed once per session object; recovery records the turn as `error`.
- After a context-window compaction, `agent/request-error` re-appends the last injected block once if
  `replaceGeneration` advanced. Other request errors are left to the host.
- L1 is never rewritten to follow compaction: `shadowedSeqs` in L0 remain the source pointer.

## 4. Read path

### 4.1 Injection triggers

`agent/pre-step` runs on the first step only and returns the host decision unchanged unless a trigger
matches:

| Priority | Trigger | Signal |
| --- | --- | --- |
| 1 | `time` | A recognizable time phrase; query window comes from the parser |
| 2 | `topic` | An existing concept title/alias/token overlap |
| 3 | `state` | "currently", "what did we decide", "my preference" |
| — | cold start | New, restored, or compacted session with no explicit reference |

Pure execution requests ("run the tests") and clock questions are suppressed. A repeated topic is
suppressed for `cooldownTurns`. One block per turn maximum, bounded by `maxItems` and `maxTokens`.

The block is appended as a **user-role** message with source kind `plugin:memory-temporal`. It is
never merged into the system prompt, and its footer states that the content is data, not instructions.
The L4 profile uses a separate source kind (`plugin:memory-temporal-profile`) so it does not count as a
recall injection and block later recall.

### 4.2 Routing

| Query shape | Route |
| --- | --- |
| Fuzzy time ("yesterday", "last week") | L2 journal; if missing or stale, return `fallback_reason` and query L1 |
| Keyword, date range, kind, status | L1 |
| Exact id / quote / audit | L0 via `scope=l0` (or `exact=true`) |
| Concept lookup | L1, then L3 automatically (`route=l3-fallback`) |
| Explicit `scope=l3` / `all` | L3 only / merged L1+L3 |

A day with L1 records and no journal is reported as `partial` with `missing` dates — not as an empty
day. A journal older than the day's latest record is reported as `stale`. Both carry `fallback: 'l1'`.

### 4.3 Ranking

After hard filters (status, namespace, kind, time window), scoring is:

```text
score = 0.45 * relevance + 0.30 * time_fit + 0.15 * validity + 0.10 * provenance
```

- relevance: term hits in text (weight 1) and in topics/entities (weight 2), plus a full-phrase bonus;
- time_fit: interval overlap with the requested window; neutral 0.5 when no window is given;
- validity: active 1.0, disputed 0.6, superseded 0.3;
- provenance: quoted source 1.0, session pointer 0.6, none 0.3.

`recorded_at` is **not** a ranking weight. Using it would make recently written memories outrank
better matches and silently invert history.

Pagination uses a value cursor `s:<score>:<id>`, so inserting records between pages cannot duplicate or
skip an item. A plain offset cannot make that guarantee.

### 4.4 Status contract

Every tool result carries one status:

| Status | Meaning |
| --- | --- |
| `ok` | Hits returned |
| `partial` | Part of the requested scope is missing or stale |
| `no_data` | Nothing was ever recorded in this filter |
| `no_match` | Records exist, but none match the query |
| `out_of_retention` | The window predates L1 retention |
| `l0_unavailable` | The host raw-session resolver is unavailable |
| `no_l0_sessions` | No L0 sessions matched the enumeration request |
| `invalid_query` | The request cannot be interpreted (bad date, bad cursor, …) |
| `permission_denied` | Namespace/file access denied |
| `error` | Unexpected failure |

`no_data` is explicitly documented as "the store does not cover this", not "it did not happen".

## 5. L2 journal contract

The journal has no sidecar, no index, and no metadata file. Its facts are the file itself:

- date ← filename `YYYY-MM-DD.md`;
- authored time ← file `mtime`;
- size ← `stat.size`.

`journalCovers(day, latestRecordedAt)` returns `covered` only when the file's mtime is at or after the
latest L1 record for that day. That single comparison drives two features:

- retention may prune an L1 record only when its day is covered;
- fuzzy-time search may trust the journal only when it is covered, otherwise it flags staleness.

The plugin writes journals only in one case: deletion scrubs matching lines. Corrections never rewrite
a journal, because a journal records what was believed that day.

## 6. L3 concept pages

`saveConcept` owns the write path. Pages are Markdown with YAML frontmatter and carry source links,
status, memory type, and dates. Compilation writes into a marked auto block:

```markdown
<!-- auto:begin -->
...
<!-- auto:end -->
```

Human prose outside the block is preserved. When the page exists, `saveConcept` merges: sources are
appended, change entries are appended, and old conclusions are not overwritten. A conflict marks the
page `needs-update` rather than silently choosing a winner.

Propagation is part of the contract:

- correction → `markConceptSourcesCorrected` replaces the current conclusion and marks the page;
- deletion → `markConceptSourcesDeleted` removes the fact from auto blocks, human core content, and
  annotations, then marks the page;
- `memory_compile` recompiles only topics with new records; human-edited pages only receive candidates.

## 7. L4 profile

The profile is opt-in (`growth.enabled`) and runs at most once per month, on `agent/created`, for the
**previous** month:

1. gather counts and topics from L1, journal entries, and concept pages — not raw conversations;
2. require at least five L1 records, otherwise leave the previous version untouched;
3. derive soft traits by rules (verbosity, initiative, reminders, capabilities, focus);
4. write a month version to `history/YYYY-MM.md`, a line diff, evidence pointers, and `_state.json`;
5. inject the profile once per session per version.

`_state.json` stores a content hash. If the hash no longer matches `personality.md`, a human edited it:
the plugin stops automatic revision and reports `human_edited` instead of overwriting. Deleting the
hash (or `_state.json`) resumes automatic maintenance.

The profile may adjust style and initiative. It must not change system role, safety policy, permissions,
or memory-write rules, and it never rewrites user-profile facts.

## 8. Storage and durability

```text
$DSH_HOME/memory/temporal/
  config.json
  events/YYYY-MM.jsonl          # L1, append + fsync
  journal/YYYY-MM-DD.md         # L2, Agent-authored
  journal/namespaces/<hash>/    # non-default namespace
  knowledge/*.md                # L3
  knowledge/namespaces/<hash>/
  profile/                      # L4 state, versions, evidence
  state/cursor.json             # per-session seq
  state/pending/<session>.json  # in-flight turn snapshots
  state/sessions.jsonl          # session directory for L2 coverage and L0 enumeration
  state/deleted.json            # deletion ranges for L2 scrubbing
  audit/YYYY-MM-DD.jsonl        # events, never bodies
```

- JSON state: write temp file, fsync, rename.
- Text state (concept pages, journals during scrub): write temp, rename.
- Event/audit logs: `open(..., 'a')`, write one line, `fsync`.
- Multi-process access is **not** locked. Concurrent writers to the same `DSH_HOME` rely on line
  atomicity and may overwrite each other's cursors. This is a known limitation, not a hidden guarantee.

## 9. Security model

- **Trust boundaries.** Host session events are untrusted text. They are redacted at capture and again
  at storage. Tool results are untrusted too; only their success flag is treated as evidence of
  execution.
- **Prompt injection.** Memory is injected as data, in a user-role message with an explicit boundary
  and a footer. The plugin never appends memory to the system prompt and never executes instructions
  found in a record.
- **Namespaces.** Non-default namespaces are stored in separate directories and filtered at every
  layer: L2, L3, tools, and injection. They are not a security boundary against a local user who can
  read the files — they are an isolation boundary between projects and contexts.
- **Settings surface.** The standalone console binds loopback only, validates `Host` and `Origin`,
  caps request bodies at 64 KB, sends CSP headers, and renders memory content with `textContent`.
  It refuses relative paths so a typo cannot silently create an empty store on another drive.
- **Deletion.** Physical delete plus a tombstone; content is scrubbed from journals and concept pages.
  Audit files record that a deletion happened, never the deleted text.

## 10. Failure modes

| Symptom | Behavior |
| --- | --- |
| `sessionQuery` missing or not injected | Plugin still applies; only `scope=l0` and exact verification return `l0_unavailable` |
| Journal missing for a day with records | Fuzzy recall returns `partial` with `missing` and falls back to L1 |
| Journal written before the day's last record | Reported as `stale`; falls back to L1 |
| Corrupt JSONL line | Skipped during read, counted by `memory_health --deep`, never fatal |
| Crash mid-turn | Pending snapshot recovered on the next `agent/created` as status `error` |
| Crash between append and cursor write | Turn reprocessed; content ids make it idempotent |
| Compaction evicts the injection | Re-appended once on a retry after `CONTEXT_WINDOW_EXCEEDED` |
| Config root mismatch between host and tools | Reported in `configErrors`; `memory_health.root` shows the actual path |
| Index rebuild | Automatic on process start; no persistent index to go stale |
| Disk write failure | Logged; capture degrades but does not break the session |

## 11. Non-goals

- No vector database or embedding model. Adding one is an explicit product decision, not an assumed
  upgrade path.
- No graph database. Validity and supersession are record fields, not graph edges.
- No LLM extraction on the hot path. LLM use is limited to optional offline compilation and remains
  off by default.
- No retroactive rewriting of history. Corrections add records; journals and past events keep what was
  believed at the time.
- No cross-device sync, account system, or multi-agent shared memory. The store is local to one
  `DSH_HOME`.

## 12. Testing strategy

The suite is `node --test`, zero dependencies, no network. It is organized around contracts rather than
implementation details:

- time parsing across relative, absolute, week, range, and DST boundaries;
- classify and redact, including "same turn does not contaminate a neighbouring sentence";
- sharded storage, tombstones, idempotent append, journal-gated retention;
- ranking, stable cursors, and every status returned by `searchRecords`;
- L2 read-only contract: mtime-derived metadata, `journalCovers` three states, missing/stale routing;
- namespace isolation across L2, L3, tools, and injection;
- correction and deletion propagation into L3;
- concept merge incrementality and human-page protection;
- configuration precedence and source reporting;
- the settings client contract and host `/memory-ui` route, including the `webServer` injection timing
  regression;
- L4 growth: off, insufficient evidence, human takeover, injection;
- a synthetic session-event replay covering capture → injection → compaction recovery → crash recovery.
