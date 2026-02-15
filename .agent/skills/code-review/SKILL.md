---
name: code-review
description: Systematic code review and refactoring of a TypeScript/JavaScript codebase. Use when asked to audit, review, refactor, or improve code quality.
---

# Code Review & Refactoring Skill

A structured process for discovering, prioritizing, and fixing code quality issues across a codebase.

## Phase 1: Discovery (Scan)

Run these scans in parallel to build a full picture before changing anything.

### 1A. Duplication Scan
Look for repeated patterns across the codebase:
```
grep -rn "pattern" src/ --include="*.ts" | head -30
```
Common duplications:
- Client/service instantiation boilerplate (extract to `shared.ts`)
- Error handling patterns like `error instanceof Error ? error.message : error` (extract to `errorMessage()` utility)
- Date/time parsing logic
- Config loading

### 1B. Type Safety Scan
Search for type-safety escapes:
```
grep -rn "as any\|as unknown\|: any\|@ts-ignore\|@ts-expect-error" src/ --include="*.ts"
```
Each hit is a potential bug. Categorize:
- **Fixable now**: `as any` that has an obvious correct type
- **Needs interface**: cast needed because response type isn't defined
- **Legitimate**: rare cases where `any` is the only option (log with comment)

### 1C. Dead Code & Bug Scan
Look for:
- Functions that always return the same value (computed values that aren't really computed)
- Unused imports, private fields, unreachable branches
- Variables that are written but never read
- `catch` blocks that swallow errors silently

### 1D. Structural Scan
Identify monolith files:
```
wc -l src/**/*.ts | sort -rn | head -10
```
Files over 300 lines are candidates for decomposition. Look for:
- God classes with unrelated responsibilities
- Single files registering many handlers/routes/tools
- Mixed concerns (business logic + I/O + formatting)

### 1E. Hardcoded Values
```
grep -rn "hardcoded\|TODO\|FIXME\|'0.1.0'\|localhost" src/ --include="*.ts"
```
Look for magic strings, hardcoded versions, region IDs, URLs that should be configurable.

## Phase 2: Prioritize

> [!IMPORTANT]
> Never start fixing before completing discovery and prioritization. The priority order matters.

Rank findings by **impact × effort**:

| Priority | Category | Why First |
|----------|----------|-----------|
| 1 | **Code Duplication** | Every other fix benefits from shared utilities existing |
| 2 | **Type Safety** | Catches bugs, makes subsequent refactoring safer |
| 3 | **Monolith Decomposition** | Largest structural improvement, enables parallel work |
| 4 | **Dead Code / Bugs** | Reduces noise, fixes real defects |
| 5 | **Hardcoded Values** | Quick wins, reduces config drift |
| 6+ | **Abstractions / Tests / Docs** | Lower priority, often separate efforts |

Create a task checklist with `[ ]` items grouped by priority. Get user approval on this plan before proceeding.

## Phase 3: Implement

Work through priorities **in order**. For each fix:

### Workflow Per Fix
1. **Edit** — Make the minimal change; prefer `replace_file_content` for single edits
2. **Build** — `npm run build` (or equivalent) — must pass before moving on
3. **Test** — `npm test` — no regressions
4. **Lint** — `npm run lint` — no new errors
5. **Format** — `npm run format:check` → fix with `--write` if needed

### Commit Strategy
Group related changes into logical commits — one per priority or sub-priority:
```bash
git add -A && git commit -m "refactor: <category>

- bullet point per change
- mention files affected"
```

### Common Refactoring Patterns

#### Extracting Shared Utilities
```typescript
// Before: duplicated in 7 files
const client = new FooClient({ ...getConfig() });

// After: src/commands/shared.ts
export function createClient(): FooClient {
    const config = getConfig();
    return new FooClient({ ...config });
}
```

#### Monolith Decomposition
Split a large file into **registrar functions** that each register one category:
```typescript
// src/handlers/auth.ts
export function registerAuthHandlers(server: Server, client: Client): void {
    server.register('login', ...);
    server.register('logout', ...);
}

// src/main.ts (thin orchestrator)
registerAuthHandlers(server, client);
registerUserHandlers(server, client);
```

Key rules:
- Each module is a **pure function** `(server, deps) → void`
- Zero coupling between modules
- Barrel export via `index.ts`

#### Error Handling Standardization
```typescript
// src/utils/errors.ts
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
```
Then search-and-replace all inline patterns across the codebase.

#### Type Safety: AxiosError
```typescript
// Before: hand-casting
if (e instanceof Error && 'response' in e) {
    const axiosErr = e as { response?: { status?: number } };
}

// After: proper typing
import { AxiosError } from 'axios';
if (e instanceof AxiosError && e.response) {
    // e.response is fully typed
}
```

## Phase 4: Verify & Report

After all fixes are committed:

1. Run the full check suite:
   ```bash
   npm run build && npm test && npm run lint && npm run format:check
   ```

2. Review the git log:
   ```bash
   git log --oneline --stat
   ```

3. Create a walkthrough summarizing:
   - What changed and why
   - Verification results
   - Items explicitly deferred (with rationale)

## Anti-Patterns to Avoid

| Don't | Do Instead |
|-------|------------|
| Fix everything in one giant commit | One commit per priority group |
| Create abstractions speculatively | Extract only when 3+ concrete duplicates exist |
| Add base classes for 2 subclasses | Wait until the pattern is clear across 4+ |
| Rewrite working code for style | Focus on correctness, safety, and structure |
| Cascade incremental fixes to a broken file | Rewrite the file cleanly if edits compound errors |
| Skip the build step after edit | Always build immediately — catch import path errors early |
