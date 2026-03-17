# GitHub Copilot instructions for contributors and AI agents

Purpose
- Give AI coding agents immediate, actionable context for working in this repo (`on`).

Repository snapshot
- Name: `on` (owner: `cloud-cli`).
- Default branch: `main`.
- Current repo contents: minimal — top-level `README.md` describing this as "General-purpose automation" and no build/test config detected.

Big picture
- This is a small automation utilities repository. Expect standalone scripts or small modules rather than a monolithic app.
- Typical changes are: add a small script, update `README.md` with usage, or add minimal cross-platform sh/python helpers.

Developer workflows (discoverable)
- No CI or build files present; there is no detected package manager or test runner. Changes should be small and self-contained.
- Branching/PR: target `main`. Use descriptive feature branches (`feature/short-desc` or `fix/short-desc`).

Project conventions (explicit, discoverable)
- Place new executable scripts under a `bin/` or `scripts/` folder at repo root.
- Scripts should include a shebang (e.g., `#!/usr/bin/env bash` or `#!/usr/bin/env python3`) and be made executable (`chmod +x`).
- Keep scripts single-purpose and small: prefer <200 lines for simple utilities.
- Document usage in `README.md` when adding a new script: include example command and expected output.

Examples (use when making edits)
- Add a Bash helper: `bin/do-thing.sh` with a shebang, minimal arg parsing, and a short `Usage:` section appended to `README.md`.
- Add a Python helper: `scripts/convert.py` with `if __name__ == '__main__':` entry and a short docstring explaining input/output.

PR guidance for AI agents
- Keep diffs small and focused (one logical change per PR).
- Update `README.md` with a one-paragraph description and a usage example for any new script.
- If adding a script that requires external tools, note those in `README.md` and ask the repo owner before adding complex dependencies.

When to ask the human
- The repo lacks tests, CI, and explicit coding standards — ask the user for preferred language, dependency management, or testing approach before adding larger changes.
- Ask for clarification if a requested feature touches system-level behavior (network, shell permissions, cron, etc.).

Notes for maintainers
- If you (human) want richer automation (CI, packaging, tests), indicate preferred tooling (GitHub Actions, Makefile, pytest, npm, etc.).

Quick checklist for generated changes
- Add script file under `bin/` or `scripts/`.
- Include shebang and make executable.
- Update `README.md` with usage example.
- Keep PRs small; target `main` and use descriptive branch names.

If anything here is incorrect or you want a different convention, tell me which parts to update.