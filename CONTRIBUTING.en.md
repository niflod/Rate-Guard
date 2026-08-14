# Contributing to rate-guard

> Languages: [Português](./CONTRIBUTING.md) • [English](./CONTRIBUTING.en.md)

Thanks for your interest in contributing! This document describes the process.

## Environment setup

Prerequisites:

- Node.js 20+ (22 LTS recommended).
- npm 10+.

Steps:

```bash
# Clone the repo
git clone https://github.com/YOUR_GITHUB_USERNAME/rate-guard.git
cd rate-guard

# Install deps
npm install

# Verify everything is green:
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # node --test with tsx
```

If any command fails after a clean install, that's a bug — open an issue.

## Pull Request process

1. Open an issue first for large changes (>50 lines of diff or that alter
   the public API). Skip for trivial fixes.
2. Fork and create a feature branch: `git checkout -b feat/my-feature`.
3. Write code following the conventions already present in the project
   (TypeScript strict, ESM, `import type` for types, no tabs).
4. **Add or update tests.** Coverage must remain stable or grow — every PR
   that adds behavior without tests will be rejected.
5. Run `npm run typecheck && npm run lint && npm test` locally.
6. Commits in [Conventional Commits](https://www.conventionalcommits.org/) style:
   - `feat:` new feature
   - `fix:` bug fix
   - `docs:` documentation only
   - `refactor:` refactoring with no behavior change
   - `test:` test additions/fixes
   - `chore:` non-functional tasks
7. Open the PR referencing the issue (e.g. `Closes #42`).

## PR checklist

Before opening, make sure that:

- [ ] `npm run typecheck` passes with no errors.
- [ ] `npm run lint` passes with no errors.
- [ ] `npm test` passes all tests.
- [ ] New behavior has new tests.
- [ ] Public documentation (README, `docs/`) updated when applicable.
- [ ] CHANGELOG.md updated in `[Unreleased]` describing the change.
- [ ] No `console.log` in `src/` (the core must remain silent;
      `console.*` is only allowed in `examples/`).

## Code style

- Indentation: 2 spaces.
- Strings: double quotes (`"..."`).
- No optional semicolons — follow the file's style (currently uses
  trailing semicolons).
- `import type` for types (`verbatimModuleSyntax: true`).
- No `any` without justification — prefer `unknown` or a generic type.
- In new files, comment only the "why", not the "what".

## Adding a new feature

Before implementing, consider:

1. Does it fit the scope of `rate-guard`? (anti-429 / queue / rate-limit)
2. Can it be expressed without unnecessarily enlarging the public API?
3. Does it have an opt-in mode (default: off / safe) so it doesn't break
   existing consumers?

If yes to all, go ahead. If not, open an issue for discussion.

## Releases

We follow SemVer. Categories:

- **MAJOR**: public API break.
- **MINOR**: new feature compatible with previous versions.
- **PATCH**: compatible bug fix.

We keep `CHANGELOG.md` in `[Unreleased]` and move it to a new
`[X.Y.Z] - YYYY-MM-DD` section on release.

## Code of Conduct

Participate by following the [Code of Conduct](./CODE_OF_CONDUCT.md). Be
respectful, constructive, and inclusive.
