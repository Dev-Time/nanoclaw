import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  ipcFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        ipcFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (slotKey: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(slotKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(slotKey);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ slotKey }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(slotKey)) {
        this.waitingGroups.push(slotKey);
      }
      logger.debug(
        { slotKey, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(slotKey, 'messages').catch((err) =>
      logger.error({ slotKey, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(slotKey: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(slotKey);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ slotKey, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ slotKey, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid: slotKey, fn });
      if (state.idleWaiting) {
        this.closeStdin(slotKey);
      }
      logger.debug({ slotKey, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid: slotKey, fn });
      if (!this.waitingGroups.includes(slotKey)) {
        this.waitingGroups.push(slotKey);
      }
      logger.debug(
        { slotKey, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(slotKey, { id: taskId, groupJid: slotKey, fn }).catch((err) =>
      logger.error({ slotKey, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    slotKey: string,
    proc: ChildProcess,
    containerName: string,
    ipcFolder?: string,
  ): void {
    const state = this.getGroup(slotKey);
    state.process = proc;
    state.containerName = containerName;
    if (ipcFolder) state.ipcFolder = ipcFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(slotKey: string): void {
    const state = this.getGroup(slotKey);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(slotKey);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(slotKey: string, text: string): boolean {
    const state = this.getGroup(slotKey);
    if (!state.active || !state.ipcFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.ipcFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(slotKey: string): void {
    const state = this.getGroup(slotKey);
    if (!state.active || !state.ipcFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.ipcFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    slotKey: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(slotKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { slotKey, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(slotKey);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(slotKey, state);
        }
      }
    } catch (err) {
      logger.error({ slotKey, err }, 'Error processing messages for group');
      this.scheduleRetry(slotKey, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.ipcFolder = null;
      this.activeCount--;
      this.drainGroup(slotKey);
    }
  }

  private async runTask(slotKey: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(slotKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { slotKey, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ slotKey, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.ipcFolder = null;
      this.activeCount--;
      this.drainGroup(slotKey);
    }
  }

  private scheduleRetry(slotKey: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { slotKey, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { slotKey, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(slotKey);
      }
    }, delayMs);
  }

  private drainGroup(slotKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(slotKey);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(slotKey, task).catch((err) =>
        logger.error(
          { slotKey, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(slotKey, 'drain').catch((err) =>
        logger.error(
          { slotKey, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this slot; check if other slots are waiting for a container slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextSlotKey = this.waitingGroups.shift()!;
      const state = this.getGroup(nextSlotKey);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextSlotKey, task).catch((err) =>
          logger.error(
            { slotKey: nextSlotKey, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextSlotKey, 'drain').catch((err) =>
          logger.error(
            { slotKey: nextSlotKey, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this slot
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
