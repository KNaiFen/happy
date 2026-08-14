import { getMetricsLabelsFromSocket, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { buildUpdateArtifactUpdate, buildDeleteArtifactUpdate, eventRouter } from "@/app/events/eventRouter";
import { afterTx, inTx } from "@/storage/inTx";
import { allocateArtifactMutation } from "@/storage/seq";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import * as privacyKit from "privacy-kit";
import { acquireAccountRead, acquireAccountWrite } from "@/app/account/accountWriteGate";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { createArtifactForAccount } from "@/app/artifacts/artifactCreate";

function logArtifactFailure(operation: string, userId: string, artifactId: unknown): void {
    log({
        module: 'websocket',
        level: 'error',
        operation,
        userHash: diagnosticHash(userId),
        ...(typeof artifactId === 'string' ? { artifactHash: diagnosticHash(artifactId) } : {}),
    }, 'Artifact socket operation failed');
}

export function artifactUpdateHandler(userId: string, socket: Socket) {
    const labels = getMetricsLabelsFromSocket(socket);
    // Read artifact with full body
    socket.on('artifact-read', async (data: {
        artifactId: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-read', ...labels });

            const { artifactId } = data;

            // Validate input
            if (!artifactId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // Fetch artifact under the same account admission lock used by
            // deletion, so the marker cannot commit between authorization and
            // returning encrypted artifact data.
            const artifact = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return null;
                return tx.artifact.findFirst({
                    where: {
                        id: artifactId,
                        accountId: userId,
                        account: { is: { deletionRequestedAt: null } },
                    }
                });
            });

            if (!artifact) {
                if (callback) {
                    callback({ result: 'error', message: 'Artifact not found' });
                }
                return;
            }

            // Return artifact data
            callback({
                result: 'success',
                artifact: {
                    id: artifact.id,
                    header: privacyKit.encodeBase64(artifact.header),
                    headerVersion: artifact.headerVersion,
                    body: privacyKit.encodeBase64(artifact.body),
                    bodyVersion: artifact.bodyVersion,
                    seq: artifact.seq,
                    updateSeq: artifact.updateSeq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime()
                }
            });
        } catch {
            logArtifactFailure('artifact.read', userId, data?.artifactId);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Update artifact with optimistic concurrency control
    socket.on('artifact-update', async (data: {
        artifactId: string;
        header?: {
            data: string;
            expectedVersion: number;
        };
        body?: {
            data: string;
            expectedVersion: number;
        };
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-update', ...labels });

            const { artifactId, header, body } = data;

            // Validate input
            if (!artifactId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // At least one update must be provided
            if (!header && !body) {
                if (callback) {
                    callback({ result: 'error', message: 'No updates provided' });
                }
                return;
            }

            // Validate header structure if provided
            if (header && (typeof header.data !== 'string' || typeof header.expectedVersion !== 'number')) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid header parameters' });
                }
                return;
            }

            // Validate body structure if provided
            if (body && (typeof body.data !== 'string' || typeof body.expectedVersion !== 'number')) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid body parameters' });
                }
                return;
            }

            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return { kind: 'deleting' as const };
                const currentArtifact = await tx.artifact.findFirst({ where: { id: artifactId, accountId: userId, account: { is: { deletionRequestedAt: null } } } });
                if (!currentArtifact) return { kind: 'missing' as const };
                const headerMismatch = header && currentArtifact.headerVersion !== header.expectedVersion;
                const bodyMismatch = body && currentArtifact.bodyVersion !== body.expectedVersion;
                if (headerMismatch || bodyMismatch) return { kind: 'version-mismatch' as const, currentArtifact, headerMismatch: Boolean(headerMismatch), bodyMismatch: Boolean(bodyMismatch) };
                const updateData: any = { updatedAt: new Date(), seq: currentArtifact.seq + 1 };
                const headerUpdate = header ? { value: header.data, version: header.expectedVersion + 1 } : undefined;
                const bodyUpdate = body ? { value: body.data, version: body.expectedVersion + 1 } : undefined;
                if (headerUpdate) { updateData.header = privacyKit.decodeBase64(headerUpdate.value); updateData.headerVersion = headerUpdate.version; }
                if (bodyUpdate) { updateData.body = privacyKit.decodeBase64(bodyUpdate.value); updateData.bodyVersion = bodyUpdate.version; }
                const updated = await tx.artifact.updateMany({ where: { id: artifactId, accountId: userId, account: { is: { deletionRequestedAt: null } }, ...(header && { headerVersion: header.expectedVersion }), ...(body && { bodyVersion: body.expectedVersion }) }, data: updateData });
                if (updated.count !== 1) return { kind: 'version-mismatch' as const, currentArtifact, headerMismatch: Boolean(header), bodyMismatch: Boolean(body) };
                const { seq: updSeq } = await allocateArtifactMutation(userId, tx);
                await tx.artifact.updateMany({ where: { id: artifactId, accountId: userId }, data: { updateSeq: updSeq } });
                const updatePayload = buildUpdateArtifactUpdate(artifactId, currentArtifact.seq + 1, updSeq, randomKeyNaked(12), headerUpdate, bodyUpdate);
                afterTx(tx, () => eventRouter.emitUpdate({ userId, payload: updatePayload, recipientFilter: { type: 'user-scoped-only' } }));
                return { kind: 'updated' as const, headerUpdate, bodyUpdate, updateSeq: updSeq };
            });
            if (result.kind === 'deleting' || result.kind === 'missing') {
                callback?.({ result: 'error', message: 'Artifact not found' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                const response: any = { result: 'version-mismatch' };
                if (result.headerMismatch) response.header = { currentVersion: result.currentArtifact.headerVersion, currentData: privacyKit.encodeBase64(result.currentArtifact.header) };
                if (result.bodyMismatch) response.body = { currentVersion: result.currentArtifact.bodyVersion, currentData: privacyKit.encodeBase64(result.currentArtifact.body) };
                callback(response);
                return;
            }

            // Send success response
            const response: any = { result: 'success', updateSeq: result.updateSeq };
            
            if (result.headerUpdate) {
                response.header = {
                    version: result.headerUpdate.version,
                    data: header!.data
                };
            }
            
            if (result.bodyUpdate) {
                response.body = {
                    version: result.bodyUpdate.version,
                    data: body!.data
                };
            }
            
            callback(response);
        } catch {
            logArtifactFailure('artifact.update', userId, data?.artifactId);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Create new artifact
    socket.on('artifact-create', async (data: {
        id: string;
        header: string;
        body: string;
        dataEncryptionKey: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-create', ...labels });

            const { id, header, body, dataEncryptionKey } = data;

            // Validate input
            if (!id || typeof header !== 'string' || typeof body !== 'string' || typeof dataEncryptionKey !== 'string') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            const result = await createArtifactForAccount(userId, {
                id,
                header: privacyKit.decodeBase64(header),
                body: privacyKit.decodeBase64(body),
                dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
            });
            if (result.kind === 'deleting') { callback?.({ result: 'error', message: 'Artifact not found' }); return; }
            if (result.kind === 'conflict') { callback?.({ result: 'error', message: 'Artifact with this ID already exists for another account' }); return; }
            const artifact = result.artifact;

            // Return created artifact
            callback({
                result: 'success',
                artifact: {
                    id: artifact.id,
                    header: privacyKit.encodeBase64(artifact.header),
                    headerVersion: artifact.headerVersion,
                    body: privacyKit.encodeBase64(artifact.body),
                    bodyVersion: artifact.bodyVersion,
                    seq: artifact.seq,
                    updateSeq: result.updateSeq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime()
                }
            });
        } catch {
            logArtifactFailure('artifact.create', userId, data?.id);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Delete artifact
    socket.on('artifact-delete', async (data: {
        artifactId: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-delete', ...labels });

            const { artifactId } = data;

            // Validate input
            if (!artifactId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return false;
                const artifact = await tx.artifact.findFirst({ where: { id: artifactId, accountId: userId, account: { is: { deletionRequestedAt: null } } } });
                if (!artifact) return false;
                await tx.artifact.delete({ where: { id: artifactId } });
                const { seq: updSeq } = await allocateArtifactMutation(userId, tx);
                const deletePayload = buildDeleteArtifactUpdate(artifactId, updSeq, randomKeyNaked(12));
                afterTx(tx, () => eventRouter.emitUpdate({ userId, payload: deletePayload, recipientFilter: { type: 'user-scoped-only' } }));
                return updSeq;
            });
            if (!result) { callback?.({ result: 'error', message: 'Artifact not found' }); return; }

            // Send success response
            callback({ result: 'success', updateSeq: result });
        } catch {
            logArtifactFailure('artifact.delete', userId, data?.artifactId);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}
