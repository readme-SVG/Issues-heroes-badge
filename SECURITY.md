# Security Policy

## Supported Versions

This project is currently maintained as a single active release line. Security fixes are applied to the latest code on the default branch and are not backported unless the maintainer explicitly states otherwise.

| Version | Supported |
| --- | --- |
| Latest default branch | :white_check_mark: |
| Earlier releases, forks, or modified deployments | :x: |

## Reporting a Vulnerability

If you believe you have found a security vulnerability in this project, report it privately by email to **43548757+OstinUA@users.noreply.github.com**.

Do not open a public GitHub Issue, Discussion, Pull Request, commit comment, or any other public disclosure for suspected security vulnerabilities. Public reports are strictly forbidden because they can expose users and deployments before a fix is available.

When reporting a vulnerability, include the following whenever possible:

- A clear description of the issue and the affected component.
- The impact, attack scenario, and any prerequisites.
- Exact reproduction steps, proof-of-concept requests, or sample payloads.
- The affected deployment URL, commit SHA, version, or environment details.
- Your contact information for coordinated follow-up.

The maintainer will review private reports, confirm receipt as quickly as possible, investigate the issue, and coordinate remediation and disclosure timing.

## API Keys and Data Privacy

This project may rely on third-party API keys, such as GitHub access tokens, to increase API quota or enable authenticated upstream requests. Those keys are used only by the local runtime or the deployed client-side/serverless execution context that serves the badge.

This project is designed so that user-supplied API keys and personal data are **not** collected, logged, transmitted to unrelated third-party services, shared with analytics providers, or stored on external servers controlled by this project. Processing is performed locally or strictly within the client-side/serverless execution path required to fulfill the badge request.

In particular:

- The project does not provide a feature for end users to submit or upload API keys through a hosted database or external storage service.
- The project does not intentionally persist user API keys or personal data beyond the runtime environment variables configured by the operator.
- Repository issue data is fetched directly from GitHub APIs at request time for rendering the SVG response.
- Operators are responsible for configuring secrets using their hosting platform's secure environment-variable facilities.

## Security Best Practices for Operators

- Store `GITHUB_TOKEN` or `GH_TOKEN` only in trusted local environments or secure hosting secret managers.
- Grant the minimum token scope necessary for the intended GitHub API access.
- Rotate tokens immediately if you suspect exposure.
- Review badge deployments for accidental logging, custom middleware, or third-party observability tools that could capture request metadata.
- Keep dependencies, the runtime, and the deployment platform updated with current security patches.

## Disclosure Policy

Coordinated disclosure is required. Please allow the maintainer a reasonable period to validate and remediate the issue before any public statement is made. Once the issue is resolved, the maintainer may publish an advisory, patch notes, or other disclosure details as appropriate.
