import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { z } from 'zod';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { createAccountFetch } from './accountOutboundFence';

const PushTokenSchema = z.object({
    id: z.string(),
    token: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const PushTokenListResponseSchema = z.object({
    tokens: z.array(PushTokenSchema),
});

export type PushToken = z.infer<typeof PushTokenSchema>;

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    const accountFetch = createAccountFetch(credentials.token);
    await backoff(async () => {
        const response = await accountFetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({ token })
        });

        if (!response.ok) {
            throw new Error(`Failed to register push token: ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to register push token');
        }
    });
}

export async function fetchPushTokens(credentials: AuthCredentials): Promise<PushToken[]> {
    const API_ENDPOINT = getServerUrl();
    const accountFetch = createAccountFetch(credentials.token);
    return backoff(async () => {
        const response = await accountFetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch push tokens: ${response.status}`);
        }

        const data = await response.json();
        return PushTokenListResponseSchema.parse(data).tokens;
    });
}

export async function unregisterPushToken(
    credentials: AuthCredentials,
    token: string,
    options?: { allowAfterRevocation?: boolean },
): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    const allowAfterRevocation = options?.allowAfterRevocation === true;
    const accountFetch = allowAfterRevocation
        ? fetch
        : createAccountFetch(credentials.token);
    const request = async () => {
        const response = await accountFetch(`${API_ENDPOINT}/v1/push-tokens/${encodeURIComponent(token)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to unregister push token: ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to unregister push token');
        }
    };

    // Normal logout has already revoked the local account lifecycle. Its
    // best-effort cleanup may bypass that fence once, but must never retain
    // old credentials in an unbounded background retry loop.
    if (allowAfterRevocation) {
        await request();
        return;
    }
    await backoff(request);
}
