# Final fix wave report

**Base:** `8ee666b`  
**Date:** 2026-08-30

## Findings addressed (Important)

### 1. Remote timeout overridden by Cursor timeout
- **Fix:** `resolveReviewTimeoutMs(config)` in `src/review-job-service.js` — `ai.provider === 'remote'` → `ai.remote.timeoutMs`, otherwise `cursor.timeoutMs`.
- **Tests:** `provider=remote uses ai.remote.timeoutMs not cursor.timeoutMs`; `provider=cursor uses cursor.timeoutMs`.

### 2. PF-009 primary risk bump lacks audit / legality re-check
- **Fix:** On primary risk raise, push PF-009 `CORRECTED` decision (简体中文 reason); after merge, re-run `applyPf006` / `applyPf007` / `applyPf008` on primary so caps are not undone.
- **Tests:** primary PF-009 audit on duplicate merge; REQUIREMENT_MISMATCH merge cannot leave primary above PF-008 cap.

### 3. Unexpected failures become INVALID_REQUEST
- **Fix:** `toErrorEntry` maps non-`AppError` → `ErrorCodes.INTERNAL_ERROR` with message `服务器内部错误` (no raw internals).
- **Tests:** unexpected provider throw → FAILED / `INTERNAL_ERROR` / generic Chinese, no leaked message.

## Parked (not fixed)
Unbounded jobs Map, body size limit, allowedRoots realpath, Abort→TIMEOUT, SKIPPED re-hash, etc.

## Verification
```
npm test
# 120 tests: 118 pass, 0 fail, 2 skipped
```

## Commits
- `6398ef3` — fix: route provider timeouts, PF-009 primary audit, INTERNAL_ERROR mapping
