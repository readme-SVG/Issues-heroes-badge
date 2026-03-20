# Contributing Guide

## 1. Introduction

Thank you for your interest in contributing to this repository. We appreciate every contribution, from typo fixes and bug reports to architectural proposals and production-grade code improvements.

This project powers a serverless, logging-style GitHub issue telemetry badge, so reliability, safety, and determinism are critical. Please read this document before opening issues or pull requests to keep collaboration efficient and review cycles short.

## 2. I Have a Question

The GitHub issue tracker is reserved for:

- Reproducible defects (bugs)
- Clearly scoped feature requests

Please do not use issues for general usage questions, troubleshooting that lacks reproducible steps, or open-ended support requests.

For questions and community help, use one of the following:

- GitHub Discussions (preferred for repository-specific Q&A)
- Stack Overflow (tag your question appropriately)
- Community channels maintained by project maintainers (if available in `README.md`)

When asking a question, include:

- What you are trying to achieve
- What you already tried
- Relevant logs, snippets, or request examples
- Runtime environment details

## 3. Reporting Bugs

High-quality bug reports are actionable, reproducible, and minimal. Before submitting, verify that behavior is not expected from current documentation.

### Search Duplicates

Before creating a new issue:

1. Search open issues for matching symptoms and error messages.
2. Search closed issues/PRs for previously resolved behavior.
3. If a related issue exists, add your details there instead of opening a duplicate.

### Environment

Every bug report must include a complete environment matrix:

- Operating system and version (for example, `Ubuntu 24.04`, `macOS 15.x`, `Windows 11`)
- Node.js version (`node -v`)
- npm version (`npm -v`)
- Library/application version or commit SHA
- Deployment/runtime context (local Node, Vercel serverless, CI job, etc.)
- Relevant environment variables (redact secrets)

### Steps to Reproduce

Provide a deterministic sequence that another contributor can execute exactly:

1. Initial state and preconditions
2. Exact commands run
3. Input payload/query parameters used
4. Observed output/logs
5. Frequency (`always`, `intermittent`, `% occurrence`)

If possible, provide a minimal reproducible repository or script.

### Expected vs. Actual Behavior

Your report must explicitly include:

- Expected behavior: what should happen and why
- Actual behavior: what happened instead
- Impact: how this blocks or degrades real usage

### Bug Report Checklist

Use this checklist before submitting:

- [ ] I confirmed this is not a usage question.
- [ ] I searched existing issues for duplicates.
- [ ] I included full environment details.
- [ ] I provided exact reproduction steps.
- [ ] I described expected and actual outcomes.
- [ ] I attached logs/screenshots/SVG output when relevant.

## 4. Suggesting Enhancements

Enhancements include API changes, new rendering behavior, moderation pipeline updates, performance improvements, and infrastructure upgrades.

### Justification

Explain the problem first, not the solution only:

- What concrete limitation exists today?
- Who is affected?
- Why is current behavior insufficient?

### Use Cases

Include at least one concrete, real-world use case:

- Input conditions
- Desired output or workflow
- Why existing alternatives are inadequate

### Strong Enhancement Proposals Include

- Scope boundaries (what is in/out)
- Backward compatibility considerations
- Operational impact (latency, API usage, rate limits)
- Security/moderation implications
- Migration notes for users (if behavior changes)

## 5. Local Development / Setup

### Fork and Clone

1. Fork the repository on GitHub.
2. Clone your fork locally:

```bash
git clone https://github.com/<your-username>/Issues-heroes-badge.git
cd Issues-heroes-badge
```

3. Add upstream remote:

```bash
git remote add upstream https://github.com/<upstream-owner>/Issues-heroes-badge.git
git remote -v
```

### Dependencies

Install dependencies:

```bash
npm install
```

For CI-like deterministic install:

```bash
npm ci
```

### Environment Variables

This project reads environment variables directly from process environment.

1. Create a local env file if your tooling supports it:

```bash
cp .env.example .env
```

2. If `.env.example` is not present, define variables manually in your shell or deployment config.

Recommended variables:

- `GITHUB_TOKEN` (preferred)
- `GH_TOKEN` (fallback)
- `BANNED_WORDS_REPO` (optional override)
- `BANNED_WORDS_BRANCH` (optional override)

Example:

```bash
export GITHUB_TOKEN=<your_token>
export BANNED_WORDS_REPO=readme-SVG/Banned-words
export BANNED_WORDS_BRANCH=main
```

### Running Locally

This repository is structured for serverless execution.

Common local workflow:

```bash
# Install dependencies
npm install

# Start local Vercel runtime (if Vercel CLI is installed)
npx vercel dev

# Example request
curl "http://localhost:3000/api?user=readme-SVG&repo=Issues-heroes-badge"
```

If you do not use Vercel CLI, run the function through your preferred local serverless emulator.

## 6. Pull Request Process

### Branching Strategy

Use short-lived topic branches from `main` with strict naming conventions:

- `feature/<short-kebab-description>`
- `bugfix/<issue-number-or-short-description>`
- `chore/<scope>`
- `docs/<scope>`
- `refactor/<scope>`

Examples:

- `feature/add-svg-theme-variant`
- `bugfix/214-label-filter-null-check`
- `docs/contributing-guide`

### Commit Messages

This project requires Conventional Commits:

- `feat: add new transport`
- `fix: resolve memory leak`
- `docs: add troubleshooting notes`
- `refactor: simplify issue validation pipeline`
- `test: cover duplicate-name filter`
- `chore: bump dependency versions`

Guidelines:

- Use imperative mood
- Keep subject concise and specific
- Reference issue IDs in body/footer when relevant

### Upstream Synchronization

Before opening a PR, rebase or merge latest upstream `main`:

```bash
git fetch upstream
git checkout main
git pull --ff-only upstream main
git checkout <your-branch>
git rebase main
```

Resolve conflicts locally and rerun checks before pushing.

### PR Description Requirements

Every PR body must include:

- Problem statement and context
- Summary of changes
- Linked issues (for example, `Closes #123`)
- Testing evidence (commands + output summary)
- Backward compatibility or migration notes (if applicable)
- Screenshots/SVG output samples for user-visible rendering changes

PRs missing this context may be marked as `needs-info`.

## 7. Styleguides

Contributors are expected to keep changes minimal, cohesive, and production-oriented.

### Code Quality and Formatting

Current repository status:

- No linter or formatter scripts are configured in `package.json` yet.
- Until tooling is formalized, follow consistent JavaScript style and keep diffs focused.

Recommended when adding tooling in future PRs:

- ESLint for static analysis
- Prettier for formatting

### Naming and Architecture Conventions

- Use clear, domain-oriented names (`issues`, `bannedPatterns`, `validatedHeroes`, etc.).
- Keep serverless handler logic deterministic and side-effect aware.
- Prefer pure helper functions for parsing/validation/filtering stages.
- Preserve validation-first pipeline design.
- Avoid introducing hidden global mutable state.

### Documentation Conventions

- Update `README.md` when behavior or configuration changes.
- Keep examples copy/paste ready.
- Explicitly document breaking changes.

## 8. Testing

All new features and bug fixes must include appropriate tests.

- Add unit tests for isolated parsing/filtering/normalization behavior.
- Add integration-style tests for endpoint responses where feasible.
- Include regression tests for previously reported bugs.

Run local checks before opening a PR:

```bash
npm install
npm test
```

If you add dedicated quality scripts, run them as well (examples):

```bash
npm run lint
npm run format:check
npm run test:unit
npm run test:integration
```

If a test suite is not yet fully configured, include manual verification evidence in the PR description (request URL, sample response, and expected behavior validation).

## 9. Code Review Process

After you open a PR:

1. A maintainer triages scope, risk, and repository fit.
2. Reviewers evaluate correctness, architecture, backward compatibility, and operational impact.
3. CI and required checks must pass before merge.

### Review and Merge Policy

- Minimum approvals required: **1 maintainer approval**.
- High-risk changes (API contract, moderation behavior, rendering pipeline) may require **2 approvals**.
- Only maintainers perform merge operations.

### Addressing Feedback

- Respond to every review thread clearly.
- Push incremental commits for requested changes.
- Re-request review after updates.
- Keep discussion technical and evidence-driven.

A PR may be closed if it remains inactive for an extended period or diverges from project direction. In that case, maintainers may ask for a smaller follow-up PR.

Thank you for helping improve the project.
