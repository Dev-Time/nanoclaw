# Implementation Plan - Manual Memory Trigger

This plan adds a manual `/memo` slash command to trigger background memory extraction on demand.

## Objective
- Provide a dedicated command for users to force a memory curation sweep.
- Confirm the action to the user via chat.

## Key Files & Context
- `src/session-commands.ts`: Handles slash command detection and execution.
- `src/index.ts`: Orchestrates the message loop.

## Implementation Steps
### 1. Update Command Detection
- Modify `extractSessionCommand` regex in `src/session-commands.ts` to include `memo`.
- Update `handleSessionCommand` to recognize `/memo`.

### 2. Implement `/memo` Logic
- When `/memo` is detected:
  - Send a "🧠 Triggering manual memory extraction..." message.
  - Call `deps.runBackgroundMemoryExtraction()`.
  - Advance the cursor past the command.

## Verification
- Send `/memo` in a chat.
- Verify the "🧠 Triggering..." message appears.
- Check logs to confirm `runBackgroundMemoryExtraction` was triggered.
- Verify a "🧠" nudge appears if new findings are discovered.
