# Security Policy

## Supported Versions

Security fixes are applied exclusively to the latest code on the default branch. No backports are made to prior releases, forks, or modified deployments unless explicitly stated by the maintainer.

| Version | Supported |
|---|---|
| Latest (`main` / default branch) | :white_check_mark: |
| Any prior release, fork, or modified deployment | :x: |

## Reporting a Vulnerability

> **STOP — Do NOT open a public GitHub Issue, Pull Request, Discussion, commit comment, or any other public channel to report a security vulnerability. Public disclosure before a fix is available puts every deployment and user at immediate risk and is strictly forbidden.**

Report all suspected vulnerabilities **privately and exclusively** by email to:

**`43548757+OstinUA@users.noreply.github.com`**

Your report must include the following, wherever applicable:

- A precise description of the vulnerability and the affected component or code path.
- The severity, impact, and any realistic attack scenario or prerequisites.
- Step-by-step reproduction instructions, proof-of-concept requests, or sample payloads.
- The affected deployment URL, commit SHA, or environment details.
- Your contact information for coordinated follow-up.

The maintainer will acknowledge receipt as promptly as possible, investigate the issue, and coordinate remediation and responsible disclosure timing with you before any public statement is made.

## API Key & Data Privacy Policy

This project uses GitHub API tokens (`GH_TOKEN` / `GITHUB_TOKEN`) solely to authenticate outbound requests to the GitHub REST API and increase rate-limit quotas when rendering the SVG badge.

**This project does NOT collect, log, transmit, or store any user-supplied API keys or personal data on external servers.**

Specifically:

- All processing occurs **locally** within the serverless execution context (e.g., Vercel Function) that handles each badge request. No data is forwarded to unrelated third-party services, analytics providers, or databases controlled by this project.
- User-supplied tokens and personal data are **never** persisted beyond the operator-configured runtime environment variables required to fulfill a request.
- Repository issue data is fetched directly from GitHub APIs at request time and used exclusively to render the SVG response. It is not cached on external storage or shared with any third party.
- This project provides no mechanism for end users to submit, upload, or transmit API keys to a hosted database or external storage service.
- Operators bear full responsibility for securing their own tokens and secrets using their hosting platform's secure environment-variable facilities.

## Security Best Practices for Operators

- Store `GITHUB_TOKEN` or `GH_TOKEN` exclusively in trusted local environments or a secure hosting secret manager (e.g., Vercel Environment Variables). **Never** hard-code tokens in source files.
- Grant the minimum token scope required for the GitHub API access this project needs (typically read-only access to public repository data).
- Rotate tokens immediately upon any suspected or confirmed exposure.
- Audit deployed instances for accidental logging, custom middleware, or third-party observability tools that could inadvertently capture request metadata containing secrets.
- Keep all runtime dependencies and the deployment platform updated with current security patches.

## Coordinated Disclosure Policy

Responsible, coordinated disclosure is required. Please allow the maintainer a reasonable remediation window before making any public statement about a vulnerability. Once the issue is fully resolved, the maintainer may publish a security advisory, patch notes, or a coordinated disclosure as appropriate.
