import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionHost, Tx } from '@/storage/inTx';

const { emitUpdateMock } = vi.hoisted(() => ({ emitUpdateMock: vi.fn() }));

vi.mock('@/app/events/eventRouter', () => ({
    buildNewArtifactUpdate: vi.fn(() => ({ id: 'update', seq: 1, body: {}, createdAt: 0 })),
    eventRouter: { emitUpdate: emitUpdateMock },
}));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-key') }));

import { createArtifactForAccount } from './artifactCreate';

const enabled = process.env.HAPPY_POSTGRES_INTEGRATION_TEST === '1';
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const accountIds = new Set<string>();
const artifactIds = new Set<string>();
const clients: PrismaClient[] = [];

integrationDescribe('Artifact create PostgreSQL ordering', () => {
    let first: PrismaClient;
    let second: PrismaClient;

    beforeAll(() => {
        assertLocalTestDatabase();
        first = new PrismaClient();
        second = new PrismaClient();
        clients.push(first, second);
    });

    afterEach(async () => {
        await first.artifact.deleteMany({ where: { id: { in: [...artifactIds] } } });
        await first.account.deleteMany({ where: { id: { in: [...accountIds] } } });
        artifactIds.clear();
        accountIds.clear();
        vi.clearAllMocks();
    });

    afterAll(async () => {
        await Promise.all(clients.map((client) => client.$disconnect()));
    });

    it('settles simultaneous cross-account creates as one create and one explicit conflict', async () => {
        const [firstAccount, secondAccount] = await Promise.all([
            createAccount(first),
            createAccount(first),
        ]);
        const id = crypto.randomUUID();
        artifactIds.add(id);
        const [firstHost, secondHost] = createBarrierHosts(first, second);
        const input = {
            id,
            header: new Uint8Array([1]).slice(),
            body: new Uint8Array([2]).slice(),
            dataEncryptionKey: new Uint8Array([3]).slice(),
        };

        const results = await Promise.all([
            createArtifactForAccount(firstAccount.id, input, firstHost),
            createArtifactForAccount(secondAccount.id, input, secondHost),
        ]);

        expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'created']);
        const persisted = await first.artifact.findUniqueOrThrow({ where: { id } });
        expect([firstAccount.id, secondAccount.id]).toContain(persisted.accountId);
        expect(persisted.updateSeq).toBe(1);
        const accounts = await first.account.findMany({
            where: { id: { in: [firstAccount.id, secondAccount.id] } },
            select: { id: true, seq: true, artifactRevision: true },
        });
        expect(accounts.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
            { id: firstAccount.id, seq: persisted.accountId === firstAccount.id ? 1 : 0, artifactRevision: persisted.accountId === firstAccount.id ? 1 : 0 },
            { id: secondAccount.id, seq: persisted.accountId === secondAccount.id ? 1 : 0, artifactRevision: persisted.accountId === secondAccount.id ? 1 : 0 },
        ].sort((a, b) => a.id.localeCompare(b.id)));
        expect(emitUpdateMock).toHaveBeenCalledTimes(1);
    });
});

async function createAccount(client: PrismaClient): Promise<{ id: string }> {
    const account = await client.account.create({
        data: { publicKey: `artifact-create-${crypto.randomUUID()}` },
        select: { id: true },
    });
    accountIds.add(account.id);
    return account;
}

function createBarrierHosts(
    first: PrismaClient,
    second: PrismaClient,
): [TransactionHost, TransactionHost] {
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
    });

    const createHost = (client: PrismaClient): TransactionHost => {
        let intercepted = false;
        return {
            $transaction: async (callback, options) => client.$transaction(async (tx) => {
                const artifact = new Proxy(tx.artifact, {
                    get(target, property, receiver) {
                        if (property === 'create') {
                            return async (args: Parameters<typeof target.create>[0]) => {
                                if (!intercepted) {
                                    intercepted = true;
                                    arrivals += 1;
                                    if (arrivals === 2) release();
                                    await barrier;
                                }
                                return target.create(args);
                            };
                        }
                        const value = Reflect.get(target, property, receiver);
                        return typeof value === 'function' ? value.bind(target) : value;
                    },
                });
                const transaction = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === 'artifact') return artifact;
                        return Reflect.get(target, property, receiver);
                    },
                }) as unknown as Tx;
                return callback(transaction);
            }, options),
        } as TransactionHost;
    };

    return [createHost(first), createHost(second)];
}

function assertLocalTestDatabase(): void {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || process.env.DB_PROVIDER !== 'postgres') {
        throw new Error('PostgreSQL integration test requires DATABASE_URL and DB_PROVIDER=postgres');
    }
    const parsed = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    if (!new Set(['localhost', '127.0.0.1', '[::1]']).has(parsed.hostname) || !databaseName.includes('_test')) {
        throw new Error('PostgreSQL integration test only permits a loopback _test database');
    }
}
