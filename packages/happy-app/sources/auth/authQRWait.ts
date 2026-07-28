import { decodeBase64, encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { QRAuthKeyPair } from './authQRStart';
import { decryptBox } from '@/encryption/libsodium';
import { getHappyClientId } from '@/sync/apiSocket';
import { serverFetch } from '@/sync/serverTransport';

export interface AuthCredentials {
    secret: Uint8Array;
    token: string;
}

export async function authQRWait(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean): Promise<AuthCredentials | null> {
    let dots = 0;
    const serverUrl = getServerUrl();

    while (true) {
        if (shouldCancel && shouldCancel()) {
            return null;
        }

        try {
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
                throw new Error(`Authentication status failed: ${response.status}`);
            }
            const data = await response.json() as {
                state: string;
                token?: string;
                response?: string;
            };

            if (data.state === 'authorized' && data.token && data.response) {
                const token = data.token;
                const encryptedResponse = decodeBase64(data.response);
                
                const decrypted = decryptBox(encryptedResponse, keypair.secretKey);
                if (decrypted) {
                    console.log('\n\n✓ Authentication successful\n');
                    return {
                        secret: decrypted,
                        token: token
                    };
                } else {
                    console.log('\n\nFailed to decrypt response. Please try again.');
                    return null;
                }
            }
        } catch (error) {
            console.log('\n\nFailed to check authentication status. Please try again.');
            return null;
        }

        // Call progress callback if provided
        if (onProgress) {
            onProgress(dots);
        }
        dots++;

        // Wait 1 second before next check
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
