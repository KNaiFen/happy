import { authChallenge } from "./authChallenge";
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getHappyClientId } from "@/sync/apiSocket";
import { serverFetch } from "@/sync/serverTransport";

export async function authGetToken(secret: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await serverFetch(`${API_ENDPOINT}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            challenge: encodeBase64(challenge),
            signature: encodeBase64(signature),
            publicKey: encodeBase64(publicKey),
        }),
    });
    if (!response.ok) throw new Error(`Authentication failed: ${response.status}`);
    const data = await response.json() as { token: string };
    return data.token;
}
