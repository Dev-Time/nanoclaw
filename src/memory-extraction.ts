import { logger } from './logger.js';

const PLAYBOOK_ARCHITECT_PROMPT = `
# Role: Memory Curator & Meta-Cognitive Debugger

**Objective:** Analyze session transcripts to extract both Procedural Memory (operational reflexes) and Declarative Memory (facts/preferences). You are building a technical playbook and a persistent memory base, not a declarative diary.

## Complexity Threshold
You MUST proactively extract memory when you observe:
- High task complexity (e.g., 5+ tool calls in a single turn/workflow).
- Errors, loops, or dead ends that required a workaround or fix.
- Explicit user corrections or strongly stated preferences.
- Discovery of non-trivial workflows or infrastructure facts.

## Memory Split
1. **Playbook (Procedural Memory):** Operational rules, tooling heuristics, and execution anti-patterns.
   - Save to: \`/workspace/group/playbook-staging.md\`
   - Format:
     ### [PROPOSED-ID] Title of Rule
     * **Context:** [Tag 1], [Tag 2]
     * **Trigger:** [When to apply this, starting with "When..."]
     * **Action:** [A concise, imperative command.]

2. **Memory (Declarative Memory):** Facts, preferences, corrections, and completed work.
   - Save to: \`/workspace/group/memory-staging.md\`
   - Format:
     ### [Category Name]
     - **[Fact/Preference/Correction/Work]**: Detailed description.
     - **Context**: Brief mention of how/when this was learned.

## Curation Guidelines
### Save These (Proactively)
- **User preferences**: "I prefer TypeScript over JavaScript", "Use tabs for indentation".
- **Environment facts**: "Server runs Debian 12", "PostgreSQL 16 is installed".
- **Corrections**: "Don't use sudo for Docker", "The API endpoint changed to /v2".
- **Conventions**: "Use Google-style docstrings", "120-char line width".
- **Completed work**: "Migrated database on 2026-01-15", "Initialized project structure".

### Skip These
- Trivial/obvious info: "User asked about Python", "Agent listed files".
- Easily re-discovered facts: "Python 3.12 syntax", "Standard library documentation".
- Raw data dumps: Large code blocks, log files, data tables.
- Session-specific ephemera: Temporary file paths, one-off debugging context.

## Autonomous Mission Directive
You must process the session logs sequentially in chunks and extract memory. Follow this exact loop:

1. **Get Chunk:** Run \`python3 /home/node/.claude/skills/playbook-architect/chunk_reader.py get [BUDGET] [OVERLAP]\`.
   - Analyze the "events" in the chunk. Look for \`tool_use\` calls to judge complexity.
2. **Check for Data:**
   - If the output is "NO_MORE_DATA", proceed to **Step 6**.
   - If the output contains JSON, proceed.
3. **Analyze & Extract:** Distill the findings into Playbook rules or Memory facts based on the Split and Guidelines above.
4. **Append & Commit:**
   - Append Playbook findings to \`/workspace/group/playbook-staging.md\`.
   - Append Memory findings to \`/workspace/group/memory-staging.md\`.
   - Run \`python3 /home/node/.claude/skills/playbook-architect/chunk_reader.py commit [TIMESTAMP]\` using the "final_timestamp" value.
5. **Repeat:** Return to Step 1.

6. **Nudge (Mission Complete):** 
   - If you found and saved new memory/rules, output a single-line "Nudge" summary starting with \`[NUDGE]\`.
   - Example: \`[NUDGE] I've drafted 2 operational rules and 1 environment fact for your review.\`
   - If nothing was found, output nothing.

**End of Output Directive:** 
After the Nudge (if any), terminate. Do not send any other final messages.
`;

export async function runBackgroundMemoryExtraction(
  chatJid: string,
  groupFolder: string,
  runAgent: (
    prompt: string,
    onOutput?: (output: any) => Promise<void>,
  ) => Promise<any>,
  _timezone: string,
  sendMessage?: (text: string) => Promise<void>,
): Promise<void> {
  logger.info({ groupFolder }, 'Triggering autonomous background memory extraction');

  try {
    const output = await runAgent(PLAYBOOK_ARCHITECT_PROMPT, async (stream) => {
      const result = stream.result;
      if (typeof result === 'string' && result.includes('[NUDGE]') && sendMessage) {
        const nudge = result
          .split('\n')
          .find((line: string) => line.includes('[NUDGE]'))
          ?.replace('[NUDGE]', '🧠')
          .trim();
        if (nudge) {
          await sendMessage(nudge);
        }
      }
    });

    if (output === 'error' || output.status === 'error') {
      logger.error({ groupFolder }, 'Memory extraction agent returned error');
      return;
    }

    logger.info({ groupFolder }, 'Autonomous memory extraction sequence complete');
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to run background memory extraction');
  }
}
