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

import { scopeCredentialsToCurrentRelay } from './auth';

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
