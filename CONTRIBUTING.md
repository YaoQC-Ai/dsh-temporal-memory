# Contributing

Thanks for considering a contribution. This project is small on purpose, and the fastest way to get a
change merged is to keep it small too.

## Ground rules

These are not style preferences; they are the properties the plugin is sold on:

1. **No model calls on the hot path.** Capture and recall run every turn. They stay deterministic.
2. **No new runtime dependency** unless the maintainers agree first. Node's standard library has been
   enough so far.
3. **L0 stays authoritative.** Do not make a derived layer (L1, journal, concept, index) the only copy
   of anything.
4. **Do not erase history.** Corrections append and supersede. Only deletion physically removes content.
5. **Keep failures distinguishable.** Do not collapse `no_data`, `no_match`, `out_of_retention`, and
   `error` into one empty result.
6. **No secrets in the repository.** Not in code, tests, fixtures, issue reports, or screenshots.

If a change conflicts with one of these, open an issue first. It may still be a good idea; it is a
different design.

## Development

Requirements: Node.js ≥ 20. There is no build step and no runtime dependency.

```bash
git clone https://github.com/YaoQC-Ai/dsh-temporal-memory.git
cd dsh-temporal-memory
node --test
```

The suite is self-contained and does not touch the network or your real `DSH_HOME`. Use a temporary
directory in tests, not the user's environment.

On Windows, if the checkout is on a UNC path, run `node --test` directly rather than through `npm test`:
the `cmd.exe` shim cannot use a UNC path as its working directory.

## What a good change includes

- **A test that fails without the change.** Bug fixes get a regression test at the level of the broken
  contract, not the internal function that happened to break.
- **A scoped diff.** One concern per pull request. Refactors separate from behavior changes.
- **A note about storage impact.** If the change alters a field, a default, or a file layout, say what
  happens to existing data.
- **Documentation in the same change.** Configuration keys, tool output, and status values are public
  contracts.

### Adding a configuration key

A key is not done when it parses. Update all of these:

1. `lib/config.js` — default and validation;
2. `client.js` — field label, help text, and group, if it belongs in Settings;
3. `lib/config-ui.js` — standalone console, if the field should be editable there;
4. `README.md` — configuration table;
5. a test in `test/config.test.js` (or the closest existing test) for default and invalid values.

### Adding a status

Statuses are a public contract across tools, injection, and the UI:

1. `lib/search.js` — add to `STATUSES`;
2. the tool schema and result projection in `tools.js`;
3. every caller that switches on status;
4. tests and the README table.

## Style

- Plain ESM, no TypeScript, no bundler.
- Two-space indentation, single quotes, no semicolons-free experiments — match the file you are editing.
- Comments explain **why**, not what. If a guard exists because of a host quirk, name the quirk.
- User-facing strings (settings page, injected labels, tool messages) and test titles are Chinese;
  code, comments, and documentation are English. The corpus stays Chinese because capture and time
  parsing are Chinese-first — fixtures are real sentences, not translated ones.
- Prefer deleting code to adding an abstraction. A helper used once is usually not a helper.

## Commits and pull requests

- Write commit subjects in the imperative mood: `fix: keep the day when a sentence has no time phrase`.
- Explain the user-visible behavior in the pull request body, and mention the verification you ran.
- Do not bump the version or edit `CHANGELOG.md` in a feature pull request; the maintainer does that at
  release time.

## Reporting a security issue

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
