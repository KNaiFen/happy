export function shouldAllowE2EBootstrap(
    isDev: boolean,
    mobileFieldE2E: boolean,
): boolean {
    return isDev || mobileFieldE2E;
}

export function shouldEnableDevE2eInsecureHttp(
    isDev: boolean,
    value: string | undefined,
    mobileFieldE2E = false,
): boolean {
    return shouldAllowE2EBootstrap(isDev, mobileFieldE2E) && value === '1';
}
