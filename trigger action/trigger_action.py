"""Turn a code change into a reviewed GitHub issue and an optional PR summary.

The script runs inside the ``ai-issue`` workflow. It collects the diff of the
event that triggered the run, asks the hosted model for a structured review, and
publishes the result as an issue (plus a short comment on the pull request).

Design notes:

* everything is driven from :func:`main`; importing this module has no side
  effects, so it can be unit tested and imported by tooling without a token;
* every external dependency (GitHub, the model endpoint) is injected through
  small, replaceable functions;
* environment validation happens before the first network call, so a
  misconfigured workflow fails loudly with a readable message instead of a
  traceback from a library.

Required environment:
    GITHUB_TOKEN      Token with ``issues: write`` and ``pull-requests: write``.
    GH_MODELS_TOKEN   Bearer token for the model endpoint.
    REPOSITORY        ``owner/repo`` of the repository being analysed.
    EVENT_NAME        ``push`` or ``pull_request``.
    ALLOWED_USER      Comma-separated logins whose changes may be analysed.
    COMMIT_SHA        Commit under review (push events).
    PR_NUMBER         Pull request number (pull request events).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import requests
from github import Auth, Github, GithubException
from github.PullRequest import PullRequest
from github.Repository import Repository

MODEL_NAME = "Llama-3.3-70B-Instruct"
MODEL_ENDPOINT = "https://models.inference.ai.azure.com/chat/completions"

PUSH_DIFF_LIMIT = 10_000
PULL_REQUEST_DIFF_LIMIT = 80_000
MIN_DIFF_LENGTH = 50

# GitHub rejects issue bodies longer than 65 536 characters.
MAX_BODY_LENGTH = 65_000

MODEL_RETRIES = 3
MODEL_RETRY_DELAY_SECONDS = 5
MODEL_TIMEOUT_SECONDS = 60

LABEL_TO_ROLE = {
    "sec": "security",
    "security": "security",
    "audit": "security",
    "review": "review",
    "refactor": "review",
    "code-review": "review",
    "qa": "qa",
    "test": "qa",
    "testing": "qa",
    "perf": "perf",
    "performance": "perf",
    "optimize": "perf",
    "pm": "pm",
    "release": "pm",
    "product": "pm",
    "deps": "deps",
    "dependencies": "deps",
    "dep": "deps",
    "arch": "arch",
    "architecture": "arch",
    "ci": "ci",
    "devops": "ci",
    "pipeline": "ci",
    "workflow": "ci",
    "docs": "docs",
    "doc": "docs",
    "documentation": "docs",
    "frontend": "frontend",
    "ui": "frontend",
    "ux": "frontend",
    "css": "frontend",
    "backend": "backend",
    "api": "backend",
    "server": "backend",
    "config": "config",
    "infra": "config",
    "infrastructure": "config",
}

PROMPT_ROLES = {
    "security": (
        "Act as a Strict Security Auditor. Perform a deep security audit "
        "(OWASP Top 10, CWE patterns). Find real vulnerabilities with exact "
        "file/line references. Check for exposed secrets, injection vectors, "
        "broken auth, insecure deserialization, and misconfigurations."
    ),
    "review": (
        "Act as a Strict Code Reviewer. Analyze code quality using SOLID, DRY, "
        "and KISS principles. Point to exact lines that violate these principles. "
        "Evaluate naming, error handling, and separation of concerns."
    ),
    "qa": (
        "Act as a QA Engineer. Identify edge cases, missing test coverage, "
        "untested error paths, and potential regressions. Reference exact "
        "functions and lines that need tests."
    ),
    "perf": (
        "Act as a Performance Expert. Analyze algorithmic complexity, identify "
        "O(n^2) patterns, unnecessary allocations, N+1 queries, blocking I/O, "
        "and missed caching opportunities. Reference exact lines."
    ),
    "pm": (
        "Act as a Product Manager. Generate user-facing Release Notes with "
        "clear impact descriptions. Focus on what changed for the end user, "
        "not implementation details."
    ),
    "deps": (
        "Act as a Security & Dependency Auditor. Analyze all new or changed "
        "dependencies: check for known vulnerabilities (CVEs), license "
        "compatibility (MIT/Apache/GPL), package size impact, maintenance "
        "status, and whether each dep is actively maintained. Reference exact "
        "file and line where each dependency is added or changed."
    ),
    "arch": (
        "Act as a Software Architect. Review changes for architectural issues: "
        "violation of separation of concerns, tight coupling, wrong layer "
        "dependencies, anti-patterns (God object, spaghetti logic, magic "
        "numbers, circular dependencies). Reference exact files and lines."
    ),
    "ci": (
        "Act as a DevOps/CI Engineer. Review the CI/CD pipeline changes for "
        "correctness, security (token permissions, secret exposure), efficiency "
        "(caching, parallelism, job dependencies), and best practices. Check "
        "for overly broad permissions, missing timeout limits, and potential "
        "race conditions in workflows."
    ),
    "docs": (
        "Act as a Technical Writer. Review the documentation changes for "
        "completeness, accuracy, clarity, and consistency. Check that code "
        "examples are correct, links are valid, and the structure is logical. "
        "Note any missing sections or outdated information."
    ),
    "frontend": (
        "Act as a Frontend Engineer. Review the UI/UX changes for accessibility "
        "(a11y), responsive design, performance (bundle size, render blocking), "
        "XSS risks in DOM manipulation, proper event handling, and browser "
        "compatibility. Reference exact files and lines."
    ),
    "backend": (
        "Act as a Senior Backend Engineer. Review the changes for correctness, "
        "error handling, input validation, resource management (file handles, "
        "connections), concurrency safety, and API contract compliance. "
        "Reference exact files and lines."
    ),
    "config": (
        "Act as a Configuration & Infrastructure Reviewer. Analyze the config "
        "changes for correctness, security implications (exposed ports, "
        "permissive CORS, debug mode in production), consistency across "
        "environments, and potential breaking changes for existing deployments."
    ),
    "general": (
        "Act as a Senior Software Engineer reviewing a colleague's changes. "
        "Provide a thorough assessment covering: what was changed and why, "
        "whether the changes introduce any risks or bugs, code quality, "
        "and the overall scope and impact on the project."
    ),
}

SEVERITY_LABELS = {
    "critical": "severity: critical",
    "high": "severity: high",
    "elevated": "severity: elevated",
    "medium": "severity: medium",
    "moderate": "severity: moderate",
    "low": "severity: low",
    "informational": "severity: informational",
}

SEVERITY_GUIDE = """
Use the following severity scale. You have 7 levels - pick the one that best matches the ACTUAL impact:

CRITICAL - Production-breaking changes, security vulnerabilities (exposed secrets, SQL injection, XSS, CSRF, broken auth), data loss risks, or changes that could cause service outages.

HIGH - Significant logic changes affecting core functionality, new or modified API endpoints, permission and access control modifications, database schema changes, removal of important functionality, breaking changes to public interfaces.

ELEVATED - New substantial features or modules, large-scale refactors that change behavior across multiple files, integration with external services or APIs, changes to error handling or retry logic, modifications to data processing pipelines.

MEDIUM - New utility functions or helpers, workflow and CI/CD pipeline changes, configuration changes that affect runtime behavior, dependency version updates, adding new files with meaningful functionality, structural reorganization of existing code.

MODERATE - Minor feature additions, small behavioral changes, adding validation or input checks, improving logging or error messages, updating environment variables or build settings, adding new labels or issue templates.

LOW - Documentation updates (README, CONTRIBUTING, comments), cosmetic UI changes without behavior impact, code formatting or style fixes, renaming without behavior change, adding badges or metadata, updating .gitignore or editor configs.

INFORMATIONAL - Trivial changes: fixing typos, whitespace adjustments, comment rewording, version bumps in non-critical files, adding blank lines.

IMPORTANT: Do NOT default to LOW or INFORMATIONAL. Carefully evaluate the actual scope and impact. Most code changes that add or modify functionality should be MEDIUM or higher. Use the full range of the scale.
"""

OUTPUT_CONTRACT = """
Return only a raw JSON object with no markdown formatting. The JSON must have these exact keys:

"issue_title": string - include severity prefix like [CRITICAL], [HIGH], [ELEVATED], [MEDIUM], [MODERATE], [LOW], or [INFO] at the start,
"severity": string - one of: critical, high, elevated, medium, moderate, low, informational,
"issue_body": string - must include these sections:
  ## Problem
  (clear description with exact file paths and line numbers if known)

  ## Code Reference
  (the exact problematic code snippet or the key changed code)

  ## Suggested Fix
  (concrete code or steps to fix - or "No action required" for informational changes)

  ## Permalink
  (placeholder: PUT_PERMALINK_HERE - will be replaced automatically)

"labels": list of strings - standard GitHub labels plus the severity level,
"affected_file": string - the most relevant filename from the diff (or "" if unknown),
"affected_line": integer - approximate line number of the issue (or 1 if unknown),
"summary": string - 2-3 sentence plain-English summary for the PR comment

The issue_title, issue_body and summary MUST be written entirely in English.
"""

SYSTEM_PROMPT = (
    "You are a professional software auditor. Always return valid JSON only. "
    "No markdown, no explanation, just the JSON object."
)


@dataclass(frozen=True)
class ChangeSet:
    """Everything collected about the change under review."""

    dedup_key: str
    context: str
    files: tuple[str, ...]
    diff: str
    labels: tuple[str, ...]
    author: str
    commit_sha: str
    pull_request: PullRequest | None = None

    @property
    def head_sha(self) -> str:
        if self.pull_request is not None:
            return self.pull_request.head.sha
        return self.commit_sha


class ConfigurationError(RuntimeError):
    """Raised when the workflow is misconfigured."""


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"required environment variable {name} is not set")
    return value


def _optional_env(name: str) -> str:
    return os.environ.get(name, "").strip()


def read_settings() -> dict[str, Any]:
    """Reads and validates the workflow environment."""
    # An empty allow list is normal for pull requests opened from forks, where
    # secrets are not exposed. Callers treat it as "nothing to analyse".
    allowed_users = {
        login.strip().lower()
        for login in _optional_env("ALLOWED_USER").split(",")
        if login.strip()
    }

    event_name = _require_env("EVENT_NAME")
    if event_name not in {"push", "pull_request"}:
        raise ConfigurationError(f"unsupported EVENT_NAME: {event_name}")

    settings: dict[str, Any] = {
        "token": _require_env("GITHUB_TOKEN"),
        "repository": _require_env("REPOSITORY"),
        "event_name": event_name,
        "allowed_users": allowed_users,
        "actor": _optional_env("GITHUB_ACTOR").lower(),
        "models_token": _optional_env("GH_MODELS_TOKEN"),
    }

    if event_name == "push":
        settings["commit_sha"] = _require_env("COMMIT_SHA")
    else:
        raw_number = _require_env("PR_NUMBER")
        if not raw_number.isdigit():
            raise ConfigurationError(f"PR_NUMBER must be numeric, got {raw_number!r}")
        settings["pr_number"] = int(raw_number)

    return settings


def _flatten_patch(patch: str | None) -> str:
    """Normalises a diff patch; binary and renamed files have no patch."""
    return patch if isinstance(patch, str) else "(no textual diff available)"


def _collect_diff(files: Iterable[Any], limit: int) -> tuple[tuple[str, ...], str]:
    names: list[str] = []
    chunks: list[str] = []
    size = 0

    for file in files:
        names.append(file.filename)
        chunk = f"File: {file.filename}\nPatch:\n{_flatten_patch(file.patch)}\n\n"
        chunks.append(chunk)
        size += len(chunk)

        if size > limit:
            chunks.append("[Diff truncated: size limit reached]\n")
            break

    return tuple(names), "".join(chunks)


def _extract_labels(text: str) -> tuple[str, ...]:
    return tuple(match.lower() for match in re.findall(r"\[(.*?)\]", text))


def collect_push_change(repo: Repository, settings: Mapping[str, Any]) -> ChangeSet | None:
    commit = repo.get_commit(settings["commit_sha"])
    message = commit.commit.message or ""

    if settings["actor"] not in settings["allowed_users"]:
        print(f"Actor {settings['actor']!r} is not in ALLOWED_USER; nothing to do.")
        return None

    pull_request_match = re.search(r"\(#(\d+)\)", message)
    dedup_key = (
        f"PR #{pull_request_match.group(1)}"
        if pull_request_match
        else f"commit:{settings['commit_sha'][:7]}"
    )

    files, diff = _collect_diff(commit.files, PUSH_DIFF_LIMIT)
    return ChangeSet(
        dedup_key=dedup_key,
        context=f"Commit Message: {message}",
        files=files,
        diff=diff,
        labels=_extract_labels(message),
        author=settings["actor"],
        commit_sha=settings["commit_sha"],
    )


def collect_pull_request_change(
    repo: Repository, settings: Mapping[str, Any]
) -> ChangeSet | None:
    pull_request = repo.get_pull(settings["pr_number"])
    author = (pull_request.user.login or "").lower()

    if author not in settings["allowed_users"]:
        print(f"PR author {author!r} is not in ALLOWED_USER; nothing to do.")
        return None

    files, diff = _collect_diff(pull_request.get_files(), PULL_REQUEST_DIFF_LIMIT)
    return ChangeSet(
        dedup_key=f"PR #{settings['pr_number']}",
        context=f"PR Title: {pull_request.title}\nPR Body: {pull_request.body or ''}",
        files=files,
        diff=diff,
        labels=tuple(label.name.lower() for label in pull_request.labels),
        author=author,
        commit_sha=pull_request.head.sha,
        pull_request=pull_request,
    )


def detect_change_type(files: Sequence[str], diff: str) -> str:
    """Infers the review role from changed paths when no label is present."""
    paths = [path.lower() for path in files]
    haystack = diff.lower()

    def any_path(*needles: str) -> bool:
        return any(needle in path for path in paths for needle in needles)

    if any(keyword in haystack for keyword in (
        "secret", "token", "password", "api_key", "apikey", "auth",
        "credential", "private_key", "access_key", "bearer",
        "vulnerability", "cve-", "injection", "xss", "csrf",
    )) or any_path("security", "auth", ".env", "secret"):
        return "security"

    if any_path(
        "requirements", "package.json", "package-lock", "pipfile",
        "poetry.lock", "cargo.toml", "go.sum", "gemfile",
        "dependabot", "renovate",
    ):
        return "deps"

    if any_path(
        ".github/workflows/", "jenkinsfile", ".gitlab-ci",
        ".circleci", "dockerfile", "docker-compose", ".github/actions/",
    ):
        return "ci"

    if paths and all(
        any(keyword in path for keyword in (
            "readme", "contributing", "changelog", "license",
            "docs/", "doc/", ".md", ".rst", ".txt",
        ))
        for path in paths
    ):
        return "docs"

    if any_path(
        ".html", ".css", ".jsx", ".tsx", ".vue", ".svelte",
        "frontend/", "public/", "static/", "assets/",
    ) or any(keyword in haystack for keyword in (
        "classname", "style=", "onclick", "addeventlistener",
        "document.get", "innerhtml", "appendchild",
    )):
        return "frontend"

    if any_path(".py", ".go", ".java", ".rb", ".rs", ".php", "api/", "server/", "backend/", "lib/", "src/"):
        return "backend"

    if any_path(".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".json", ".env"):
        return "config"

    return "general"


def select_role(labels: Sequence[str], files: Sequence[str], diff: str) -> str:
    for label in labels:
        role = LABEL_TO_ROLE.get(label)
        if role:
            return role

    role = detect_change_type(files, diff)
    print(f"Auto-detected change type: {role}")
    return role


def build_prompt(change: ChangeSet, role: str) -> str:
    return "\n".join(
        (
            PROMPT_ROLES.get(role, PROMPT_ROLES["general"]),
            "",
            "Do NOT invent problems that do not exist in the diff. "
            "Base your analysis strictly on what you see.",
            SEVERITY_GUIDE,
            f"Context: {change.context}",
            f"Changed files: {', '.join(change.files)}",
            f"Changes: {change.diff}",
            OUTPUT_CONTRACT,
        )
    )


_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def parse_model_response(raw: str) -> dict[str, Any]:
    """Extracts the JSON payload from a model reply.

    The model is instructed to answer with bare JSON, but small local models
    occasionally wrap the object in a fenced block, so the fence is stripped and
    parsing failures propagate with context.
    """
    cleaned = _JSON_FENCE_RE.sub("", raw.strip()).strip()
    payload = json.loads(cleaned)

    if not isinstance(payload, dict):
        raise ValueError("model response is not a JSON object")
    for key in ("issue_title", "issue_body"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            raise ValueError(f"model response is missing a usable {key!r}")

    return payload


def call_model(prompt: str, token: str) -> dict[str, Any] | None:
    """Queries the model with bounded retries; returns ``None`` when it gives up."""
    if not token:
        print("GH_MODELS_TOKEN is not set; skipping analysis.")
        return None

    payload = {
        "model": MODEL_NAME,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    for attempt in range(1, MODEL_RETRIES + 1):
        try:
            response = requests.post(
                MODEL_ENDPOINT,
                headers=headers,
                json=payload,
                timeout=MODEL_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return parse_model_response(content)
        except (requests.RequestException, KeyError, IndexError, ValueError) as error:
            print(f"Model attempt {attempt}/{MODEL_RETRIES} failed: {error}")
            if attempt < MODEL_RETRIES:
                time.sleep(MODEL_RETRY_DELAY_SECONDS * attempt)

    return None


def issue_already_exists(repo: Repository, dedup_key: str) -> bool:
    """Checks for an existing issue carrying this change's marker.

    ``dedup_key`` is embedded in every generated body, so a single scan of open
    issues is enough; closed issues are kept as history.
    """
    for issue in repo.get_issues(state="all"):
        if issue.pull_request is not None:
            continue
        if dedup_key in (issue.body or ""):
            print(f"Issue for {dedup_key} already exists (#{issue.number}); skipping.")
            return True
    return False


def build_permalink(repository: str, sha: str, filename: str, line: int) -> str:
    return f"https://github.com/{repository}/blob/{sha}/{filename}#L{line}"


def normalise_affected_line(value: Any) -> int:
    try:
        line = int(value)
    except (TypeError, ValueError):
        return 1
    return max(line, 1)


def build_issue_body(change: ChangeSet, payload: Mapping[str, Any], repository: str, role: str) -> str:
    affected_file = str(payload.get("affected_file") or "").strip()
    if affected_file:
        permalink = build_permalink(
            repository, change.head_sha, affected_file, normalise_affected_line(payload.get("affected_line"))
        )
    else:
        permalink = "_No specific file identified_"

    body = str(payload["issue_body"]).replace("PUT_PERMALINK_HERE", permalink)
    footer = (
        f"\n\n---\n*Generated from {change.dedup_key} | "
        f"Auto-detected role: `{role}` | Processed by actor: {change.author}*"
    )

    # Keep the marker (and therefore deduplication) intact even when the body has
    # to be cut down to GitHub's size limit.
    return body[: MAX_BODY_LENGTH - len(footer)] + footer


def collect_labels(payload: Mapping[str, Any]) -> list[str]:
    severity = str(payload.get("severity", "medium")).lower()
    labels = {SEVERITY_LABELS.get(severity, SEVERITY_LABELS["medium"])}

    for label in payload.get("labels") or []:
        if isinstance(label, str) and label.strip():
            labels.add(label.strip())

    return sorted(labels)


def publish(repo: Repository, change: ChangeSet, payload: Mapping[str, Any], role: str, repository: str) -> None:
    issue = repo.create_issue(
        title=str(payload["issue_title"])[:250],
        body=build_issue_body(change, payload, repository, role),
        labels=collect_labels(payload),
    )
    print(f"Created issue #{issue.number}: {issue.title}")

    summary = str(payload.get("summary") or "").strip()
    if change.pull_request is None or not summary:
        return

    comment = (
        f"### Automated Review Summary\n\n{summary}\n\n"
        f"**Severity:** `{str(payload.get('severity', 'medium')).upper()}` | "
        f"**Role:** `{role}`\n\nFull details: #{issue.number}"
    )
    change.pull_request.create_issue_comment(comment)
    print(f"Posted summary comment on PR #{change.pull_request.number}")


def main() -> int:
    try:
        settings = read_settings()
    except ConfigurationError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 1

    if not settings["allowed_users"]:
        print("ALLOWED_USER is empty; analysis is disabled for this run.")
        return 0

    github = Github(auth=Auth.Token(settings["token"]))
    repo = github.get_repo(settings["repository"])

    collector = (
        collect_push_change if settings["event_name"] == "push" else collect_pull_request_change
    )
    change = collector(repo, settings)
    if change is None:
        return 0

    if len(change.diff.strip()) < MIN_DIFF_LENGTH:
        print("Diff is too small to analyse; skipping.")
        return 0

    # Deduplicate before spending a model call, not after.
    if issue_already_exists(repo, change.dedup_key):
        return 0

    role = select_role(change.labels, change.files, change.diff)
    payload = call_model(build_prompt(change, role), settings["models_token"])
    if payload is None:
        print("No analysis produced; exiting without changes.")
        return 0

    try:
        publish(repo, change, payload, role, settings["repository"])
    except GithubException as error:
        print(f"Failed to publish the analysis: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
