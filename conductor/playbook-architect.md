# Playbook Architect (Memory Skill)

## Objective
Implement an automated, staged "memory" capability that continuously extracts operational reflexes from sessions and stages them for manual review. This playbook is automatically injected into the agent's context window, keeping `CLAUDE.md` lean while ensuring immediate access to learned heuristics.

## Architecture Decision: SQLite DB & Memory Cursor
We will operate on the **session context from the SQLite database** rather than flat transcript files. 
To prevent the agent from reviewing the same messages multiple times across different triggers, we will implement a **Memory Cursor** (`groups/{name}/playbook-cursor.txt`). When a trigger fires:
1. Fetch messages from the DB strictly *after* the timestamp in the cursor. 
2. If there are no new messages (or too few), skip extraction.
3. If extraction runs, update the cursor to the timestamp of the latest message.

## Key Files & Context
- `src/session-commands.ts`: Handles manual `/clear` and `/compact` commands.
- `src/container-runner.ts` & `src/index.ts`: Handle container lifecycle and `IDLE_TIMEOUT`.
- `src/router.ts`: Handles XML message formatting. Will inject `<playbook>` tags.
- `src/index.ts`: Orchestrates messages. Will read `playbook.md` and pass to the router.
- `container/skills/playbook-architect/SKILL.md`: The Container Skill for reviewing and committing staged memories.
- `playbook.md`, `playbook-staging.md`, `playbook-cursor.txt`: The storage files (isolated per group).

## Implementation Steps

### 1. Automatic Extraction (Staging) & Triggers
We will hook the extraction task into three key lifecycle events. *Before* executing the primary action of the event, fetch unextracted messages via the Memory Cursor, spawn a background Playbook Architect task, and append drafted rules to `playbook-staging.md`.
- **Manual `/clear` & `/compact` (`src/session-commands.ts`):** Trigger extraction before `clearSession()` or `advanceCursor()` drops the history.
- **Auto-Compaction (`src/container-runner.ts`):** Trigger extraction when the context reaches the token limit, before truncating.
- **Idle Timeout (`src/index.ts`):** NanoClaw tracks an `idleTimer` (default 55 mins). When this timer fires (indicating the container is about to be spun down due to inactivity), trigger the extraction task on any unextracted messages.

### 2. Context Injection (Auto-Loading)
- **Modify Router (`src/router.ts` & `src/index.ts`):
  - Update `formatMessages` to accept a `playbookContent` parameter.
  - If provided, inject it into the XML output: `<playbook>\n${playbookContent}\n</playbook>\n` (placed after the `<context timezone="..." />` header).
  - In `src/index.ts`, check for `groups/{name}/playbook.md` during message processing. If it exists, read it and pass it to `formatMessages`.

### 3. Review & Commit Skill (`container/skills/playbook-architect/SKILL.md`)
- Create the Container Skill using the standard Claude Code skills frontmatter.
- Include instructions that tell the agent how to handle the manual review phase:
  - **Review Phase:** When the user asks to "review proposals" or "check memories", the agent reads `playbook-staging.md` and presents the drafted rules.
  - **Commit Phase:** When the user replies with 'Commit [ID]', the agent uses its file editing tools to *move* the exact Typographic Output for that proposal from `playbook-staging.md` to `playbook.md`.
  - **Reject Phase:** If the user replies 'Reject [ID]', the agent deletes that proposal from `playbook-staging.md`.

## Verification & Testing
1. **Core Logic:** Run `npm test` to ensure `src/*.test.ts` regressions pass.
2. **Cursor Logic:** Verify that triggering `/clear` twice sequentially does not result in duplicate extractions.
3. **Auto-Extraction:** Let the `IDLE_TIMEOUT` fire and verify `playbook-staging.md` is populated with drafted rules from the final messages.
4. **Context Injection:** Verify that `playbook.md` contents are successfully injected into the XML `<context>` payload on new messages.
5. **Skill Workflow:** Trigger the `playbook-architect` skill, review the staged rules, issue a 'Commit [ID]', and verify the rule is moved cleanly from staging to the active playbook.
