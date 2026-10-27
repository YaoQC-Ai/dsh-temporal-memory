# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.2] - 2026-10-27

### Fixed

- The concept compiler now writes the index entry for a newly created page into that page's namespace
  instead of the default namespace. This fix was listed under 1.4.1 but was missing from the published
  1.4.1 package; it is included here with a regression test.
- A newline is no longer treated as a sentence boundary. A multi-line message is one record, not
  several records sharing the same quote. A newline is used only as a fallback for an overlong run
  without punctuation; if that still does not fit, the run is hard-chunked instead of being dropped.
  Stored text collapses newlines to spaces.
- A quoted string containing sentence punctuation is no longer treated as a topic or entity. One
  quoted clause could otherwise pollute every later search.
- `DEFAULTS.ui.port` is now `18790` instead of `8790`. The field is kept for compatibility; the host
  opens no listener, and an explicit port in an existing `config.json` is unchanged.

### Added

- Repository metadata, plugin icon, and packaging for the first public release.
- Chinese install guide (`docs/install-guide.zh.md`).

## [1.4.1] - 2026-10-26

### Fixed

- Event-day attribution no longer falls back to the whole message when a sentence contains no time
  phrase. Previously, a neighbouring sentence's "yesterday" could move an unrelated statement to the
  previous day.
- A time word used as the object of a request ("backfill yesterday's journal") is no longer treated as
  the event day; the record is filed at write time.

## [1.4.0] - 2026-10-26

### Changed

- **Breaking:** L2 journals are now authored by the Agent and read-only to the plugin. The plugin no
  longer generates, backfills, overwrites, indexes, or writes sidecars for journals. `memory_journal`
  reads a day or lists written days; no file means `no_data`. Corrections no longer rewrite journals;
  deletion scrubs matching lines only.
- Journal metadata is derived from the file itself: date from the filename, authored time from mtime.
  A journal is trusted only when it is at least as new as the day's latest L1 record.
- Removed the four `journal.*` settings. A legacy `journal` block in `config.json` is ignored without an
  unknown-key warning. The settings page now exposes 16 fields.
- `memory_day` reports the journal path and authored time instead of generating a day view.

### Added

- `journal-prompt.md`, the guided prompt for a daily journal task.

## [1.3.1] - 2026-10-26

### Fixed

- Tool output no longer includes `undefined` fields, which caused the host to reject the entire tool
  result during lossless JSON validation.

### Added

- L3 concept search with weighted title, alias, core, and full-text matching. `memory_search` accepts
  `scope=l3` and `scope=all`, and falls back to L3 when L1 has no match.
- `memory_get` can resolve a concept page by title or slug.

### Changed

- The injection topic trigger uses token coverage instead of requiring the full title to appear.

## [1.3.0] - 2026-10-26

### Added

- L4 user/Agent profile: monthly rule-based revision from the previous month's evidence, month
  versions, diffs, evidence files, one injection per session, and a permanent stop when the profile is
  edited by hand.
- A Memory section in DSH Settings with per-field help and effective-source labels.

### Fixed

- The host `/memory-ui` route is registered through optional injection, so it no longer disappears when
  `webServer` becomes available after plugin apply.

### Changed

- Default L1 retention is 365 days.

## [1.2.0] - 2026-10-26

### Added

- Settings page (`settings.section`) and three-source configuration: defaults, `config.json`, profile
  patch.
- Standalone configuration console with `--root`, port fallback, Host/Origin checks, and a read-only
  memory browser.
- Lightweight `memory_health` by default, with `deep=true` for a full scan and per-stage timings.
- `import-legacy --concepts` for importing old wiki-style concept pages as L3.

### Changed

- Tools moved into the host half of the plugin and share one resolved configuration, removing the
  double-root failure mode.

## [1.1.1] - 2026-10-26

### Fixed

- Namespace isolation now covers L2, L3, tools, and injection.
- Corrections and deletions propagate into L3 body content and keep the `needs-update` marker.
- Deletion matches exact sentence hashes instead of overwriting whole records.
- Retention prunes only when a fresh, complete journal covers the day; backfilled records age from
  `recorded_at`.
- Journal reads work for stale, legacy, and post-cleanup days; pure Q&A sessions still count for journal
  coverage; `scope=l0` can still enumerate sessions after cleanup.
- Privacy marking no longer spreads to unrelated sentences in the same turn.
- Tool results use one status contract; conflicting records are returned together.

## [1.1.0] - 2026-10-26

### Changed

- Adopted the five-layer model: L2 is a day-level journal built from L0 content and L1 semantics, L1 is
  a working memory with retention, L3 merges incrementally and protects human edits, and L4 is reserved
  for the profile and growth switch.
- Redaction narrowed to credentials, with an optional privacy switch for ordinary personal information.

### Added

- `memory_journal`; nine tools in total.
- Fuzzy-time routing through journals, with an explicit fallback to L1.

## [1.0.0] - 2026-10-26

### Added

- First release: dual-time L1 records, day/topic/keyword retrieval, selective injection and cold start,
  correction and deletion propagation, configuration validation, and a local configuration console.
