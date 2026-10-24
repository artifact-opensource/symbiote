# Contributing

Thank you for helping improve Symbiote. Bug reports, documentation improvements, tests, and focused code changes are welcome.

## Before opening an issue or pull request

- Search existing issues and pull requests to avoid duplicates.
- For a substantial or behavior-changing proposal, open an issue first so the approach can be discussed.
- Report security vulnerabilities privately using the process in [SECURITY.md](../SECURITY.md). Do not include secrets or sensitive user data in public issues, pull requests, logs, or screenshots.

## Set up the project

Symbiote requires Node.js 20 or newer. From a fresh checkout, install both the root and web application dependencies, then build and run the test suite:

```bash
npm ci
npm --prefix webapp ci
npm run build
node --test dist/test/*.test.js
```

The web application has its own lockfile, so install its dependencies before running the full build. If your change only affects the web application, you can also run `npm --prefix webapp run build` for a focused check.

Windows MSI packaging is supported on Windows. Install the Electron runtime before building the installer:

```powershell
node node_modules/electron/install.js
npm run build:msi
```

## Make a change

- Keep each pull request focused and use the existing TypeScript, test, and documentation conventions.
- Add or update tests for behavior changes and bug fixes.
- Update user-facing documentation when commands, configuration, or behavior changes.
- Do not commit credentials, generated build output, dependency directories, or unrelated formatting changes.
- Describe any platform-specific behavior, compatibility impact, or validation you could not perform.

## Open a pull request

Use a descriptive title and complete the repository pull request template. Explain the problem, the approach, and the checks you ran. Link related issues where applicable, and call out any follow-up work or known limitations.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
