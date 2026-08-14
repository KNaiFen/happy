import { decryptBox, decryptSecretBox, encryptBox, encryptSecretBox } from "@/encryption/libsodium";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decodeUTF8, encodeUTF8 } from "@/encryption/text";
import { decryptAESGCMString, encryptAESGCMString } from "@/encryption/aes";

//
// IMPORTANT: Right now there is a bug in the AES implementation and it works only with a normal strings converted to Uint8Array. 
// Any abnormal string might break encoding and decoding utf8.
//

export interface Encryptor {
    encrypt(data: any[]): Promise<Uint8Array[]>;
}

export interface Decryptor {
    decrypt(data: Uint8Array[]): Promise<(any | null)[]>;
}

export interface DisposableEncryption {
    dispose(): void;
}

function clearBytes(value: Uint8Array | null | undefined): void {
    value?.fill(0);
}

export class SecretBoxEncryption implements Encryptor, Decryptor, DisposableEncryption {
    private secretKey: Uint8Array;
    private disposed = false;

    constructor(secretKey: Uint8Array) {
        this.secretKey = secretKey;
    }

    async decrypt(data: Uint8Array[]): Promise<(any | null)[]> {
        if (this.disposed) return data.map(() => null);
        // Process as batch, not Promise.all - more efficient
        const results: (any | null)[] = [];
        for (const item of data) {
            results.push(decryptSecretBox(item, this.secretKey));
        }
        return results;
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        if (this.disposed) throw new Error('Encryption has been disposed');
        // Process as batch, not Promise.all - more efficient
        const results: Uint8Array[] = [];
        for (const item of data) {
            results.push(encryptSecretBox(item, this.secretKey));
        }
        return results;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        clearBytes(this.secretKey);
    }
}

export class BoxEncryption implements Encryptor, Decryptor, DisposableEncryption {
    private privateKey: Uint8Array;
    private publicKey: Uint8Array;
    private disposed = false;

    constructor(seed: Uint8Array) {
        // Use the seed to generate a proper keypair
        const keypair = sodium.crypto_box_seed_keypair(seed);
        this.privateKey = keypair.privateKey;
        this.publicKey = keypair.publicKey;
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        if (this.disposed) throw new Error('Encryption has been disposed');
        // Process as batch, not Promise.all - more efficient
        const results: Uint8Array[] = [];
        for (const item of data) {
            results.push(encryptBox(encodeUTF8(JSON.stringify(item)), this.publicKey));
        }
        return results;
    }

    async decrypt(data: Uint8Array[]): Promise<(any | null)[]> {
        if (this.disposed) return data.map(() => null);
        // Process as batch, not Promise.all - more efficient
        const results: (any | null)[] = [];
        for (const item of data) {
            let decrypted = decryptBox(item, this.privateKey);
            if (!decrypted) {
                results.push(null);
                continue;
            }
            results.push(JSON.parse(decodeUTF8(decrypted)));
        }
        return results;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        clearBytes(this.privateKey);
        clearBytes(this.publicKey);
    }
}

export class AES256Encryption implements Encryptor, Decryptor, DisposableEncryption {
    private secretKey: Uint8Array;
    private secretKeyB64: string;
    private disposed = false;

    constructor(secretKey: Uint8Array) {
        // The caller owns the lifecycle buffer. Keep a private copy so a
        // subsequent refresh can clear its map without breaking this context.
        this.secretKey = secretKey.slice();
        this.secretKeyB64 = encodeBase64(secretKey);
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        if (this.disposed) throw new Error('Encryption has been disposed');
        // Process as batch, not Promise.all - more efficient
        const results: Uint8Array[] = [];
        for (const item of data) {
            // Serialize to JSON string first
            const encrypted = decodeBase64(await encryptAESGCMString(JSON.stringify(item), this.secretKeyB64));
            let output = new Uint8Array(encrypted.length + 1);
            output[0] = 0;
            output.set(encrypted, 1);
            results.push(output);
        }
        return results;
    }

    async decrypt(data: Uint8Array[]): Promise<(any | null)[]> {
        if (this.disposed) return data.map(() => null);
        // Decrypt items concurrently. The previous implementation used a
        // sequential for-await loop, which serialised every AES-GCM call on
        // the JS thread. For a 1000-message session that meant ~1000
        // serialised crypto operations before the UI could display anything.
        // Promise.all schedules them on the microtask queue, allowing the
        // crypto subtle backend (and any native bridge work) to interleave.
        return Promise.all(data.map(async (item) => {
            try {
                if (item[0] !== 0) {
                    return null;
                }
                const decryptedString = await decryptAESGCMString(encodeBase64(item.slice(1)), this.secretKeyB64);
                if (!decryptedString) {
                    return null;
                }
                return JSON.parse(decryptedString);
            } catch (error) {
                return null;
            }
        }));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        clearBytes(this.secretKey);
        this.secretKeyB64 = '';
    }
}
