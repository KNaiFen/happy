export interface RpcSocketScope {
    clientType?: 'session-scoped' | 'user-scoped' | 'machine-scoped';
    credentialId?: string;
    sessionId?: string;
    machineId?: string;
}

function hasScopePrefix(method: string, scopeId: string | undefined): boolean {
    if (!scopeId) return false;
    const prefix = `${scopeId}:`;
    return method.startsWith(prefix) && method.length > prefix.length;
}

export function canRegisterRpcMethod(
    scope: RpcSocketScope,
    method: string,
): boolean {
    if (!scope.credentialId) return false;
    if (scope.clientType === 'machine-scoped') {
        return hasScopePrefix(method, scope.machineId);
    }
    if (scope.clientType === 'session-scoped') {
        return hasScopePrefix(method, scope.sessionId);
    }
    return false;
}

export function canCallRpcMethod(
    scope: RpcSocketScope,
    method: string,
): boolean {
    if (scope.credentialId) return false;
    if (!scope.clientType || scope.clientType === 'user-scoped') return true;
    if (scope.clientType === 'session-scoped') {
        return hasScopePrefix(method, scope.sessionId);
    }
    return false;
}
