import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecryptedMachine } from './api';
import type { Config } from './config';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { spawnSessionOnMachine } from './machineRpc';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: mockIo }));

const machineKey = new Uint8Array(32).fill(9);
const operationId = 'd94231c7-6601-483f-a8f3-92912d759423';

function config(): Config {
    return {
        serverUrl: 'https://happy.example',
        homeDir: '/tmp/happy-agent',
        credentialPath: '/tmp/happy-agent/agent.key',
        operationReceiptDir: '/tmp/happy-agent/agent-operations',
    };
}

function machine(): DecryptedMachine {
    return {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        encryption: { key: machineKey, variant: 'dataKey' },
    };
}

describe('spawnSessionOnMachine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes the durable operation ID through the encrypted spawn RPC payload', async () => {
        const emitWithAck = vi.fn().mockResolvedValue({
            ok: true,
            result: encodeBase64(encrypt(machineKey, 'dataKey', {
                type: 'success',
                sessionId: 'session-created-once',
            })),
        });
        const socket = {
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            off: vi.fn(),
            once: vi.fn(),
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        mockIo.mockReturnValue(socket);

        await expect(spawnSessionOnMachine(config(), machine(), 'token-1', {
            operationId,
            directory: '/workspace',
            approvedNewDirectoryCreation: true,
            agent: 'codex',
        })).resolves.toEqual({ type: 'success', sessionId: 'session-created-once' });

        const rpcPayload = emitWithAck.mock.calls[0][1] as { method: string; params: string };
        expect(rpcPayload.method).toBe('machine-1:spawn-happy-session');
        expect(decrypt(machineKey, 'dataKey', decodeBase64(rpcPayload.params))).toEqual({
            type: 'spawn-in-directory',
            operationId,
            directory: '/workspace',
            approvedNewDirectoryCreation: true,
            agent: 'codex',
        });
        expect(socket.close).toHaveBeenCalledOnce();
    });
});
