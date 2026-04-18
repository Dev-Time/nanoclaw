# Implementation Plan - Hermes Agent Memory & Skill Curation

This plan outlines the implementation of "Agent-curated memory" and "Autonomous skill creation" (Playbook curation) in NanoClaw. Memory will be split into procedural (playbook) and declarative (memory) categories, with extraction triggered by session commands, complexity thresholds, and autocompaction.

## Objective
- Split operational memory into `playbook.md` (reflexes) and `memory.md` (facts/preferences).
- Upgrade the memory extraction agent to analyze task complexity (tool calls, errors).
- Implement proactive proposals for both memory types after complex tasks or session compaction.
- Add host support for reading and injecting both memory files into the agent context.

## Key Files & Context
- `src/memory-extraction.ts`: Background extraction agent and its logic.
- `src/router.ts`: Context formatting and prompt construction.
- `src/index.ts`: Orchestrator logic, triggers, and state management.
- `container/agent-runner/src/index.ts`: Container agent, handling compact events.
- `container/skills/playbook-architect/SKILL.md`: Instructions for the extraction agent.

## Implementation Steps

### 1. Host Context Injection Updates
- Update `src/router.ts` to support two memory blocks: `<playbook_operational_reflexes>` and `<memory_facts_preferences>`.
- Modify `formatMessages` to accept and inject `memoryContent`.
- Update `src/index.ts` to read both `playbook.md` and `memory.md` from the group folder.
- Add `readMemoryContent(groupFolder: string)` helper in `src/index.ts`.

### 2. Upgrade Memory Extraction Prompt
- Refactor `PLAYBOOK_ARCHITECT_PROMPT` in `src/memory-extraction.ts`:
  - Split findings into **Procedural Memory (Playbook)** and **Declarative Memory (Facts/Preferences)**.
  - Integrate "Save These" (user preferences, facts, corrections, completed work) and "Skip These" (trivial, raw data) guidelines.
  - Instruct the agent to analyze task complexity: 5+ tool calls, errors overcome, user corrections, non-trivial workflows.
  - Instruct to look for `tool_use` events in the transcript chunks.
  - Use the categorized list format for `memory.md` proposals.

### 3. Update Container Agent Runner
- Modify `container/agent-runner/src/index.ts`:
  - Use the Claude Agent SDK `PreCompact` hook to emit a specialized `isIntermediate` result with an `autocompacted: true` flag.
  - This informs the host that compaction is occurring, allowing it to trigger background memory extraction immediately.
  - Optionally use the `Stop` hook to signal the host when a session ends, ensuring final memory extraction.

### 4. Trigger Extraction on Autocompact
- Update `src/index.ts`:
  - In `runAgent`'s `onOutput` callback, check for the `autocompacted: true` flag in the result.
  - If found, trigger `runBackgroundMemoryExtraction` immediately.

### 5. Skill Definition Update
- Update `container/skills/playbook-architect/SKILL.md` to reflect the new dual-memory role.
- Define the categorized list format for `memory.md` and the reflex format for `playbook.md`.

## Verification & Testing
- **Unit Tests**:
  - Update `router.test.ts` to verify injection of both memory blocks.
  - Test `processGroupMessages` in `index.test.ts` to ensure it reads both files.
- **Integration Tests**:
  - Manual verification by running a complex task (5+ tool calls) and observing the background agent trigger (on next command or idle).
  - Use `/compact` and `/clear` to verify extraction triggers correctly.
  - Verify that proposals for both `playbook.md` and `memory.md` are generated in the group folder staging area.
- **Log Verification**:
  - Check `nanoclaw` logs for "Triggering autonomous background memory extraction" and "Memory extraction sequence complete".
