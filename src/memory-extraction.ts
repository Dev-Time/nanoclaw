import { logger } from './logger.js';

const PLAYBOOK_ARCHITECT_PROMPT = `
# Role: Playbook Architect & Meta-Cognitive Debugger

**Objective:** You are a reasoning engine responsible for analyzing session transcripts and distilling them into pure operational reflexes (Procedural Memory). You must extract infrastructure rules, shell/tooling heuristics, and execution anti-patterns. You are building a technical playbook, not a declarative diary.

## Autonomous Mission Directive
You must process the session logs sequentially in chunks and extract rules. Follow this exact loop using your tools:

1. **Get Chunk:** Run \`python3 /home/node/.claude/skills/playbook-architect/chunk_reader.py get [BUDGET] [OVERLAP]\`.
   - **BUDGET**: Configurable character limit (default: 100,000).
   - **OVERLAP**: Number of events to include from the previous turn (default: 5).
2. **Check for Data:**
   - If the output is "NO_MORE_DATA", your mission is complete. Terminate.
   - If the output contains a JSON object with "events" and "CHUNK_FINAL_TIMESTAMP", proceed to Step 3.
3. **Analyze & Extract:**
   - Analyze the "events" in the chunk. Focus on tool friction, failures, and complex successes.
   - Ignore the domain subject (the "What") and extract the operational reflex (the "How").
4. **Append & Commit:**
   - Append your findings strictly in the Typographic Format below to \`/workspace/group/playbook-staging.md\`.
   - Run \`python3 /home/node/.claude/skills/playbook-architect/chunk_reader.py commit [TIMESTAMP]\` using the "final_timestamp" value provided in the JSON output.
5. **Repeat:** Return to Step 1.

## Typographic Output Format
For each rule appended to the file:

### [PROPOSED-ID] Title of Rule
* **Context:** [Tag 1], [Tag 2]
* **Trigger:** [When to apply this, starting with "When..."]
* **Action:** [A concise, imperative command.]

**End of Output Directive:** 
Once ALL chunks are processed and you terminate, do not send any final messages to the user.
`;

export async function runBackgroundMemoryExtraction(
  _chatJid: string,
  groupFolder: string,
  runAgent: (prompt: string) => Promise<any>,
  _timezone: string,
): Promise<void> {
  logger.info({ groupFolder }, 'Triggering autonomous background memory extraction');

  try {
    const output = await runAgent(PLAYBOOK_ARCHITECT_PROMPT);
    if (output === 'error' || output.status === 'error') {
      logger.error({ groupFolder }, 'Memory extraction agent returned error');
      return;
    }

    logger.info({ groupFolder }, 'Autonomous memory extraction sequence complete');
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to run background memory extraction');
  }
}
