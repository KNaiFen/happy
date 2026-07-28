import { getRandomBytes } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';
import { serverFetch } from '@/sync/serverTransport';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${serverUrl}/v1/auth/account/request`);
            console.log(`[AUTH DEBUG] Public key: ${encodeBase64(keypair.publicKey).substring(0, 20)}...`);
        }

        const response = await serverFetch(`${serverUrl}/v1/auth/account/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({
                publicKey: encodeBase64(keypair.publicKey),
            }),
        });
        if (!response.ok) {
            throw new Error(`Authentication request failed: ${response.status}`);
        }

        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Auth request sent successfully');
        }
        return true;
    } catch (error) {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Failed to send auth request:', error);
        }
        console.log('Failed to create authentication request, please try again later.');
        return false;
    }
}
