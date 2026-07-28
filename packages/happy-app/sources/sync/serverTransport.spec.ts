import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerUrlPolicyError } from './serverUrlPolicy';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    assertServerUrlAllowed: vi.fn(),
    getAllowInsecureHttp: vi.fn(),
    getServerUrl: vi.fn(),
    getServerUrlRuntime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

vi.mock('./serverConfig', () => ({
    assertServerUrlAllowed: mocks.assertServerUrlAllowed,
    getAllowInsecureHttp: mocks.getAllowInsecureHttp,
    getServerUrl: mocks.getServerUrl,
    getServerUrlRuntime: mocks.getServerUrlRuntime,
}));

import {
    commitServerTransportPolicy,
    serverFetch,
} from './serverTransport';

describe('Tauri server transport policy lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.assertServerUrlAllowed.mockReturnValue('http://192.168.1.20:3005');
        mocks.getAllowInsecureHttp.mockReturnValue(true);
        mocks.getServerUrl.mockReturnValue('http://192.168.1.20:3005');
        mocks.getServerUrlRuntime.mockReturnValue('tauri');
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'relay_http_request') {
                return {
                    status: 204,
                    statusText: 'No Content',
                    url: 'http://192.168.1.20:3005/v4/capabilities',
                    headers: [],
                    bodyBase64: '',
                };
            }
            return undefined;
        });
    });

    it('commits policy explicitly and keeps ordinary requests read-only', async () => {
        await commitServerTransportPolicy();
        await serverFetch('http://192.168.1.20:3005/v4/capabilities');
        await serverFetch('http://192.168.1.20:3005/v4/capabilities');

        expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
            'relay_http_set_policy',
            'relay_http_request',
            'relay_http_request',
        ]);
        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'relay_http_set_policy', {
            policy: {
                baseUrl: 'http://192.168.1.20:3005',
                allowInsecureHttp: true,
            },
        });
    });

    it('clears a stale native policy before reporting a blocked configuration', async () => {
        const error = new ServerUrlPolicyError('insecureHttpNotAllowed');
        mocks.assertServerUrlAllowed.mockImplementation(() => {
            throw error;
        });

        await expect(commitServerTransportPolicy()).rejects.toBe(error);
        expect(mocks.invoke).toHaveBeenCalledOnce();
        expect(mocks.invoke).toHaveBeenCalledWith('relay_http_clear_policy');
    });

    it('serializes policy commits and reads the latest configuration after acquiring the lock', async () => {
        let configuredUrl = 'http://192.168.1.20:3005';
        let releaseFirstCommit!: () => void;
        const firstCommitBlocked = new Promise<void>((resolve) => {
            releaseFirstCommit = resolve;
        });
        mocks.assertServerUrlAllowed.mockImplementation(() => configuredUrl);
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'relay_http_set_policy' && mocks.invoke.mock.calls.length === 1) {
                await firstCommitBlocked;
            }
            return undefined;
        });

        const firstCommit = commitServerTransportPolicy();
        await vi.waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledOnce();
        });

        configuredUrl = 'http://192.168.1.21:3005';
        const secondCommit = commitServerTransportPolicy();
        await Promise.resolve();
        expect(mocks.invoke).toHaveBeenCalledOnce();

        releaseFirstCommit();
        await Promise.all([firstCommit, secondCommit]);
        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'relay_http_set_policy', {
            policy: {
                baseUrl: 'http://192.168.1.20:3005',
                allowInsecureHttp: true,
            },
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'relay_http_set_policy', {
            policy: {
                baseUrl: 'http://192.168.1.21:3005',
                allowInsecureHttp: true,
            },
        });
    });
});
