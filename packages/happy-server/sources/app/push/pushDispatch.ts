/**
 * Push notification dispatch.
 *
 * Single entry point: dispatchSessionEventPush — rich session-event
 * ("It's ready!", permission, question) called by CLI/daemon clients.
 *
 * Generic per-message pushes were removed: the CLI streams every assistant
 * chunk, tool_use, and tool_result as a session message, so notifying on each
 * insert produced one buzz every 10s during a turn with no useful title.
 * Connected clients still receive the realtime message update over socket;
 * only the Expo push for "new message" went away.
 *
 * Suppression: if the user has ANY non-machine client that is active
 * (connected + not backgrounded), suppress the push — they can see in-app
 * indicators (unread dots, tab title counter) instead.
 *
 * "Active" is determined by socket.data.appState:
 *   - Clients send `app-state: { state: 'active' | 'background' }` via socket.
 *   - Old clients that never send it are treated as active (connected = present).
 *   - On disconnect the socket (and its state) disappears automatically.
 */

import { isUserActive } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { log } from "@/utils/log";
import { inTx } from "@/storage/inTx";
import { acquireAccountRead, acquireAccountWrite } from "@/app/account/accountWriteGate";
import { diagnosticHash } from "@/utils/diagnosticHash";

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}): Promise<void> {
    const diagnosticFields = {
        module: 'push',
        userHash: diagnosticHash(params.userId),
        sessionHash: diagnosticHash(params.sessionId),
    };
    // All push tokens are mobile — web/CLI never register Expo tokens.
    const tokens = await inTx(async (tx) => {
        if (!await acquireAccountRead(tx, params.userId)) return null;
        return tx.accountPushToken.findMany({
            where: {
                accountId: params.userId,
                account: { is: { deletionRequestedAt: null } },
            }
        });
    });

    if (!tokens || tokens.length === 0) {
        log({ ...diagnosticFields, outcome: 'skipped', tokenCount: 0 }, 'Push dispatch completed');
        return;
    }

    const tickets = await sendPushNotifications(
        tokens.map(t => ({
            to: t.token,
            title: params.title,
            body: params.body,
            data: params.data,
            sound: 'default' as const,
            channelId: params.channelId
        }))
    );

    let okCount = 0;
    let failedCount = 0;
    let deviceNotRegisteredCount = 0;
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
            okCount++;
            continue;
        }
        failedCount++;
        if (ticket.details?.error === 'DeviceNotRegistered') {
            deviceNotRegisteredCount++;
            void inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, params.userId)) return;
                await tx.accountPushToken.deleteMany({
                    where: { id: tokens[i].id, accountId: params.userId }
                });
            });
        }
    }

    if (failedCount === 0) {
        log({ ...diagnosticFields, outcome: 'success', okCount, failedCount }, 'Push dispatch completed');
    } else {
        log({
            ...diagnosticFields,
            level: 'warn',
            outcome: 'partial',
            okCount,
            failedCount,
            deviceNotRegisteredCount,
        }, 'Push dispatch completed');
    }
}

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, sessionId, title, body, data } = params;
    const diagnosticFields = {
        module: 'push',
        userHash: diagnosticHash(userId),
        sessionHash: diagnosticHash(sessionId),
    };

    try {
        try {
            if (await isUserActive(userId)) {
                log({ ...diagnosticFields, outcome: 'suppressed' }, 'Push dispatch completed');
                return;
            }
        } catch {
            log({ ...diagnosticFields, level: 'error', operation: 'presence.check' }, 'Push prerequisite failed');
        }

        await fetchTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages'
        });
    } catch {
        log({ ...diagnosticFields, level: 'error', operation: 'push.send' }, 'Push dispatch failed');
    }
}
