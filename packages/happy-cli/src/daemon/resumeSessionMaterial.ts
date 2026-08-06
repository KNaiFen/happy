import type { MachineSessionSnapshot } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';

export type ResumeSessionMaterialResult =
  | { type: 'resumeMaterialRequired'; sessionId: string }
  | { type: 'snapshot'; snapshot: MachineSessionSnapshot }
  | {
      type: 'error';
      kind: 'invalidBinding' | 'unavailable';
      errorMessage: string;
    };

export function decodeIndependentSessionKey(encoded: string): Uint8Array {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 128) {
    throw new Error('Invalid per-session encryption key');
  }
  const key = decodeBase64(encoded);
  if (key.length !== 32) {
    throw new Error('Invalid per-session encryption key');
  }
  return key;
}

export async function resolveResumeSessionMaterial(options: {
  sessionId: string;
  machineId: string;
  dataEncryptionKey?: string;
  loadSnapshot: (input: {
    sessionId: string;
    machineId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'dataKey';
  }) => Promise<MachineSessionSnapshot | null>;
}): Promise<ResumeSessionMaterialResult> {
  if (!options.dataEncryptionKey) {
    return { type: 'resumeMaterialRequired', sessionId: options.sessionId };
  }

  let encryptionKey: Uint8Array;
  try {
    encryptionKey = decodeIndependentSessionKey(options.dataEncryptionKey);
  } catch {
    return {
      type: 'error',
      kind: 'invalidBinding',
      errorMessage: 'The Happy session could not be verified with its per-session encryption key.',
    };
  }

  let snapshot: MachineSessionSnapshot | null;
  try {
    snapshot = await options.loadSnapshot({
      sessionId: options.sessionId,
      machineId: options.machineId,
      encryptionKey,
      encryptionVariant: 'dataKey',
    });
  } catch {
    return {
      type: 'error',
      kind: 'unavailable',
      errorMessage: 'The Happy session snapshot is temporarily unavailable.',
    };
  }

  if (!snapshot) {
    return {
      type: 'error',
      kind: 'invalidBinding',
      errorMessage: `Session ${options.sessionId} is no longer available on this machine.`,
    };
  }
  if (
    snapshot.id !== options.sessionId
    || snapshot.originMachineId !== options.machineId
    || snapshot.metadata.machineId !== options.machineId
    || snapshot.machineDeletedAt !== null
  ) {
    return {
      type: 'error',
      kind: 'invalidBinding',
      errorMessage: 'The Happy session does not belong to this active machine.',
    };
  }
  if (!snapshot.hasIndependentDataKey || snapshot.encryptionVariant !== 'dataKey') {
    return {
      type: 'error',
      kind: 'invalidBinding',
      errorMessage: 'This Codex session does not have an independent Sync v4 data key.',
    };
  }
  return { type: 'snapshot', snapshot };
}
