# Fix Container Leaks and Memory Extraction Task Queueing

## Objective
1. Ensure the container's stdin is closed even if the GroupQueue state indicates it's not "active" (which happens when background tasks bypass `runForGroup`).
2. Route all background memory extraction runs through `GroupQueue.enqueueTask` to respect concurrency limits and maintain accurate state tracking.
3. Fix the `clearSession` SQLite deletion to correctly use the `sessKey` so that alias-specific sessions are deleted from the database.

## Implementation Steps

### 1. `src/group-queue.ts`
- Modify `closeStdin` to rely solely on the presence of `state.ipcFolder` rather than requiring `state.active`. Background processes might be running outside of the standard `runForGroup` state loop.

### 2. `src/index.ts`
- In `startMessageLoop`'s dependencies for `handleSessionCommand`:
  - Change `clearSession` from `deleteSession(group.folder)` to `deleteSession(sessKey)`.
  - Change `runBackgroundMemoryExtraction` to use `queue.enqueueTask(slotKey, 'memory-extraction', () => ... )`.
- In `startMessageLoop`'s `idleTimer`:
  - Change `runBackgroundMemoryExtraction` to use `queue.enqueueTask(slotKey, 'memory-extraction', () => ... )`.

### 3. `src/task-scheduler.ts`
- Verify any usage of `runBackgroundMemoryExtraction` here uses the queue (already removed in previous fix, but double-check).

## Verification
- Run `npm run build` and `npm test` to ensure there are no TypeScript errors.
- Confirm `closeStdin` can trigger even when `state.active` is false.
