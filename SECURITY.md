# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.4.x | Yes |
| < 1.4 | No |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability).
Do not open a public issue, and do not include real memory content, credentials, or personal data in the
report.

Please include:

- the affected version and DSH/Node versions;
- a minimal reproduction, ideally against a throwaway `DSH_HOME`;
- the impact you believe it has;
- whether the issue requires local access to the machine or the data directory.

## In scope

- A credential that is stored in memory despite redaction.
- A path traversal or arbitrary write through configuration, namespaces, imports, or the settings
  server.
- A namespace escape in L2, L3, tools, or injection.
- Cross-project memory exposure through the tools or the settings console.
- Execution of memory content as instructions in a path the plugin controls.
- XSS or request forgery in the settings console or the host `/memory-ui` route.
- The settings server binding to a non-loopback address or accepting a cross-origin request.

## Out of scope

- A local user with filesystem access reading `$DSH_HOME/memory/temporal/`. The store is plain files by
  design; namespaces are isolation, not OS-level access control.
- Vulnerabilities in DSH itself, in other plugins, or in a model's willingness to follow injected text
  when the host ignores message boundaries.
- Data copied out of the store by backup software, cloud sync, or the user.
- Memory content that is inaccurate because the input was ambiguous. Report that as a bug, not a
  vulnerability.

## Design guarantees

- Credential redaction is unconditional at capture and at write; no setting disables it.
- The plugin makes no network requests.
- The standalone console binds to loopback only, validates `Host` and `Origin`, limits request bodies
  to 64 KB, and renders stored content with `textContent`.
- Injected memory is a user-role message labelled as historical data, not a system instruction.
- Deletion removes bodies and scrubs derived journals and concept pages; audit logs record the event,
  not the content.

## Handling

Reports are acknowledged as soon as possible, assessed for severity and reproducibility, and fixed in a
patch release when confirmed. Credit is given in the release notes unless you ask otherwise.
