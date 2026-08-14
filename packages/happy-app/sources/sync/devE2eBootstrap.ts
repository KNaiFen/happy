export function shouldAllowE2EBootstrap(
    isDev: boolean,
    mobileFieldE2E: boolean,
    credentialsRevoked = false,
): boolean {
    return !credentialsRevoked && (isDev || mobileFieldE2E);
}

export function shouldEnableDevE2eInsecureHttp(
    isDev: boolean,
    value: string | undefined,
    mobileFieldE2E = false,
    credentialsRevoked = false,
): boolean {
    return shouldAllowE2EBootstrap(isDev, mobileFieldE2E, credentialsRevoked) && value === '1';
}

export function stripDevE2ECredentialsFromSearch(search: string): string {
    const params = new URLSearchParams(search);
    params.delete('dev_token');
    params.delete('dev_secret');
    const serialized = params.toString();
    return serialized ? `?${serialized}` : '';
}
