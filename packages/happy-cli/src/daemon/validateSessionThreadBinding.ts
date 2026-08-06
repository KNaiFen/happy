import { resolve } from 'node:path';

import type { MachineSessionSnapshot } from '@/api/types';
import type { CodexThreadHistorySummary } from '@/codex/codexThreadHistory';

export function validateSessionThreadBinding(options: {
  machineId: string;
  snapshot: MachineSessionSnapshot;
  thread: CodexThreadHistorySummary;
}): void {
  const { machineId, snapshot, thread } = options;
  if (snapshot.originMachineId !== machineId || snapshot.machineDeletedAt !== null) {
    throw new Error('The Happy session does not belong to this active machine');
  }
  if (
    snapshot.encryptionVariant !== 'dataKey'
    || !snapshot.hasIndependentDataKey
  ) {
    throw new Error('The Happy session does not have an independent data key');
  }
  if (
    snapshot.metadata.flavor !== 'codex'
    || snapshot.metadata.codexSyncVersion !== 4
  ) {
    throw new Error('The Happy session is not a supported Codex session');
  }
  if (snapshot.metadata.machineId !== machineId) {
    throw new Error('The Happy session metadata belongs to a different machine');
  }
  if (snapshot.metadata.codexThreadId !== thread.threadId) {
    throw new Error('The Happy session is bound to a different Codex thread');
  }
  const sessionPath = snapshot.metadata.path?.trim();
  if (!sessionPath || resolve(sessionPath) !== resolve(thread.cwd)) {
    throw new Error('The Happy session is bound to a different directory');
  }
}
