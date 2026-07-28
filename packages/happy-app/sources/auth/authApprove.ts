import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getHappyClientId } from "@/sync/apiSocket";
import { serverFetch } from "@/sync/serverTransport";

interface AuthRequestStatus {
    status: 'not_found' | 'pending' | 'authorized';
    supportsV2: boolean;
}

export async function authApprove(token: string, publicKey: Uint8Array, answerV1: Uint8Array, answerV2: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const publicKeyBase64 = encodeBase64(publicKey);
    
    // First, check the auth request status
    const query = new URLSearchParams({ publicKey: publicKeyBase64 });
    const statusResponse = await serverFetch(
        `${API_ENDPOINT}/v1/auth/request/status?${query.toString()}`,
        {
            headers: {
                'X-Happy-Client': getHappyClientId(),
            },
        },
    );
    if (!statusResponse.ok) {
        throw new Error(`Authentication status failed: ${statusResponse.status}`);
    }
    
    const { status, supportsV2 } = await statusResponse.json() as AuthRequestStatus;
    
    // Handle different status cases
    if (status === 'not_found') {
        // Already authorized, no need to approve again
        console.log('Auth request already authorized or not found');
        return;
    }
    
    if (status === 'authorized') {
        // Already authorized, no need to approve again
        console.log('Auth request already authorized');
        return;
    }
    
    // Handle pending status
    if (status === 'pending') {
        const response = await serverFetch(`${API_ENDPOINT}/v1/auth/response`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({
                publicKey: publicKeyBase64,
                response: supportsV2 ? encodeBase64(answerV2) : encodeBase64(answerV1),
            }),
        });
        if (!response.ok) {
            throw new Error(`Authentication approval failed: ${response.status}`);
        }
    }
}
