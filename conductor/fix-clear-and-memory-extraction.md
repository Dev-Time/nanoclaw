# Fix `/clear` and Adjust Memory Extraction Triggers

## Objective
1. Ensure the `/clear` command gracefully shuts down the active container (closing stdin) so that the agent doesn't hold onto old conversational state across the context reset.
2. Adjust memory extraction triggers so that `runBackgroundMemoryExtraction` is only triggered explicitly via `/memo` or implicitly "at night" (via the idle timeout). It should no longer trigger during `/clear`, `/compact`, or autocompaction.

## Key Files & Context
- `src/session-commands.ts`: Handles session commands (`/clear`, `/compact`, `/memo`).
- `src/session-commands.test.ts`: Tests for session commands.
- `src/index.ts`: Handles normal message orchestration and autocompaction.
- `src/task-scheduler.ts`: Handles scheduled tasks and their autocompaction.

## Implementation Steps

### 1. Update `src/session-commands.ts`
- In the `/clear` command block, add `deps.closeStdin();` immediately before or after `deps.clearSession();`.
- In the `/clear` command block, remove the `await deps.runBackgroundMemoryExtraction();` call.
- In the `preCompactMsgs.length > 0` block (used by `/compact`), remove the `await deps.runBackgroundMemoryExtraction();` call.

### 2. Update `src/index.ts`
- In the `wrappedOnOutput` function (around line 668), locate the `if (output.autocompacted) { ... }` block that triggers `runBackgroundMemoryExtraction`. Remove this block entirely.

### 3. Update `src/task-scheduler.ts`
- In the `onOutput` callback for `runContainerAgent` (around line 204), locate the `if (streamedOutput.autocompacted) { ... }` block that triggers `runBackgroundMemoryExtraction`. Remove this block entirely.

### 4. Update `src/session-commands.test.ts`
- In the test suite for `/compact` (where `missedMessages` includes messages before the command), remove the assertion `expect(deps.runBackgroundMemoryExtraction).toHaveBeenCalled();`.
- In the test suite for `/clear`, remove the assertion `expect(deps.runBackgroundMemoryExtraction).toHaveBeenCalled();` (or change it to `.not.toHaveBeenCalled()`), and add an assertion for `expect(deps.closeStdin).toHaveBeenCalledTimes(1);`.

## Verification & Testing
- Run `npm test -- src/session-commands.test.ts` to verify the test suite passes with the updated assertions.
- Verify `npm run build` succeeds.
