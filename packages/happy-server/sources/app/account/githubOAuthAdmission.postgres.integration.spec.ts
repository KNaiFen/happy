import { Prisma, PrismaClient } from '@prisma/client';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '@/app/api/types';

const { authMock, fetchMock, githubConnectMock } = vi.hoisted(() => ({
    authMock: {
        createGithubToken: vi.fn(async () => 'signed-state'),
        verifyGithubToken: vi.fn(),
        invalidateUserTokens: vi.fn(),
    },
    fetchMock: vi.fn(),
    githubConnectMock: vi.fn(),
}));

vi.mock('@/app/auth/auth', () => ({
    GITHUB_OAUTH_STATE_TTL_MS: 5 * 60 * 1000,
    auth: authMock,
}));
vi.mock('@/app/github/githubConnect', () => ({ githubConnect: githubConnectMock }));
vi.mock('@/app/github/githubDisconnect', () => ({ githubDisconnect: vi.fn() }));

import {
    acceptAccountDeletionProofInTransaction,
    processAccountDeletion,
} from './accountDeletion';
import {
    claimGithubOAuthAdmissionInTransaction,
    type GithubOAuthAdmission,
} from './githubOAuthAdmission';
import { connectRoutes } from '@/app/api/routes/connectRoutes';

const enabled = process.env.HAPPY_POSTGRES_INTEGRATION_TEST === '1';
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const clients: PrismaClient[] = [];
const fixtureAccountIds = new Set<string>();

integrationDescribe('GitHub OAuth and account deletion PostgreSQL ordering', () => {
    let first: PrismaClient;
    let second: PrismaClient;
    const originalEnv = {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        redirectUrl: process.env.GITHUB_REDIRECT_URL,
    };

    beforeAll(() => {
        assertLocalTestDatabase();
        first = new PrismaClient();
        second = new PrismaClient();
        clients.push(first, second);
    });

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GITHUB_CLIENT_ID = 'postgres-test-client';
        process.env.GITHUB_CLIENT_SECRET = 'postgres-test-secret';
        process.env.GITHUB_REDIRECT_URL = 'https://server.example/callback';
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await Promise.all([...fixtureAccountIds].map((id) => first.account.deleteMany({ where: { id } })));
        fixtureAccountIds.clear();
    });

    afterAll(async () => {
        await Promise.all(clients.map((client) => client.$disconnect()));
        restoreEnv('GITHUB_CLIENT_ID', originalEnv.clientId);
        restoreEnv('GITHUB_CLIENT_SECRET', originalEnv.clientSecret);
        restoreEnv('GITHUB_REDIRECT_URL', originalEnv.redirectUrl);
    });

    it('keeps deletion pending when a callback claim commits first', async () => {
        const fixture = await createFixture(first);
        const claimLocked = deferred<void>();
        const releaseClaim = deferred<void>();
        const deleteStarted = deferred<void>();

        const claim = first.$transaction(async (tx) => {
            const claimed = await claimGithubOAuthAdmissionInTransaction(tx, fixture.admission);
            expect(claimed).toBe(true);
            claimLocked.resolve();
            await releaseClaim.promise;
            return claimed;
        }, serializableOptions);
        await claimLocked.promise;

        const deletion = withSerializableRetry(second, async (tx) => {
            deleteStarted.resolve();
            return acceptAccountDeletionProofInTransaction(tx, fixture.deletionInput);
        });
        await deleteStarted.promise;
        releaseClaim.resolve();

        await expect(claim).resolves.toBe(true);
        await expect(deletion).resolves.toBe(true);
        await expect(processAccountDeletion(fixture.accountId)).resolves.toBe('pending');

        const admission = await first.accountDeletionGithubOAuthAdmission.findUnique({
            where: { id: fixture.admission.id },
        });
        expect(admission?.callbackStartedAt).not.toBeNull();
        expect(admission?.completedAt).toBeNull();
    });

    it('rejects callback admission and never calls GitHub when deletion commits first', async () => {
        const fixture = await createFixture(first);
        const deletionLocked = deferred<void>();
        const releaseDeletion = deferred<void>();
        const claimStarted = deferred<void>();

        const deletion = first.$transaction(async (tx) => {
            const accepted = await acceptAccountDeletionProofInTransaction(tx, fixture.deletionInput);
            expect(accepted).toBe(true);
            deletionLocked.resolve();
            await releaseDeletion.promise;
            return accepted;
        }, serializableOptions);
        await deletionLocked.promise;

        const claim = withSerializableRetry(second, async (tx) => {
            claimStarted.resolve();
            return claimGithubOAuthAdmissionInTransaction(tx, fixture.admission);
        });
        await claimStarted.promise;
        releaseDeletion.resolve();

        await expect(deletion).resolves.toBe(true);
        await expect(claim).resolves.toBe(false);

        authMock.verifyGithubToken.mockResolvedValue({
            userId: fixture.accountId,
            admissionId: fixture.admission.id,
        });
        const app = await createCallbackApp();
        try {
            const result = await app.inject({
                method: 'GET',
                url: '/v1/connect/github/callback?code=github-code&state=signed-state',
            });
            expect(result.statusCode).toBe(302);
            expect(result.headers.location).toBe('https://app.happy.engineering?error=invalid_state');
            expect(fetchMock).not.toHaveBeenCalled();
            expect(githubConnectMock).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });
});

const serializableOptions = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 10_000,
} as const;

async function createFixture(client: PrismaClient): Promise<{
    accountId: string;
    admission: GithubOAuthAdmission;
    deletionInput: Parameters<typeof acceptAccountDeletionProofInTransaction>[1];
}> {
    const account = await client.account.create({
        data: { publicKey: `postgres-oauth-${crypto.randomUUID()}` },
        select: { id: true },
    });
    fixtureAccountIds.add(account.id);
    const challenge = await client.accountDeletionChallenge.create({
        data: {
            accountId: account.id,
            challengeHash: 'postgres-test-challenge',
            expiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
    });
    const admission = await client.accountDeletionGithubOAuthAdmission.create({
        data: {
            id: `postgres-oauth-admission-${crypto.randomUUID()}`,
            accountId: account.id,
            expiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true, accountId: true },
    });
    const now = new Date();
    return {
        accountId: account.id,
        admission,
        deletionInput: {
            accountId: account.id,
            challengeId: challenge.id,
            now,
            finalSweepAfter: new Date(now.getTime() - 1_000),
        },
    };
}

async function createCallbackApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async () => undefined);
    connectRoutes(typed);
    await typed.ready();
    return typed;
}

async function withSerializableRetry<T>(
    client: PrismaClient,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await client.$transaction(callback, serializableOptions);
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError
                && error.code === 'P2034'
                && attempt < 3
            ) continue;
            throw error;
        }
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
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

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}
