# Fix Playbook File Context & `/clear` Command Output

## Objective
1. Ensure a dedicated `playbook.md` file (separate from staging) is read from the group's directory and appended to the agent's system prompt / context, just like `CLAUDE.md`.
2. Fix the `/clear` command so it immediately replies with "Conversation cleared." to the user instead of being blocked or failing silently due to container lifecycle issues.

## Key Files
- `src/bot_messages_context.ts` (or `src/router.ts`) - Where the initial context is read and sent to the agent container.
- `src/session-commands.ts` - Where the `/clear` command is handled.

## Proposed Changes

### 1. `playbook.md` Context Loading
1. Modify `src/bot_messages_context.ts` (or wherever `CLAUDE.md` is loaded) to look for `playbook.md` in the group directory.
2. If it exists, append its content to the system prompt context, prefaced with a section header like `## Playbook (Procedural Memory)`.
3. This ensures the agent will read and abide by the rules transferred from staging to production.

### 2. `/clear` Command Fix
1. Inspect `src/session-commands.ts`. The command currently runs `deps.runBackgroundMemoryExtraction()` and then `deps.clearSession()`.
2. `clearSession()` might be interfering with `deps.sendMessage()` if it forcibly restarts the container or interrupts the IPC connection before the message can be delivered.
3. Ensure `sendMessage` happens *before* any hard resets or that the message is enqueued safely.

## Verification
1. Create a `playbook.md` in the test group, add a test rule, and run a prompt. Check the container logs or agent output to verify it received the playbook content.
2. Run the `/clear` command and verify the "Conversation cleared." message appears in the chat before the context is actually reset.