import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    dbMock,
    isUserActiveMock,
    sendPushNotificationsMock,
    acquireAccountReadMock,
    logMock,
} = vi.hoisted(() => ({
    dbMock: {
        accountPushToken: {
            findMany: vi.fn(),
            deleteMany: vi.fn(),
        },
    },
    isUserActiveMock: vi.fn(async () => false),
    sendPushNotificationsMock: vi.fn(),
    acquireAccountReadMock: vi.fn(async () => true),
    logMock: vi.fn(),
}));

vi.mock('@/storage/inTx', () => ({
    inTx: async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock),
}));
vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountRead: acquireAccountReadMock,
    acquireAccountWrite: vi.fn(async () => true),
}));
vi.mock('@/app/push/focusTracker', () => ({ isUserActive: isUserActiveMock }));
vi.mock('@/app/push/pushSend', () => ({ sendPushNotifications: sendPushNotificationsMock }));
vi.mock('@/utils/log', () => ({ log: logMock }));

import { dispatchSessionEventPush } from './pushDispatch';

describe('push dispatch account deletion admission', () => {
    beforeEach(() => {
        dbMock.accountPushToken.findMany.mockReset();
        dbMock.accountPushToken.deleteMany.mockReset();
        isUserActiveMock.mockReset();
        isUserActiveMock.mockResolvedValue(false);
        sendPushNotificationsMock.mockReset();
        acquireAccountReadMock.mockReset();
        acquireAccountReadMock.mockResolvedValue(true);
        logMock.mockReset();
    });

    it('does not read tokens or call Expo after the account gate closes', async () => {
        acquireAccountReadMock.mockResolvedValue(false);

        await dispatchSessionEventPush({
            userId: 'user-1',
            sessionId: 'session-1',
            title: 'Ready',
            body: 'Done',
        });

        expect(dbMock.accountPushToken.findMany).not.toHaveBeenCalled();
        expect(sendPushNotificationsMock).not.toHaveBeenCalled();
    });

    it('keeps push payloads, provider errors, tokens, and identifiers out of logs', async () => {
        const userId = 'prompt-reasoning-tool-output-user-id';
        const sessionId = 'prompt-reasoning-tool-output-session-id';
        const title = 'prompt-reasoning-tool-output-title';
        const body = 'prompt-reasoning-tool-output-body';
        const dataKey = 'prompt-reasoning-tool-output-data-key';
        const dataValue = 'prompt-reasoning-tool-output-data-value';
        const token = 'prompt-reasoning-tool-output-expo-token';
        const providerError = 'prompt-reasoning-tool-output-provider-error';
        dbMock.accountPushToken.findMany.mockResolvedValueOnce([{ id: 'token-1', token }]);
        sendPushNotificationsMock.mockResolvedValueOnce([{
            status: 'error',
            message: providerError,
            details: { error: providerError },
        }]);

        await dispatchSessionEventPush({
            userId,
            sessionId,
            title,
            body,
            data: { [dataKey]: dataValue },
        });

        expect(sendPushNotificationsMock).toHaveBeenCalledWith([expect.objectContaining({
            to: token,
            title,
            body,
            data: { sessionId, [dataKey]: dataValue },
        })]);
        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
            module: 'push',
            userHash: expect.any(String),
            sessionHash: expect.any(String),
            outcome: 'partial',
            okCount: 0,
            failedCount: 1,
            deviceNotRegisteredCount: 0,
        }), 'Push dispatch completed');
        const logs = JSON.stringify(logMock.mock.calls);
        for (const hostile of [userId, sessionId, title, body, dataKey, dataValue, token, providerError]) {
            expect(logs).not.toContain(hostile);
        }
    });
});
