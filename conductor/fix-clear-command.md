# Implementation Plan: Fix /clear slash command

## Objective
The `/clear` slash command is failing with an "Unknown skill: clear" error. The host orchestrator (`src/index.ts`, `src/session-commands.ts`) is correctly identifying the command, but instead of executing the reset natively, it is forwarding the literal string `"/clear"` to the agent container (`src/session-commands.ts`, lines 259-270). The Claude Agent SDK inside the container interprets the `/clear` string as a built-in skill or command. Since the SDK doesn't natively support a `clear` skill, it throws "Unknown skill: clear".

We must intercept the `/clear` command on the host side, bypass the container agent entirely for this command, and reset the conversation by deleting the session from the host's SQLite database. We'll also remove the broken `/clear` logic from the container's `agent-runner`.

## Key Files & Context
- `src/session-commands.ts`: The orchestrator handles session commands here. We need to add logic to handle `/clear` instantly by calling a new dependency instead of forwarding it.
- `src/index.ts`: The main entry point. We need to inject a `clearSession: () => void` dependency into the `handleSessionCommand` arguments that maps to `deleteSession(group.folder)`.
- `src/session-commands.test.ts`: Regression tests need to be updated to expect `deps.clearSession` to be called instead of `deps.runAgent` when parsing `/clear`.
- `container/agent-runner/src/index.ts`: The container runner has logic that attempts to handle `/clear` and `/compact`. The `/clear` logic is failing and should be removed. We'll leave `/compact` intact as it relies on the SDK's built-in compaction.

## Implementation Steps
1. **Update `SessionCommandDeps` interface:**
   - In `src/session-commands.ts`, add a `clearSession: () => void` method to `SessionCommandDeps`.

2. **Update `handleSessionCommand` logic:**
   - In `src/session-commands.ts`, modify the logic around line 250.
   - If `command === '/clear'`, do NOT call `deps.runAgent(command, ...)` and do NOT call `deps.setTyping(true)`.
   - Instead, simply execute `deps.clearSession()`.
   - Send the success message directly: `await deps.sendMessage('Conversation cleared.');`
   - Advance the cursor and return success.

3. **Inject dependency in `src/index.ts`:**
   - In `src/index.ts`, inside the `cmdResult = await handleSessionCommand({ ... })` call (around line 310), add the new dependency:
   ```typescript
   clearSession: () => {
     delete sessions[sessKey];
     deleteSession(group.folder);
   },
   ```

4. **Clean up `agent-runner`:**
   - In `container/agent-runner/src/index.ts`, remove `/clear` from `KNOWN_SESSION_COMMANDS` (around line 1038).
   - Remove the ternary check for `resume: trimmedPrompt === '/clear' ? undefined : sessionId,` and replace it with `resume: sessionId,`.
   - Remove `trimmedPrompt === '/clear' ? 'Conversation cleared.' :` from the defaultResult mapping.
   - Remove `if (trimmedPrompt === '/clear' && !textResult) { textResult = 'Conversation cleared.'; }`

5. **Update Unit Tests:**
   - In `src/session-commands.test.ts`, update `makeDeps()` to mock the `clearSession` function.
   - Update the `/clear` regression tests. Assert that `deps.clearSession()` is called and `deps.runAgent` is NOT called for the `/clear` command.

## Verification & Testing
- Run `npm run test` to verify `session-commands.test.ts` passes.
- Build the host side: `npm run build`
- Build the container side: `./container/build.sh`
- The system should safely process the slash command on the host without relying on the container.