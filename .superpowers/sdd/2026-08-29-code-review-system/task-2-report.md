# Task 2 Report: 路径安全

## Summary

Implemented shared path security utilities (`resolveRealPath`, `assertInsideAllowedRoots`, `toPosixRelative`) with realpath-based allowed-root enforcement, following TDD RED→GREEN cycle.

## TDD Evidence

### RED — tests before implementation

**Command:**
```
node --test tests/path-security.test.js
```

**Output:**
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\src\shared\path-security.js' imported from ...\tests\path-security.test.js
✖ tests\path-security.test.js (67.2614ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Failure reason matches brief expectation: module not found.

### GREEN — after implementation

**Command:**
```
node --test tests/path-security.test.js
```

**Output:**
```
✔ assertInsideAllowedRoots allows a realpath under an allowed root (6.7692ms)
✔ assertInsideAllowedRoots rejects a sibling that only shares a string prefix (3.2746ms)
✔ toPosixRelative returns forward-slash paths (4.1188ms)
﹣ symlink whose realpath leaves allowedRoots is PATH_SYMLINK_ESCAPE (2.8871ms) # symlink not permitted on this machine
ℹ tests 4
ℹ pass 3
ℹ fail 0
ℹ skipped 1
```

**Full suite (no regressions):**
```
node --test tests/**/*.test.js
ℹ tests 6
ℹ pass 5
ℹ fail 0
ℹ skipped 1
```

## Files Changed

| File | Action |
|------|--------|
| `src/shared/path-security.js` | Created — core path security module |
| `tests/path-security.test.js` | Created — 4 tests (3 pass, 1 conditional skip) |
| `tests/helpers/temp-workspace.js` | Created — `makeTempDir` helper |

## Implementation Notes

- `resolveRealPath`: wraps `fs.realpath`, throws `AppError(PATH_NOT_FOUND)` on failure.
- `assertInsideAllowedRoots`: checks realpath against allowed roots using normalized comparison (case-insensitive on Windows); distinguishes `PATH_SYMLINK_ESCAPE` (lexical inside but realpath outside) from `PATH_OUTSIDE_ALLOWED_ROOT`; rejects empty `allowedRoots` with `INVALID_REQUEST`.
- `toPosixRelative`: converts `path.relative` result to forward-slash form.
- `normalizeForCompare`: lowercases on win32 to avoid case-sensitivity false negatives.

## Self-Review

| Check | Result |
|-------|--------|
| Matches brief API surface | Yes — three exported functions with correct signatures |
| Uses existing `AppError` / `ErrorCodes` | Yes |
| Prefix-prefix sibling rejection | Tested and passing (`work` vs `work-evil`) |
| Windows path normalization | Implemented via `normalizeForCompare` |
| Symlink test skip on no permission | Correct — uses `t.skip`, not fake pass |
| Minimal scope | No unrelated changes |
| TDD followed | Tests written and verified RED before implementation |

## Concerns

1. **Symlink test skipped on this machine** — Windows without symlink creation privilege; test correctly skips via `t.skip`. Symlink escape logic (`PATH_SYMLINK_ESCAPE`) is implemented but not exercised here; it requires callers to pass the original lexical path as the third argument to `assertInsideAllowedRoots`. The symlink test accepts either `PATH_SYMLINK_ESCAPE` or `PATH_OUTSIDE_ALLOWED_ROOT` when only realpath is passed.

2. **`npm test` script pre-existing issue** — `node --test tests` fails on Windows (treats `tests` as a module path). Unrelated to this task; `node --test tests/**/*.test.js` works.

## Commit

```
c9d5368 feat: add realpath-based allowedRoots path security
```
