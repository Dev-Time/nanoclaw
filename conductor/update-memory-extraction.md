# Plan: Update Memory Extraction to Autonomous JSONL Processing via Python Helper Script

## Objective
Migrate the `Playbook Architect` memory extraction process to an autonomous, container-native workflow. To ensure deterministic and reliable pagination without overwhelming the agent's context window, we will create a persistent Python helper script (`chunk_reader.py`) deployed as part of the container skill. The agent will execute this script to sequentially retrieve chunks of its raw `.jsonl` session logs, extract heuristics, and commit the cursor.

## Scope & Impact
- **Target Files:** 
  - Modify `src/memory-extraction.ts`
  - Create `container/skills/playbook-architect/chunk_reader.py`
- **Impact:** The extraction logic moves to a self-contained loop within the agent container. A Python helper script provides a reliable interface for the agent to page through gigabytes of raw JSON logs safely while maintaining context overlap.

## Proposed Solution
1. **Pre-written Helper Script (`chunk_reader.py`):**
   - Create a static Python script at `container/skills/playbook-architect/chunk_reader.py`. This ensures the script is automatically mounted into all agent containers at `/home/node/.claude/skills/playbook-architect/chunk_reader.py`.
   - **Script Mode `get`:** 
     - Reads `/workspace/group/playbook-cursor.txt` (or treats as 0 if missing).
     - Globs and sorts `.jsonl` files in `/home/node/.claude/projects/-workspace-group/`.
     - **Semantic Parsing:** The script parses the log into logical "turns" (a `user` message followed by all subsequent `assistant` actions). 
     - **Context Overlap:** Identifies the first full turn that occurs *after* the cursor. For overlap, it grabs the last `N` (configurable, e.g., 5) events from the turn immediately *preceding* the new turn.
     - **Chunking (No Broken Turns):** A chunk will *never* break up a turn. It takes the overlap, then adds complete, full turns one by one until adding the next full turn would exceed the configurable `CHARACTER_BUDGET` (e.g., 100,000 characters). 
     - Prints the chunked JSON and explicitly prints the final timestamp of the new chunk for the agent.
     - If no new full turns exist after the cursor, prints `NO_MORE_DATA`.
   - **Script Mode `commit <timestamp>`:**
     - Overwrites `/workspace/group/playbook-cursor.txt` with the provided timestamp.

2. **Update the Extraction Prompt:**
   - Redesign `PLAYBOOK_ARCHITECT_PROMPT` in `src/memory-extraction.ts` as an autonomous mission loop.
   - Instruct the agent to:
     1. Run `python3 /home/node/.claude/skills/playbook-architect/chunk_reader.py get`.
     2. If output is `NO_MORE_DATA`, exit.
     3. If output contains JSON logs, extract infrastructure heuristics and anti-patterns.
     4. Append the formatted rules to `/workspace/group/playbook-staging.md`.
     5. Run `python3 /home/node/.claude/skills/playbook-architect/chunk_reader.py commit [TIMESTAMP]` using the timestamp provided at the end of the chunk.
     6. Repeat the loop until `NO_MORE_DATA` is reached.

3. **Chat Isolation (Silent Execution):**
   - Ensure the extraction process remains invisible to the user on Telegram (or other channels). 
   - Verify that `runBackgroundMemoryExtraction` correctly invokes `runAgent` with an `undefined` (or no-op) `onOutput` callback in `src/index.ts`. This prevents the orchestrator from forwarding the agent's tool usage or output to the messaging UI.

## Verification
- Verify `chunk_reader.py` correctly groups events into full turns, never breaking a turn across a chunk boundary, and properly includes the last `N` events from the prior turn as overlap.
- Verify the agent follows the loop (Get -> Extract -> Append -> Commit -> Repeat) by checking container logs.
- Trigger an idle timeout or `/compact` and confirm absolutely no messages are sent to the user's chat channel during the background extraction.
- Verify `playbook-staging.md` contains rules derived from specific tool actions, proving the agent parsed the JSON correctly.
