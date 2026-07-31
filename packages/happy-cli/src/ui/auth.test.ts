import type { Credentials } from '@/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    axiosGet: vi.fn(),
    writeCredentialsLegacy: vi.fn(),
    writeCredentialsDataKey: vi.fn(),
    loggerDebug: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: mocks.axiosGet,
        post: vi.fn(),
        isAxiosError: (error: unknown) => (
            typeof error === 'object'
            && error !== null
            && (error as { isAxiosError?: boolean }).isAxiosError === true
        ),
    },
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://relay.example.test:3005',
        currentCliVersion: '1.4.7',
    },
}));

vi.mock('@/persistence', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/persistence')>();
    return {
        ...original,
        writeCredentialsLegacy: mocks.writeCredentialsLegacy,
        writeCredentialsDataKey: mocks.writeCredentialsDataKey,
    };
});

vi.mock('./logger', () => ({
    logger: {
        debug: mocks.loggerDebug,
    },
}));

import {
    AuthRequestError,
    pollAuthRequest,
    runAuthRequestWithRetry,
    scopeCredentialsToCurrentRelay,
    type AuthRetryEvent,
} from './auth';

function legacyCredentials(serverOrigin?: string): Credentials {
    return {
        token: 'test-token',
        ...(serverOrigin ? { serverOrigin } : {}),
        encryption: {
            type: 'legacy',
            secret: new Uint8Array(32).fill(5),
        },
    };
}

describe('scopeCredentialsToCurrentRelay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects credentials already bound to another relay without sending them', async () => {
        await expect(scopeCredentialsToCurrentRelay(
            legacyCredentials('https://api.cluster-fluster.com'),
        )).rejects.toThrow('happy auth login --force');
        expect(mocks.axiosGet).not.toHaveBeenCalled();
    });

    it('skips the duplicate relay probe for credentials already bound by the parent CLI', async () => {
        const credentials = legacyCredentials('http://relay.example.test:3005');

        await expect(scopeCredentialsToCurrentRelay(credentials, {
            skipProbeForBoundOrigin: true,
        })).resolves.toBe(credentials);
        expect(mocks.axiosGet).not.toHaveBeenCalled();
    });

    it('binds legacy credentials only after the current relay accepts them', async () => {
        mocks.axiosGet.mockResolvedValueOnce({ status: 200 });

        await expect(scopeCredentialsToCurrentRelay(legacyCredentials())).resolves.toEqual(
            expect.objectContaining({
                serverOrigin: 'http://relay.example.test:3005',
            }),
        );
        expect(mocks.axiosGet).toHaveBeenCalledWith(
            'http://relay.example.test:3005/v1/account/settings',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                }),
            }),
        );
        expect(mocks.writeCredentialsLegacy).toHaveBeenCalledOnce();
    });

    it('returns unbound credentials on a temporary relay failure', async () => {
        mocks.axiosGet.mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 503 },
        });
        const credentials = legacyCredentials();

        await expect(scopeCredentialsToCurrentRelay(credentials)).resolves.toBe(credentials);
        expect(mocks.writeCredentialsLegacy).not.toHaveBeenCalled();
    });

    it('turns an old token rejected by the new relay into an actionable auth error', async () => {
        mocks.axiosGet.mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 401 },
        });

        await expect(scopeCredentialsToCurrentRelay(legacyCredentials())).rejects.toThrow(
            'happy auth login --force',
        );
        expect(mocks.writeCredentialsLegacy).not.toHaveBeenCalled();
    });
});

function axiosError(status?: number, code?: string, retryAfter?: string): Error {
    return Object.assign(new Error('sensitive upstream message'), {
        isAxiosError: true,
        code,
        response: status === undefined ? undefined : {
            status,
            headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
        },
    });
}

describe('terminal authentication state machine', () => {
    it('waits for status authorization and claims credentials once', async () => {
        const status = vi.fn()
            .mockResolvedValueOnce({ status: 'pending', supportsV2: true })
            .mockResolvedValueOnce({ status: 'authorized', supportsV2: false });
        const claim = vi.fn().mockResolvedValue({
            state: 'authorized',
            token: 'token',
            response: 'encrypted',
        });
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(pollAuthRequest({ status, claim, sleep })).resolves.toEqual({
            state: 'authorized',
            token: 'token',
            response: 'encrypted',
        });
        expect(status).toHaveBeenCalledTimes(2);
        expect(claim).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('recovers when the first status request is reset', async () => {
        const status = vi.fn()
            .mockRejectedValueOnce(axiosError(undefined, 'ECONNRESET'))
            .mockResolvedValueOnce({ status: 'authorized', supportsV2: false });
        const claim = vi.fn().mockResolvedValue({
            state: 'authorized',
            token: 'token',
            response: 'encrypted',
        });

        await expect(pollAuthRequest({
            status,
            claim,
            sleep: vi.fn().mockResolvedValue(undefined),
            random: () => 0.5,
        })).resolves.toMatchObject({ state: 'authorized' });
        expect(status).toHaveBeenCalledTimes(2);
        expect(claim).toHaveBeenCalledTimes(1);
    });

    it('stops after five consecutive transient failures', async () => {
        const request = vi.fn().mockRejectedValue(axiosError(503, 'ERR_BAD_RESPONSE'));

        await expect(runAuthRequestWithRetry('status', request, {
            sleep: vi.fn().mockResolvedValue(undefined),
            random: () => 0,
        })).rejects.toMatchObject({
            name: 'AuthRequestError',
            stage: 'status',
            status: 503,
            attempts: 5,
            transient: true,
        });
        expect(request).toHaveBeenCalledTimes(5);
    });

    it('uses a bounded Retry-After value for 429', async () => {
        const request = vi.fn()
            .mockRejectedValueOnce(axiosError(429, 'ERR_BAD_REQUEST', '60'))
            .mockResolvedValueOnce('ok');
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(runAuthRequestWithRetry('claim', request, {
            sleep,
            random: () => 0,
        })).resolves.toBe('ok');
        expect(sleep).toHaveBeenCalledWith(10_000);
    });

    it('does not retry permanent authorization errors', async () => {
        const request = vi.fn().mockRejectedValue(axiosError(401, 'ERR_BAD_REQUEST'));
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(runAuthRequestWithRetry('claim', request, { sleep })).rejects.toMatchObject({
            stage: 'claim',
            status: 401,
            attempts: 1,
            transient: false,
        });
        expect(request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('reports only redacted retry metadata', async () => {
        const events: AuthRetryEvent[] = [];
        const request = vi.fn()
            .mockRejectedValueOnce(axiosError(undefined, 'ECONNRESET'))
            .mockResolvedValueOnce('ok');

        await runAuthRequestWithRetry('create', request, {
            sleep: vi.fn().mockResolvedValue(undefined),
            random: () => 0,
            onRetry: event => events.push(event),
        });

        expect(events).toEqual([{
            stage: 'create',
            code: 'ECONNRESET',
            status: undefined,
            attempt: 1,
            delayMs: 0,
        }]);
        expect(JSON.stringify(events)).not.toContain('sensitive upstream message');
    });

    it('treats malformed status and claim payloads as protocol errors', async () => {
        await expect(pollAuthRequest({
            status: async () => ({ status: 'mystery' }),
            claim: async () => ({ state: 'authorized', token: 'unused', response: 'unused' }),
            sleep: vi.fn().mockResolvedValue(undefined),
        })).rejects.toBeInstanceOf(AuthRequestError);

        await expect(pollAuthRequest({
            status: async () => ({ status: 'authorized', supportsV2: false }),
            claim: async () => ({ state: 'requested' }),
            sleep: vi.fn().mockResolvedValue(undefined),
        })).rejects.toMatchObject({ transient: false, stage: 'claim' });
    });

    it('aborts during the initial wait without checking status', async () => {
        const controller = new AbortController();
        const status = vi.fn();
        const sleep = vi.fn().mockImplementation(async () => controller.abort());

        await expect(pollAuthRequest({
            status,
            claim: vi.fn(),
            sleep,
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(status).not.toHaveBeenCalled();
    });
});
