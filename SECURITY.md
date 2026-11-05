# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
**Security → Report a vulnerability** form for this repository, not as a public
issue. I aim to reply within a few days and to ship a fix for confirmed issues
in the next release.

## Supported versions

Only the latest release on addons.mozilla.org receives fixes.

## How the project keeps its supply chain small

- No runtime dependencies. The shipped extension is plain JavaScript with no
  bundler, no minification and no remote code, so the reviewed source is
  exactly what runs.
- Dev dependencies (`web-ext`, `playwright`) are pinned and kept current with
  Dependabot.
- Every push runs Mozilla's add-on validator, the test suite and `npm audit`.
- Releases are built and submitted from a tagged commit by GitHub Actions.
