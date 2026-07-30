export function createAuthenticatedRequestHeaders(
    token: string,
    clientId: string,
    additionalHeaders?: HeadersInit,
): Headers {
    const headers = new Headers(additionalHeaders);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Happy-Client', clientId);
    return headers;
}
