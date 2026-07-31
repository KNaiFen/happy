import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { writeCredentialsLegacy, readCredentials, updateSettings, Credentials, writeCredentialsDataKey } from "@/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { openBrowser } from "@/utils/browser";
import { AuthSelector, AuthMethod } from "./ink/AuthSelector";
import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';

export type AuthRequestStage = 'create' | 'status' | 'claim';

export type AuthRetryEvent = {
    stage: AuthRequestStage;
    code: string | undefined;
    status: number | undefined;
    attempt: number;
    delayMs: number;
};

type AuthStatusResponse = {
    status: 'not_found' | 'pending' | 'authorized';
    supportsV2: boolean;
};

type AuthClaimResponse = {
    state: 'authorized';
    token: string;
    response: string;
};

type AuthRetryOptions = {
    maxAttempts?: number;
    random?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    signal?: AbortSignal;
    onRetry?: (event: AuthRetryEvent) => void;
};

const AUTH_POLL_INTERVAL_MS = 1_000;
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_MAX_RETRY_DELAY_MS = 10_000;
const TRANSIENT_AUTH_CODES = new Set([
    'ECONNABORTED',
    'ECONNRESET',
    'EPIPE',
    'ERR_NETWORK',
    'ETIMEDOUT',
]);

export class AuthRequestError extends Error {
    readonly stage: AuthRequestStage;
    readonly code: string | undefined;
    readonly status: number | undefined;
    readonly attempts: number;
    readonly transient: boolean;

    constructor(options: {
        stage: AuthRequestStage;
        code?: string;
        status?: number;
        attempts: number;
        transient: boolean;
        reason?: 'request' | 'protocol';
        cause?: unknown;
    }) {
        super(`Authentication ${options.stage} ${options.reason ?? 'request'} failed`, {
            cause: options.cause,
        });
        this.name = 'AuthRequestError';
        this.stage = options.stage;
        this.code = options.code;
        this.status = options.status;
        this.attempts = options.attempts;
        this.transient = options.transient;
    }
}

function abortError(): Error {
    const error = new Error('Authentication cancelled');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw abortError();
    }
}

function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function authErrorMetadata(error: unknown): {
    code: string | undefined;
    status: number | undefined;
    retryAfter: string | undefined;
    transient: boolean;
} {
    if (!axios.isAxiosError(error)) {
        return { code: undefined, status: undefined, retryAfter: undefined, transient: false };
    }
    const status = error.response?.status;
    const code = typeof error.code === 'string' ? error.code : undefined;
    const rawRetryAfter = error.response?.headers?.['retry-after'];
    const retryAfter = typeof rawRetryAfter === 'string' ? rawRetryAfter : undefined;
    return {
        code,
        status,
        retryAfter,
        transient: TRANSIENT_AUTH_CODES.has(code ?? '')
            || status === 408
            || status === 429
            || (status !== undefined && status >= 500),
    };
}

function retryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
    if (!value) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1_000, AUTH_MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(value);
    if (Number.isNaN(date)) {
        return undefined;
    }
    return Math.min(Math.max(date - now, 0), AUTH_MAX_RETRY_DELAY_MS);
}

export async function runAuthRequestWithRetry<T>(
    stage: AuthRequestStage,
    request: () => Promise<T>,
    options: AuthRetryOptions = {},
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? AUTH_MAX_ATTEMPTS;
    const random = options.random ?? Math.random;
    const sleep = options.sleep ?? (delayMs => sleepWithSignal(delayMs, options.signal));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(options.signal);
        try {
            return await request();
        } catch (error) {
            throwIfAborted(options.signal);
            const metadata = authErrorMetadata(error);
            if (!metadata.transient || attempt === maxAttempts) {
                throw new AuthRequestError({
                    stage,
                    code: metadata.code,
                    status: metadata.status,
                    attempts: attempt,
                    transient: metadata.transient,
                    cause: error,
                });
            }
            const exponentialCeiling = Math.min(250 * (2 ** (attempt - 1)), AUTH_MAX_RETRY_DELAY_MS);
            const delayMs = retryAfterMs(metadata.retryAfter)
                ?? Math.floor(Math.max(0, Math.min(random(), 1)) * exponentialCeiling);
            options.onRetry?.({
                stage,
                code: metadata.code,
                status: metadata.status,
                attempt,
                delayMs,
            });
            await sleep(delayMs);
            throwIfAborted(options.signal);
        }
    }

    throw new AuthRequestError({ stage, attempts: maxAttempts, transient: true });
}

function parseAuthStatus(value: unknown): AuthStatusResponse {
    if (
        typeof value === 'object'
        && value !== null
        && 'status' in value
        && (value.status === 'not_found' || value.status === 'pending' || value.status === 'authorized')
        && 'supportsV2' in value
        && typeof value.supportsV2 === 'boolean'
    ) {
        return value as AuthStatusResponse;
    }
    throw new AuthRequestError({
        stage: 'status',
        attempts: 1,
        transient: false,
        reason: 'protocol',
    });
}

function parseAuthClaim(value: unknown): AuthClaimResponse {
    if (
        typeof value === 'object'
        && value !== null
        && 'state' in value
        && value.state === 'authorized'
        && 'token' in value
        && typeof value.token === 'string'
        && 'response' in value
        && typeof value.response === 'string'
    ) {
        return value as AuthClaimResponse;
    }
    throw new AuthRequestError({
        stage: 'claim',
        attempts: 1,
        transient: false,
        reason: 'protocol',
    });
}

export async function pollAuthRequest(options: {
    status: () => Promise<unknown>;
    claim: () => Promise<unknown>;
    sleep?: (delayMs: number) => Promise<void>;
    random?: () => number;
    signal?: AbortSignal;
    onPending?: () => void;
    onRetry?: (event: AuthRetryEvent) => void;
}): Promise<AuthClaimResponse> {
    const sleep = options.sleep ?? (delayMs => sleepWithSignal(delayMs, options.signal));
    await sleep(AUTH_POLL_INTERVAL_MS);
    throwIfAborted(options.signal);

    while (true) {
        const status = parseAuthStatus(await runAuthRequestWithRetry('status', options.status, {
            sleep,
            random: options.random,
            signal: options.signal,
            onRetry: options.onRetry,
        }));
        if (status.status === 'not_found') {
            throw new AuthRequestError({
                stage: 'status',
                attempts: 1,
                transient: false,
                reason: 'protocol',
            });
        }
        if (status.status === 'authorized') {
            return parseAuthClaim(await runAuthRequestWithRetry('claim', options.claim, {
                sleep,
                random: options.random,
                signal: options.signal,
                onRetry: options.onRetry,
            }));
        }
        options.onPending?.();
        await sleep(AUTH_POLL_INTERVAL_MS);
        throwIfAborted(options.signal);
    }
}

function logAuthRetry(event: AuthRetryEvent): void {
    logger.debug('[AUTH] Retrying authentication request', event);
}

function logAuthFailure(error: unknown): void {
    if (error instanceof AuthRequestError) {
        logger.debug('[AUTH] Authentication request failed', {
            stage: error.stage,
            code: error.code,
            status: error.status,
            attempts: error.attempts,
            transient: error.transient,
        });
        return;
    }
    logger.debug('[AUTH] Authentication failed without request metadata');
}

export async function doAuth(): Promise<Credentials | null> {
    console.clear();

    // Show authentication method selector
    const authMethod = await selectAuthenticationMethod();
    if (!authMethod) {
        console.log('\nAuthentication cancelled.\n');
        process.exit(0);
    }

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

    // Create a new authentication request
    const publicKey = encodeBase64(keypair.publicKey);
    try {
        await runAuthRequestWithRetry('create', async () => {
            await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
                publicKey,
                supportsV2: true,
            }, {
                headers: {
                    'X-Happy-Client': `cli/${configuration.currentCliVersion}`,
                },
            });
        }, { onRetry: logAuthRetry });
    } catch (error) {
        logAuthFailure(error);
        console.log('Failed to create authentication request, please try again later.');
        return null;
    }

    // Handle authentication based on selected method
    if (authMethod === 'mobile') {
        return await doMobileAuth(keypair);
    } else {
        return await doWebAuth(keypair);
    }
}

/**
 * Display authentication method selector and return user choice
 */
function selectAuthenticationMethod(): Promise<AuthMethod | null> {
    return new Promise((resolve) => {
        let hasResolved = false;

        const onSelect = (method: AuthMethod) => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(method);
            }
        };

        const onCancel = () => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(null);
            }
        };

        const app = render(React.createElement(AuthSelector, { onSelect, onCancel }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    });
}

/**
 * Handle mobile authentication flow
 */
async function doMobileAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nMobile Authentication\n');
    console.log('Scan this QR code with your Happy mobile app:\n');

    const authUrl = 'happy://terminal?' + encodeBase64Url(keypair.publicKey);
    displayQRCode(authUrl);

    console.log('\nOr manually enter this URL:');
    console.log(authUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nWeb Authentication\n');

    const webUrl = generateWebAuthUrl(keypair.publicKey);
    console.log('Opening your browser...');

    const browserOpened = await openBrowser(webUrl);

    if (browserOpened) {
        console.log('✓ Browser opened\n');
        console.log('Complete authentication in your browser window.');
    } else {
        console.log('Could not open browser automatically.');
    }

    // I changed this to always show the URL because we got a report from
    // someone running happy inside a devcontainer that they saw the
    // "Complete authentication in your browser window." but nothing opened.
    // https://github.com/slopus/happy/issues/19
    console.log('\nIf the browser did not open, please copy and paste this URL:');
    console.log(webUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Wait for authentication to complete and return credentials
 */
async function waitForAuthentication(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    process.stdout.write('Waiting for authentication');
    let dots = 0;
    const abortController = new AbortController();
    const publicKey = encodeBase64(keypair.publicKey);

    // Handle Ctrl-C during waiting
    const handleInterrupt = () => {
        process.off('SIGINT', handleInterrupt);
        abortController.abort();
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };

    process.on('SIGINT', handleInterrupt);

    try {
        const response = await pollAuthRequest({
            signal: abortController.signal,
            onRetry: logAuthRetry,
            status: async () => {
                const result = await axios.get(`${configuration.serverUrl}/v1/auth/request/status`, {
                    params: { publicKey },
                    headers: {
                        'X-Happy-Client': `cli/${configuration.currentCliVersion}`,
                    },
                    signal: abortController.signal,
                });
                return result.data;
            },
            claim: async () => {
                const result = await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
                    publicKey,
                    supportsV2: true,
                }, {
                    headers: {
                        'X-Happy-Client': `cli/${configuration.currentCliVersion}`,
                    },
                    signal: abortController.signal,
                });
                return result.data;
            },
            onPending: () => {
                process.stdout.write('\rWaiting for authentication' + '.'.repeat((dots % 3) + 1) + '   ');
                dots += 1;
            },
        });

        let encryptedResponse: Uint8Array;
        try {
            encryptedResponse = decodeBase64(response.response);
        } catch {
            console.log('\n\nFailed to decrypt response. Please try again.');
            return null;
        }
        const decrypted = decryptWithEphemeralKey(encryptedResponse, keypair.secretKey);
        if (!decrypted) {
            console.log('\n\nFailed to decrypt response. Please try again.');
            return null;
        }
        if (decrypted.length === 32) {
            const credentials = {
                secret: decrypted,
                token: response.token,
            };
            await writeCredentialsLegacy(credentials);
            console.log('\n\n✓ Authentication successful\n');
            return {
                encryption: {
                    type: 'legacy',
                    secret: decrypted,
                },
                token: response.token,
                serverOrigin: configuration.serverUrl,
            };
        }
        if (decrypted.length >= 33 && decrypted[0] === 0) {
            const credentials = {
                publicKey: decrypted.slice(1, 33),
                machineKey: randomBytes(32),
                token: response.token,
            };
            await writeCredentialsDataKey(credentials);
            console.log('\n\n✓ Authentication successful\n');
            return {
                encryption: {
                    type: 'dataKey',
                    publicKey: credentials.publicKey,
                    machineKey: credentials.machineKey,
                },
                token: response.token,
                serverOrigin: configuration.serverUrl,
            };
        }
        console.log('\n\nFailed to decrypt response. Please try again.');
        return null;
    } catch (error) {
        if ((error as Error).name === 'AbortError') {
            return null;
        }
        logAuthFailure(error);
        console.log('\n\nFailed to check authentication status. Please try again.');
        return null;
    } finally {
        process.off('SIGINT', handleInterrupt);
    }
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    // Extract components from bundle: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);

    const decrypted = tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted) {
        return null;
    }

    return decrypted;
}


/**
 * Ensure authentication and machine setup
 * This replaces the onboarding flow and ensures everything is ready
 */
export async function authAndSetupMachineIfNeeded(options: {
    skipRelayProbeForBoundCredentials?: boolean;
} = {}): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials = await readCredentials();
    let newAuth = false;

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }
    credentials = await scopeCredentialsToCurrentRelay(credentials, {
        skipProbeForBoundOrigin: options.skipRelayProbeForBoundCredentials,
    });

    // Make sure we have a machine ID
    // Server machine entity will be created either by the daemon or by the CLI
    const settings = await updateSettings(async s => {
        if (newAuth || !s.machineId) {
            return {
                ...s,
                machineId: randomUUID()
            };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);

    return { credentials, machineId: settings.machineId! };
}

export async function scopeCredentialsToCurrentRelay(
    credentials: Credentials,
    options: { skipProbeForBoundOrigin?: boolean } = {},
): Promise<Credentials> {
    const currentOrigin = configuration.serverUrl;
    if (credentials.serverOrigin && credentials.serverOrigin !== currentOrigin) {
        throw new Error(
            `Happy credentials are bound to ${credentials.serverOrigin}, not ${currentOrigin}. `
            + 'Run `happy auth login --force` for the configured relay.',
        );
    }
    const needsOriginBinding = credentials.serverOrigin === undefined;
    if (options.skipProbeForBoundOrigin && !needsOriginBinding) {
        return credentials;
    }

    try {
        await axios.get(`${currentOrigin}/v1/account/settings`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Happy-Client': `cli/${configuration.currentCliVersion}`,
            },
            timeout: 10_000,
        });
    } catch (error) {
        if (
            axios.isAxiosError(error)
            && (error.response?.status === 401 || error.response?.status === 403)
        ) {
            throw new Error(
                `Happy authentication is not valid for ${currentOrigin}. `
                + 'Run `happy auth login --force` for the configured relay.',
            );
        }
        logger.debug('[AUTH] Could not verify legacy credential relay origin yet', {
            serverOrigin: currentOrigin,
            status: axios.isAxiosError(error) ? error.response?.status : undefined,
        });
        return credentials;
    }

    if (!needsOriginBinding) {
        return credentials;
    }
    if (credentials.encryption.type === 'legacy') {
        await writeCredentialsLegacy({
            secret: credentials.encryption.secret,
            token: credentials.token,
        });
    } else {
        await writeCredentialsDataKey({
            publicKey: credentials.encryption.publicKey,
            machineKey: credentials.encryption.machineKey,
            token: credentials.token,
        });
    }
    return {
        ...credentials,
        serverOrigin: currentOrigin,
    };
}
