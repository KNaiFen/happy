import { io, Socket } from 'socket.io-client';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { storage } from './storage';
import { isTauri } from '@/utils/isTauri';
import { assertServerUrlAllowed } from './serverConfig';
import { serverFetch } from './serverTransport';
import { createAuthenticatedRequestHeaders } from './requestHeaders';
import {
    AccountOutboundCancelledError,
    assertAccountOutboundPermit,
    captureAccountOutboundPermit,
    type AccountOutboundPermit,
} from './accountOutboundFence';

export function getHappyClientId(): string {
    let platform: string = Platform.OS; // 'ios' | 'android' | 'web'
    if (isTauri()) {
        platform = 'desktop';
    }
    const version = Constants.expoConfig?.version || '0.0.0';
    return `${platform}/${version}`;
}

/**
 * Compute the current "active" or "background" state for the current platform.
 * Mobile uses AppState. Web/desktop uses document.visibilityState + window focus —
 * "active" means the tab is visible AND has focus, so a backgrounded tab or an
 * unfocused window correctly counts as background and won't suppress mobile pushes.
 */
export function getCurrentAppState(): 'active' | 'background' {
    if (Platform.OS === 'web') {
        if (typeof document === 'undefined') {
            return 'active';
        }
        const visible = document.visibilityState === 'visible';
        const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
        return visible && focused ? 'active' : 'background';
    }
    return AppState.currentState === 'active' ? 'active' : 'background';
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private lifecycleGeneration = 0;
    private accountPermit: AccountOutboundPermit | null = null;

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption): ApiSocketLifecyclePermit {
        this.lifecycleGeneration += 1;
        this.config = {
            ...config,
            endpoint: assertServerUrlAllowed(config.endpoint),
        };
        this.accountPermit = captureAccountOutboundPermit(config.token);
        this.encryption = encryption;
        this.connect();
        return this.captureLifecyclePermit();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        assertServerUrlAllowed(this.config.endpoint);
        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const,
                happyClient: getHappyClientId(),
                appState: getCurrentAppState(),
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
    }

    disconnect() {
        this.lifecycleGeneration += 1;
        const socket = this.socket;
        this.socket = null;
        socket?.disconnect();
        this.updateStatus('disconnected');
    }

    /**
     * End the current account lifecycle. Unlike disconnect(), reset removes
     * every credential-bearing reference and listener so a failed app reload
     * cannot leave the deleted account usable in memory.
     */
    reset() {
        this.disconnect();
        this.config = null;
        this.encryption = null;
        this.accountPermit = null;
        this.messageHandlers.clear();
        this.reconnectedListeners.clear();
        this.statusListeners.clear();
        this.currentStatus = 'disconnected';
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(
        sessionId: string,
        method: string,
        params: A,
        options: { timeoutMs?: number } = {},
    ): Promise<R> {
        const permit = this.captureLifecyclePermit();
        const encryption = this.encryption;
        const socket = this.socket;
        const sessionEncryption = encryption?.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${sessionId}`);
        }

        if (!socket) throw new Error('Socket not connected');
        const encryptedParams = await sessionEncryption.encryptRaw(params);
        this.assertLifecyclePermit(permit, socket, encryption);
        const emitter = options.timeoutMs === undefined
            ? socket
            : socket.timeout(options.timeoutMs);
        const result = await emitter.emitWithAck('rpc-call', {
            method: `${sessionId}:${method}`,
            params: encryptedParams,
        });

        this.assertLifecyclePermit(permit, socket, encryption);
        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(
        machineId: string,
        method: string,
        params: A,
        options: { timeoutMs?: number } = {},
    ): Promise<R> {
        const permit = this.captureLifecyclePermit();
        const encryption = this.encryption;
        const socket = this.socket;
        const machineEncryption = encryption?.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        if (!socket) throw new Error('Socket not connected');
        const encryptedParams = await machineEncryption.encryptRaw(params);
        this.assertLifecyclePermit(permit, socket, encryption);
        const emitter = options.timeoutMs === undefined
            ? socket
            : socket.timeout(options.timeoutMs);
        const result = await emitter.emitWithAck('rpc-call', {
            method: `${machineId}:${method}`,
            params: encryptedParams,
        });

        this.assertLifecyclePermit(permit, socket, encryption);
        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    /**
     * Sends app focus state to server for push notification routing.
     * Server uses this to suppress pushes when the mobile app is in foreground.
     */
    sendAppState(state: string, permit: ApiSocketLifecyclePermit): void {
        const socket = this.socket;
        if (!socket) throw new AccountOutboundCancelledError();
        this.assertLifecyclePermit(permit, socket, this.encryption);
        socket.emit('app-state', { state });
    }

    captureLifecyclePermit(): ApiSocketLifecyclePermit {
        const accountPermit = this.accountPermit;
        if (!accountPermit) throw new AccountOutboundCancelledError();
        assertAccountOutboundPermit(accountPermit);
        return {
            generation: this.lifecycleGeneration,
            accountPermit,
        };
    }

    async emitWithAck<T = any>(
        event: string,
        data: any,
        permit: ApiSocketLifecyclePermit = this.captureLifecyclePermit(),
    ): Promise<T> {
        const socket = this.socket;
        if (!socket) throw new Error('Socket not connected');
        this.assertLifecyclePermit(permit, socket, this.encryption);
        const result = await socket.emitWithAck(event, data);
        this.assertLifecyclePermit(permit, socket, this.encryption);
        return result;
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        const permit = this.captureLifecyclePermit();
        const config = this.config;
        if (!config) throw new Error('SyncSocket not initialized');

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }
        this.assertLifecyclePermit(permit, this.socket, this.encryption, false);
        if (credentials.token !== config.token || this.config !== config) {
            throw new AccountOutboundCancelledError();
        }

        const url = `${config.endpoint}${path}`;
        const headers = createAuthenticatedRequestHeaders(
            credentials.token,
            getHappyClientId(),
            options?.headers,
        );

        return serverFetch(url, {
            ...options,
            headers
        });
    }

    //
    // Private Methods
    //

    private isVerboseLogging(): boolean {
        try {
            return storage.getState().localSettings.verboseLogging;
        } catch {
            return false;
        }
    }

    private assertLifecyclePermit(
        permit: ApiSocketLifecyclePermit,
        socket: Socket | null,
        encryption: Encryption | null,
        requireSocket = true,
    ): void {
        assertAccountOutboundPermit(permit.accountPermit);
        if (
            permit.generation !== this.lifecycleGeneration
            || (requireSocket && (!socket || this.socket !== socket))
            || this.encryption !== encryption
        ) {
            throw new AccountOutboundCancelledError();
        }
    }

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private setupEventHandlers() {
        const socket = this.socket;
        if (!socket) return;
        const generation = this.lifecycleGeneration;
        const isCurrent = () => this.socket === socket && this.lifecycleGeneration === generation;

        // Connection events
        socket.on('connect', () => {
            if (!isCurrent()) return;
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Connected, recovered: ' + socket.recovered);
                console.log('🔌 SyncSocket: Socket ID:', socket.id);
            }
            this.updateStatus('connected');
            if (!socket.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        socket.on('disconnect', (reason) => {
            if (!isCurrent()) return;
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Disconnected', reason);
            }
            this.updateStatus('disconnected');
        });

        // Error events
        socket.on('connect_error', () => {
            if (!isCurrent()) return;
            if (this.isVerboseLogging()) {
                console.error('SyncSocket: Connection error');
            }
            this.updateStatus('error');
        });

        socket.on('error', () => {
            if (!isCurrent()) return;
            if (this.isVerboseLogging()) {
                console.error('SyncSocket: Error');
            }
            this.updateStatus('error');
        });

        // Message handling
        socket.onAny((event, data) => {
            if (!isCurrent()) return;
            if (this.isVerboseLogging()) {
                console.log(`SyncSocket: Received event '${event}'`);
            }
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();

export type ApiSocketLifecyclePermit = {
    readonly generation: number;
    readonly accountPermit: AccountOutboundPermit;
};
