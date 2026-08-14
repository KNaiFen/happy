import { AuthCredentials } from '@/auth/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { signAuthChallenge } from '@/auth/authChallenge';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { serverFetch } from './serverTransport';
import { z } from 'zod';

const DeletionChallengeSchema = z.object({
    challengeId: z.string(),
    challenge: z.string(),
    expiresAt: z.number(),
});

const DeletionResultSchema = z.object({
    status: z.enum(['deleted', 'pending']),
});

export type AccountDeletionResult = 'deleted' | 'pending' | 'uncertain';

type AccountDeletionOptions = {
    beforeProofSubmission?: () => Promise<void>;
};

/**
 * Account deletion deliberately performs no automatic retry: a confirmed proof is
 * single-use, and the server persists any accepted deletion for its own retries.
 */
export async function deleteAccount(
    credentials: AuthCredentials,
    options: AccountDeletionOptions = {},
): Promise<AccountDeletionResult> {
    const endpoint = getServerUrl();
    const headers = {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'X-Happy-Client': getHappyClientId(),
    };
    const challengeResponse = await serverFetch(`${endpoint}/v1/account/deletion-challenge`, {
        method: 'POST',
        headers,
    });
    if (!challengeResponse.ok) {
        if (challengeResponse.status === 409) {
            // Another device has already committed this account to deletion.
            // Treat that durable server state as authoritative and fail closed
            // locally before reporting the pending outcome.
            await options.beforeProofSubmission?.();
            return 'pending';
        }
        throw new Error(`Failed to create account deletion proof: ${challengeResponse.status}`);
    }
    const challenge = DeletionChallengeSchema.parse(await challengeResponse.json());
    if (challenge.expiresAt <= Date.now()) {
        throw new Error('Account deletion proof expired');
    }

    const secret = decodeBase64(credentials.secret, 'base64url');
    if (secret.length !== 32) {
        secret.fill(0);
        throw new Error('Invalid account secret');
    }
    let challengeBytes: Uint8Array | null = null;
    let signed: ReturnType<typeof signAuthChallenge> | null = null;
    try {
        challengeBytes = decodeBase64(challenge.challenge);
        signed = signAuthChallenge(secret, challengeBytes);
        // The local revocation fence is the last step before the one-time proof
        // can leave this process. Challenge failures therefore keep the account
        // locally usable, while every proof outcome remains fail-closed.
        await options.beforeProofSubmission?.();
        const body = JSON.stringify({
            challengeId: challenge.challengeId,
            challenge: encodeBase64(signed.challenge),
            publicKey: encodeBase64(signed.publicKey),
            signature: encodeBase64(signed.signature),
        });
        let deletionResponse: Response;
        try {
            deletionResponse = await serverFetch(`${endpoint}/v1/account`, {
                method: 'DELETE',
                headers,
                body,
            });
        } catch {
            // Once the one-time proof leaves this client, a transport failure cannot
            // distinguish "not received" from "accepted and response lost". The
            // safe client state is to clear local credentials rather than claim the
            // account is still usable.
            return 'uncertain';
        }
        if (!deletionResponse.ok) {
            if (deletionResponse.status === 408 || deletionResponse.status === 429 || deletionResponse.status >= 500) {
                return 'uncertain';
            }
            throw new Error(`Failed to delete account: ${deletionResponse.status}`);
        }
        try {
            return DeletionResultSchema.parse(await deletionResponse.json()).status;
        } catch {
            return 'uncertain';
        }
    } finally {
        signed?.challenge.fill(0);
        signed?.publicKey.fill(0);
        signed?.signature.fill(0);
        challengeBytes?.fill(0);
        secret.fill(0);
    }
}
