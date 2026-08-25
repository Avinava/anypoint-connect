---
name: code-review
description: Review or refactor the anypoint-connect TypeScript codebase, documentation, examples, and release changes. Use for correctness, security, safety, maintainability, or release-readiness audits in this repository.
---

# Review anypoint-connect

Review against the repository's observable behavior and safety contracts. Use the user's requested scope;
ask only when a missing decision would materially change the result.

## Establish context

- Read the relevant implementation, tests, documentation, and current diff before drawing conclusions.
- Inspect `package.json`, `mkdocs.yml`, and the applicable workflows when compatibility or release behavior
  is in scope.
- Preserve unrelated working-tree changes. Use `rg` or `rg --files` for discovery.
- Report reviews evidence-first with file and line references. Implement changes only when requested.

## Project invariants

Treat a violation of these contracts as a correctness or security issue:

- Authentication uses the user Authorization Code flow with `full offline_access`; Client ID and Secret
  alone do not create an authorized session or provide supported headless CI authentication.
- Authorization callbacks must be bound to a one-time state and an HTTP loopback host. Callback HTML must
  escape dynamic values and must not leak codes, state, secrets, or provider details to another origin.
- Client Secrets must not appear in command examples, logs, fixtures, screenshots, or realistic-looking
  literals. Interactive secret input stays masked. Profile configuration is user-restricted and tokens
  remain encrypted at rest.
- Credential precedence is process environment, active profile, then legacy project `.env`. Changing
  credential sources does not replace browser authorization.
- MCP mutations preview by default and require explicit confirmation. Production and deletion safeguards
  must remain bound to the reviewed target. Direct library clients do not inherit CLI/MCP confirmation
  gates.
- Operational CLI commands use the resolved active profile; only commands that actually declare
  `--profile` may be documented with it.
- Examples use synthetic application, profile, organization, and environment names. Package pins in
  README, docs, and examples match `package.json`.

## Review approach

Choose checks that fit the change rather than following a fixed phase sequence:

- Trace input through validation, API calls, persistence, output, and error handling for behavioral work.
- Compare CLI, MCP, and library behavior when they share a client or safety primitive.
- Look for unsafe broad matching, stale cached reads, incomplete update payloads, swallowed errors,
  misleading dry-run language, unescaped HTML, and secrets in observable output.
- Prefer existing shared modules over parallel implementations, but extract abstractions only when they
  remove concrete duplication or protect an invariant.
- Add regression tests for behavior and failure modes, not wording or implementation details.
- For documentation changes, verify links, command syntax, authentication claims, release pins, mobile
  layout, and the distinction between previews and immediately applied operations.

## Verification

Run the checks proportional to the change. A complete release-readiness pass is:

```bash
npm run build
npm test
npm run lint
npm run format:check
npm run docs:check
mkdocs build --strict
npm run audit:prod
git diff --check
```

For a release, also confirm that `package.json`, both root package-lock versions, documentation/example
pins, and the newest changelog heading agree. Inspect the final commit before creating an annotated tag;
never move or replace an existing release tag silently.
