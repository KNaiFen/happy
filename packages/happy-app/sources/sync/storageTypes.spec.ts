import { describe, expect, it } from 'vitest';
import { AgentGoalStatusSchema, AgentStateSchema, MachineMetadataSchema, MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('preserves Codex launch origin metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            startedBy: 'daemon',
            startedFromDaemon: true,
        });

        expect(metadata.startedBy).toBe('daemon');
        expect(metadata.startedFromDaemon).toBe(true);
    });

    it('parses the Codex V4 metadata and tolerates future fields', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            flavor: 'codex',
            codexSyncVersion: 4,
            models: [{
                code: 'gpt-test',
                value: 'GPT Test',
                thinkingLevels: ['low', 'high'],
            }],
            futureCapability: { supported: true },
        });
        expect(metadata.flavor).toBe('codex');
        expect(metadata.codexSyncVersion).toBe(4);
        expect(metadata.models).toHaveLength(1);
        expect((metadata as any).futureCapability).toEqual({ supported: true });
    });

    it('preserves an explicit legacy Codex marker for read-only history', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            flavor: 'codex',
            codexSyncVersion: 3,
        });

        expect(metadata.codexSyncVersion).toBe(3);
    });

    it('preserves Codex queue steering capability metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            codexCapabilities: { queueSteering: true },
        });

        expect(metadata.codexCapabilities?.queueSteering).toBe(true);
    });
});

describe('MachineMetadataSchema', () => {
    it('preserves the daemon resume preflight capability', () => {
        const metadata = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'darwin',
            happyCliVersion: '1.4.45',
            happyHomeDir: '/home/.happy',
            homeDir: '/home',
            resumeSupport: {
                rpcAvailable: true,
                codexThreadHistoryRpcAvailable: true,
                preflightRpcAvailable: true,
                requiresSameMachine: true,
                detectedAt: 123,
            },
        });

        expect(metadata.resumeSupport?.preflightRpcAvailable).toBe(true);
    });

    it('preserves Codex model capabilities and future machine fields', () => {
        const metadata = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'darwin',
            happyCliVersion: '1.2.0',
            happyHomeDir: '/home/.happy',
            homeDir: '/home',
            agentCapabilities: {
                codex: {
                    codexCliVersion: 'codex-cli 0.145.0',
                    detectedAt: 123,
                    models: [{
                        code: 'gpt-5.6-sol',
                        value: 'GPT-5.6-Sol',
                        thinkingLevels: ['low', 'ultra'],
                        defaultThinkingLevel: 'low',
                        futureModelField: true,
                    }],
                    futureCodexField: true,
                },
            },
            futureMachineField: true,
        });

        expect(metadata.agentCapabilities?.codex?.models[0]?.thinkingLevels).toEqual(['low', 'ultra']);
        expect((metadata as any).futureMachineField).toBe(true);
        expect((metadata.agentCapabilities?.codex as any).futureCodexField).toBe(true);
    });
});

describe('AgentGoalStatusSchema', () => {
    it('accepts active goal state with source identity and capabilities', () => {
        const goal = AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the current task',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            sourceRevision: 7,
            capabilities: {
                clear: true,
                stop: false,
            },
            progress: {
                currentStep: 1,
                totalSteps: 2,
                steps: [
                    { text: 'inspect source', status: 'completed' },
                    { text: 'write fix', status: 'in_progress' },
                ],
            },
        });

        expect(goal.status).toBe('active');
        if (goal.status !== 'active') {
            throw new Error('expected active goal');
        }
        expect(goal.text).toBe('finish the current task');
        expect(goal.capabilities?.clear).toBe(true);
        expect(goal.progress?.steps).toHaveLength(2);
    });

    it('accepts inactive and unavailable states', () => {
        expect(AgentGoalStatusSchema.parse({
            status: 'inactive',
            source: 'codex',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            reason: 'completed',
        })).toMatchObject({ status: 'inactive', reason: 'completed' });

        expect(AgentGoalStatusSchema.parse({
            status: 'unavailable',
            source: 'codex',
            observedAt: 1710000000000,
            reason: 'unsupported',
        })).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    });

    it('rejects active state without non-empty text', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: '   ',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
        })).toThrow();
    });

    it('rejects active state without source identity', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the task',
            observedAt: 1710000000000,
        })).toThrow();
    });

    it('rejects malformed capabilities and progress payloads', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            capabilities: { clear: 'yes' },
        })).toThrow();

        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            progress: {
                currentStep: 0,
                totalSteps: 1,
                steps: [{ text: 'bad', status: 'unknown' }],
            },
        })).toThrow();
    });

    it('rejects empty source identity values', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: '   ',
        })).toThrow();

        expect(() => AgentGoalStatusSchema.parse({
            status: 'inactive',
            source: 'codex',
            observedAt: 1710000000000,
            sourceRevision: '',
        })).toThrow();
    });

    it('rejects invalid observation timestamps', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the task',
            observedAt: -1,
            sourceSessionId: 'codex-thread-1',
        })).toThrow();
    });

    it('preserves agent goal status through AgentStateSchema', () => {
        const state = AgentStateSchema.parse({
            controlledByUser: true,
            agentGoalStatus: {
                status: 'active',
                source: 'codex',
                text: 'review the branch',
                observedAt: 1710000000000,
                sourceSessionId: 'codex-thread-1',
            },
        });

        expect(state.agentGoalStatus?.status).toBe('active');
    });

    it('preserves usage limits in agent state and degrades malformed snapshots', () => {
        const state = AgentStateSchema.parse({
            controlledByUser: true,
            usageLimits: {
                capturedAt: 1710000000000,
                windows: [{ id: 'five_hour', status: 'allowed', utilization: 42, resetsAt: null }],
            },
        });
        expect(state.usageLimits?.windows[0].id).toBe('five_hour');

        const malformed = AgentStateSchema.parse({
            controlledByUser: true,
            usageLimits: { capturedAt: 'bad', windows: [] },
        });
        expect(malformed.controlledByUser).toBe(true);
        expect(malformed.usageLimits).toBeUndefined();
    });
});
