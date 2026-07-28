import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getHappyClientId } from "@/sync/apiSocket";
import { serverFetch } from "@/sync/serverTransport";

export async function authAccountApprove(token: string, publicKey: Uint8Array, answer: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const response = await serverFetch(`${API_ENDPOINT}/v1/auth/account/response`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            publicKey: encodeBase64(publicKey),
            response: encodeBase64(answer),
        }),
    });
    if (!response.ok) throw new Error(`Authentication approval failed: ${response.status}`);
}
