import type { NewMessage } from './types.js';
import { logger } from './logger.js';

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
  modelKey?: string,
): string | null {
  const text = content.trim();

  const isCommand = (t: string) =>
    t === '/clear' ||
    t === '/compact' ||
    t === '/memo' ||
    t === '/models' ||
    t === '/model' ||
    t.startsWith('/model ') ||
    t === '/thinking' ||
    t.startsWith('/thinking ');

  // Case 1: Bare command (matches even if trigger would overlap, e.g. trigger is "/")
  if (isCommand(text)) return text;

  // Case 2: Strip model alias first if it matches our modelKey
  let stripped = text;
  if (modelKey) {
    const match = /^@([\w][\w-]*)\b/i.exec(text);
    if (match && match[1].toLowerCase() === modelKey.toLowerCase()) {
      stripped = text.slice(match[0].length).trim();
    } else {
      stripped = text.replace(triggerPattern, '').trim();
    }
  } else {
    stripped = text.replace(triggerPattern, '').trim();
  }

  if (isCommand(stripped)) return stripped;

  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
  isIntermediate?: boolean;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<any | 'error'>;
  runBackgroundMemoryExtraction: () => Promise<void>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (
    msgs: NewMessage[],
    timezone: string,
    playbookContent?: string,
    memoryContent?: string,
  ) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Get available model aliases (for /models). */
  getAvailableModelAliases: () => string[];
  /** Get/set the default model alias for the current chat. */
  chatJid: string;
  getChatModel: (chatJid: string) => string | undefined;
  setChatModel: (chatJid: string, modelAlias: string | null) => void;
  getChatShowThinking: (chatJid: string) => boolean;
  setChatShowThinking: (chatJid: string, show: boolean) => void;
  clearSession: () => void;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
  modelKey?: string;
  playbookContent?: string;
  memoryContent?: string;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
    modelKey,
    playbookContent,
    memoryContent,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern, modelKey) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern, modelKey)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (!isSessionCommandAllowed(isMainGroup, cmdMsg.is_from_me === true)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
  logger.info({ group: groupName, command }, 'Session command');

  if (command === '/models') {
    const aliases = deps.getAvailableModelAliases();
    const text =
      aliases.length > 0
        ? `Available model aliases:\n${aliases.map((a) => `@${a}`).join('\n')}`
        : 'No model aliases configured.';
    await deps.sendMessage(text);
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  if (command === '/model' || command.startsWith('/model ')) {
    const args = command.slice(6).trim(); // Skip "/model"
    const aliases = deps.getAvailableModelAliases();

    if (!args) {
      // Show current model
      const current = deps.getChatModel(deps.chatJid);
      const text = current
        ? `Current default model for this chat: @${current}`
        : 'Currently using the system default model for this chat.';
      await deps.sendMessage(text);
    } else if (args.toLowerCase() === 'default') {
      // Revert to default
      deps.setChatModel(deps.chatJid, null);
      await deps.sendMessage(
        'Reverted to the system default model for this chat.',
      );
    } else {
      // Set to alias
      const normalizedAlias = args.startsWith('@') ? args.slice(1) : args;
      const found = aliases.find(
        (a) => a.toLowerCase() === normalizedAlias.toLowerCase(),
      );

      if (found) {
        deps.setChatModel(deps.chatJid, found);
        await deps.sendMessage(`Default model for this chat set to: @${found}`);
      } else {
        const errorMsg =
          aliases.length > 0
            ? `Unknown model alias. Available: ${aliases.map((a) => '@' + a).join(', ')}`
            : 'No model aliases configured.';
        await deps.sendMessage(errorMsg);
      }
    }

    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  if (command === '/thinking' || command.startsWith('/thinking ')) {
    const args = command.slice(9).trim().toLowerCase();
    if (!args) {
      const current = deps.getChatShowThinking(deps.chatJid);
      await deps.sendMessage(
        `Intermediate thinking output is currently ${current ? 'ON' : 'OFF'} for this chat.`,
      );
    } else if (args === 'on') {
      deps.setChatShowThinking(deps.chatJid, true);
      await deps.sendMessage('Intermediate thinking output enabled.');
    } else if (args === 'off') {
      deps.setChatShowThinking(deps.chatJid, false);
      await deps.sendMessage('Intermediate thinking output disabled.');
    } else {
      await deps.sendMessage('Usage: /thinking [on|off]');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs =
    command === '/clear' ? [] : missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(
      preCompactMsgs,
      timezone,
      playbookContent,
      memoryContent,
    );
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        const showThinking = deps.getChatShowThinking(deps.chatJid);
        if (!result.isIntermediate || showThinking) {
          await deps.sendMessage(text);
          preOutputSent = true;
        }
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Handle /clear natively on the host to avoid "Unknown skill: clear" error
  // from the agent container (SDK doesn't have built-in clear).
  if (command === '/clear') {
    await deps.sendMessage('Conversation cleared.');
    deps.closeStdin();
    deps.clearSession();
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // Handle /memo natively on the host to trigger a curation sweep.
  if (command === '/memo') {
    await deps.sendMessage('🧠 Triggering manual memory extraction...');
    await deps.runBackgroundMemoryExtraction();
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) {
      const showThinking = deps.getChatShowThinking(deps.chatJid);
      if (!result.isIntermediate || showThinking) {
        await deps.sendMessage(text);
      }
    }
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
