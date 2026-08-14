import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const {
    authMock,
    beginGithubOAuthAdmissionMock,
    claimGithubOAuthAdmissionMock,
    settleGithubOAuthAdmissionMock,
    githubConnectMock,
    fetchMock,
} = vi.hoisted(() => ({
    authMock: {
        createGithubToken: vi.fn(async () => 'signed-state'),
        verifyGithubToken: vi.fn(),
    },
    beginGithubOAuthAdmissionMock: vi.fn(),
    claimGithubOAuthAdmissionMock: vi.fn(),
    settleGithubOAuthAdmissionMock: vi.fn(),
    githubConnectMock: vi.fn(),
    fetchMock: vi.fn(),
}));

vi.mock('@/app/auth/auth', () => ({ auth: authMock }));
vi.mock('@/app/account/githubOAuthAdmission', () => ({
    beginGithubOAuthAdmission: beginGithubOAuthAdmissionMock,
    claimGithubOAuthAdmission: claimGithubOAuthAdmissionMock,
    settleGithubOAuthAdmission: settleGithubOAuthAdmissionMock,
}));
vi.mock('@/app/github/githubConnect', () => ({ githubConnect: githubConnectMock }));
vi.mock('@/app/github/githubDisconnect', () => ({ githubDisconnect: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/storage/inTx', () => ({ inTx: vi.fn() }));
vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountRead: vi.fn(),
    acquireAccountWrite: vi.fn(),
}));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { emitUpdate: vi.fn() } }));
vi.mock('@/modules/encrypt', () => ({
    decryptString: vi.fn(),
    encryptString: vi.fn(),
}));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { connectRoutes } from './connectRoutes';

const accountId = 'account-1';
const admissionId = 'admission-1';
const callbackUrl = '/v1/connect/github/callback?code=github-code&state=signed-state';
const admission = { id: admissionId, accountId };

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = accountId;
    });
    connectRoutes(typed);
    await typed.ready();
    return typed;
}

function response(ok: boolean, body: unknown): Pick<Response, 'ok' | 'json'> {
    return { ok, json: vi.fn(async () => body) };
}

describe('GitHub OAuth account deletion admission routes', () => {
    let app: Fastify;
    const originalEnv = {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        redirectUrl: process.env.GITHUB_REDIRECT_URL,
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.GITHUB_CLIENT_ID = 'client-id';
        process.env.GITHUB_CLIENT_SECRET = 'client-secret';
        process.env.GITHUB_REDIRECT_URL = 'https://server.example/callback';
        authMock.verifyGithubToken.mockResolvedValue({ userId: accountId, admissionId });
        beginGithubOAuthAdmissionMock.mockResolvedValue({ admission, state: 'signed-state' });
        claimGithubOAuthAdmissionMock.mockResolvedValue(true);
        settleGithubOAuthAdmissionMock.mockResolvedValue(undefined);
        githubConnectMock.mockResolvedValue(undefined);
        vi.stubGlobal('fetch', fetchMock);
        app = await createApp();
    });

    afterEach(async () => {
        await app?.close();
        vi.unstubAllGlobals();
        if (originalEnv.clientId === undefined) delete process.env.GITHUB_CLIENT_ID;
        else process.env.GITHUB_CLIENT_ID = originalEnv.clientId;
        if (originalEnv.clientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
        else process.env.GITHUB_CLIENT_SECRET = originalEnv.clientSecret;
        if (originalEnv.redirectUrl === undefined) delete process.env.GITHUB_REDIRECT_URL;
        else process.env.GITHUB_REDIRECT_URL = originalEnv.redirectUrl;
    });

    it('does not sign OAuth state when account deletion wins admission', async () => {
        beginGithubOAuthAdmissionMock.mockResolvedValueOnce(null);

        const result = await app.inject({ method: 'GET', url: '/v1/connect/github/params' });

        expect(result.statusCode).toBe(409);
        expect(result.json()).toEqual({ error: 'Account deletion in progress' });
        expect(authMock.createGithubToken).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not exchange code, fetch profile, connect, or settle on claim failure and replay', async () => {
        claimGithubOAuthAdmissionMock.mockResolvedValue(false);

        const first = await app.inject({ method: 'GET', url: callbackUrl });
        const replay = await app.inject({ method: 'GET', url: callbackUrl });

        expect(first.statusCode).toBe(302);
        expect(first.headers.location).toBe('https://app.happy.engineering?error=invalid_state');
        expect(replay.statusCode).toBe(302);
        expect(claimGithubOAuthAdmissionMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(githubConnectMock).not.toHaveBeenCalled();
        expect(settleGithubOAuthAdmissionMock).not.toHaveBeenCalled();
    });

    it('settles a claimed callback after token, profile, and connection success', async () => {
        fetchMock
            .mockResolvedValueOnce(response(true, { access_token: 'github-access-token' }))
            .mockResolvedValueOnce(response(true, { id: 42, login: 'happy-coder' }));

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe(
            'https://app.happy.engineering?github=connected&user=happy-coder',
        );
        expect(githubConnectMock).toHaveBeenCalledWith(
            expect.objectContaining({ uid: accountId }),
            expect.objectContaining({ id: 42, login: 'happy-coder' }),
            'github-access-token',
        );
        expect(settleGithubOAuthAdmissionMock).toHaveBeenCalledOnce();
        expect(settleGithubOAuthAdmissionMock).toHaveBeenCalledWith(admission);
    });

    it('settles a claimed callback when OAuth configuration is missing', async () => {
        delete process.env.GITHUB_CLIENT_SECRET;

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe('https://app.happy.engineering?error=server_config');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(githubConnectMock).not.toHaveBeenCalled();
        expect(settleGithubOAuthAdmissionMock).toHaveBeenCalledWith(admission);
    });

    it('leaves a claimed callback unresolved when the token POST outcome is unknown', async () => {
        fetchMock.mockRejectedValueOnce(new Error('hostile-token-provider-error'));

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe('https://app.happy.engineering?error=server_error');
        expect(settleGithubOAuthAdmissionMock).not.toHaveBeenCalled();
    });

    it('leaves a claimed callback unresolved when the token response cannot be parsed', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: vi.fn(async () => {
                throw new Error('hostile-token-response-error');
            }),
        });

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe('https://app.happy.engineering?error=server_error');
        expect(settleGithubOAuthAdmissionMock).not.toHaveBeenCalled();
    });

    it.each([
        ['HTTP failure', response(false, { error: 'provider-failure' })],
        ['structured failure', response(true, { error: 'bad_verification_code' })],
        ['missing access token', response(true, {})],
    ])('settles a claimed callback after a known token %s', async (_name, tokenResponse) => {
        fetchMock.mockResolvedValueOnce(tokenResponse);

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe(
            'https://app.happy.engineering?error=github_token_exchange_failed',
        );
        expect(githubConnectMock).not.toHaveBeenCalled();
        expect(settleGithubOAuthAdmissionMock).toHaveBeenCalledWith(admission);
    });

    it('settles a claimed callback after a known profile HTTP failure', async () => {
        fetchMock
            .mockResolvedValueOnce(response(true, { access_token: 'github-access-token' }))
            .mockResolvedValueOnce(response(false, { message: 'provider-failure' }));

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe(
            'https://app.happy.engineering?error=github_user_fetch_failed',
        );
        expect(githubConnectMock).not.toHaveBeenCalled();
        expect(settleGithubOAuthAdmissionMock).toHaveBeenCalledWith(admission);
    });

    it.each([
        ['profile request', async () => {
            fetchMock
                .mockResolvedValueOnce(response(true, { access_token: 'github-access-token' }))
                .mockRejectedValueOnce(new Error('hostile-profile-provider-error'));
        }],
        ['connection', async () => {
            fetchMock
                .mockResolvedValueOnce(response(true, { access_token: 'github-access-token' }))
                .mockResolvedValueOnce(response(true, { id: 42, login: 'happy-coder' }));
            githubConnectMock.mockRejectedValueOnce(new Error('hostile-connect-provider-error'));
        }],
    ])('settles a claimed callback after a %s exception', async (_name, arrange) => {
        await arrange();

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe('https://app.happy.engineering?error=server_error');
        expect(settleGithubOAuthAdmissionMock).toHaveBeenCalledWith(admission);
    });

    it('fails closed when durable callback settlement cannot be recorded', async () => {
        fetchMock
            .mockResolvedValueOnce(response(true, { access_token: 'github-access-token' }))
            .mockResolvedValueOnce(response(true, { id: 42, login: 'happy-coder' }));
        settleGithubOAuthAdmissionMock.mockRejectedValueOnce(new Error('settlement unavailable'));

        const result = await app.inject({ method: 'GET', url: callbackUrl });

        expect(result.statusCode).toBe(500);
        expect(settleGithubOAuthAdmissionMock).toHaveBeenCalledWith(admission);
    });
});
