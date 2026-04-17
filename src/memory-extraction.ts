import fs from 'fs';
import path from 'path';
import { getMessagesSince } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { formatMessages } from './router.js';
import { NewMessage } from './types.js';

const PLAYBOOK_CURSOR_FILE = 'playbook-cursor.txt';
const PLAYBOOK_STAGING_FILE = 'playbook-staging.md';
const ASSISTANT_NAME = 'PlaybookArchitect';

const PLAYBOOK_ARCHITECT_PROMPT = `
# Role: Playbook Architect & Meta-Cognitive Debugger

**Objective:** You are a reasoning engine responsible for analyzing session transcripts and distilling them into pure operational reflexes (Procedural Memory). You must extract infrastructure rules, shell/tooling heuristics, and execution anti-patterns. You are building a technical playbook, not a declarative diary.

## The Core Philosophy (Infrastructure vs. Application)
You must completely decouple the *Operational Rule* (The "How") from the *Application Content* (The "What").
* **Discard Domain Data:** Strip all references to the specific subject matter of the project.
* **Retain the Abstract Shape:** Use "Context Tags" to describe the type of data or environment.

## Execution Steps
1. **Scan the Transcript:** Identify tool friction (loops, failures, user corrections) or highly successful complex pipelines from the current session.
2. **Filter & Abstract:** Generalize the failure or success into a reusable operational rule.
3. **Draft the Proposal:** Output your findings strictly in the Typographic Format below.

## Typographic Output Format
You must use the exact typographic structure below. Do not deviate.

### [PROPOSED-ID] Title of Rule
* **Context:** [Tag 1], [Tag 2]
* **Trigger:** [When to apply this, starting with "When..."]
* **Action:** [A concise, imperative command.]

**End of Output Directive:** 
Conclude your proposal with exactly: "Review these proposals. Reply with 'Commit [Number]' or 'Reject'."
`;

export async function runBackgroundMemoryExtraction(
  chatJid: string,
  groupFolder: string,
  runAgent: (prompt: string) => Promise<any>,
  timezone: string,
): Promise<void> {
  const groupPath = resolveGroupFolderPath(groupFolder);
  const cursorPath = path.join(groupPath, PLAYBOOK_CURSOR_FILE);
  const stagingPath = path.join(groupPath, PLAYBOOK_STAGING_FILE);

  let lastTimestamp = '';
  if (fs.existsSync(cursorPath)) {
    lastTimestamp = fs.readFileSync(cursorPath, 'utf8').trim();
  }

  const messages = getMessagesSince(chatJid, lastTimestamp, 'system', 100);
  // Filter out system messages and bot internal tags if necessary
  const userInteractions = messages.filter((m) => !m.is_from_me);

  if (userInteractions.length < 2) {
    logger.debug({ groupFolder }, 'Skipping memory extraction: too few user interactions');
    return;
  }

  logger.info({ groupFolder, count: messages.length }, 'Running background memory extraction');

  const transcript = formatMessages(messages, timezone);
  const prompt = `${PLAYBOOK_ARCHITECT_PROMPT}\n\n## Session Transcript:\n${transcript}`;

  try {
    const output = await runAgent(prompt);
    if (output === 'error' || output.status === 'error') {
      logger.error({ groupFolder }, 'Memory extraction agent returned error');
      return;
    }

    const content = resultToText(output.result);

    if (content && content.includes('### [')) {
      fs.appendFileSync(stagingPath, `\n\n--- Extracted at ${newTimestamp()} ---\n${content}\n`);
      const finalTimestamp = messages[messages.length - 1].timestamp;
      fs.writeFileSync(cursorPath, finalTimestamp);
      logger.info({ groupFolder }, 'Successfully staged new memory proposals');
    } else {
      logger.debug({ groupFolder }, 'Memory extraction produced no new rules');
      // Still update cursor so we don't keep reprocessing the same empty context
      const finalTimestamp = messages[messages.length - 1].timestamp;
      fs.writeFileSync(cursorPath, finalTimestamp);
    }
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to run background memory extraction');
  }
}

function resultToText(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((r) => {
        if (typeof r === 'string') return r;
        if (r && typeof r === 'object' && 'type' in r && r.type === 'text') return r.text;
        return '';
      })
      .join('\n');
  }
  return JSON.stringify(result);
}

function newTimestamp(): string {
  return new Date().toISOString();
}
