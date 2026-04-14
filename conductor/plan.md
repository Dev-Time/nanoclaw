# Implementation Plan: `/thinking` Toggle Command

## Objective
Implement a session command `/thinking [on|off]` to toggle the visibility of intermediate agent outputs (thinking blocks and tool calls) on a per-chat basis. This state must persist across application restarts. The default state for new or unset chats will be `off`.

## Key Files & Context
- `container/agent-runner/src/index.ts`: Emits the intermediate `🤔 *Thinking*` and `🛠️ *Tool Call:*` blocks.
- `src/container-runner.ts`: Defines the `ContainerOutput` interface.
- `src/db.ts`: Manages database state. We will use the existing `router_state` table to persist per-chat settings.
- `src/session-commands.ts`: Parses and handles session commands.
- `src/index.ts`: The main orchestrator that routes messages and handles agent execution.

## Implementation Steps
1. **Extend `ContainerOutput` Interface**
   - Add `isIntermediate?: boolean;` to `ContainerOutput` in:
     - `container/agent-runner/src/index.ts`
     - `src/container-runner.ts`
     - `src/session-commands.ts` (in `AgentResult`)

2. **Flag Intermediate Outputs**
   - Update `container/agent-runner/src/index.ts` where it processes `thinking` and `tool_use` blocks. Set `isIntermediate: true` when calling `writeOutput()`.

3. **Add Database Persistence**
   - In `src/db.ts`, add getter and setter functions:
     - `export function getChatShowThinking(chatJid: string): boolean`
     - `export function setChatShowThinking(chatJid: string, show: boolean): void`
   - These will use `getRouterState` and `setRouterState` with the key `chat_thinking:${chatJid}`. The default state will be `false` (off).

4. **Update Session Command Parser**
   - In `src/session-commands.ts`, modify `extractSessionCommand` to detect `/thinking` and `/thinking <args>`.
   - Update `SessionCommandDeps` to include `getChatShowThinking` and `setChatShowThinking`.
   - In `handleSessionCommand`, add logic:
     - `/thinking on` -> enable and notify.
     - `/thinking off` -> disable and notify.
     - `/thinking` -> report current state.

5. **Apply Filtering in the Orchestrator**
   - In `src/index.ts`, update the `runAgent`'s `onOutput` callback to check if `result.isIntermediate` is true. If it is, evaluate `getChatShowThinking(chatJid)` and only send the message if it's enabled.
   - Similarly, update the `preResult` handling loop within `src/session-commands.ts` to respect this setting.

6. **Tests**
   - Update `src/session-commands.test.ts` to handle the new `deps` and add tests for `/thinking`.
   - Update `src/thinking-output.test.ts` as needed to reflect the new interface properties.

## Verification & Testing
- Restart the container (`./container/build.sh`) to ensure the agent-runner modifications take effect.
- Run tests (`npm test`) to ensure we haven't broken any interfaces.
- Test sending `/thinking`, `/thinking on`, and `/thinking off` in a chat.
- Verify that thinking logs and tool calls only appear when the setting is `ON`.
- Verify that standard responses are unaffected.
- Restart the app and verify the toggle state persists.