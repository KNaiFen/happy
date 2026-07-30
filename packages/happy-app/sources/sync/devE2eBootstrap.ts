export function shouldEnableDevE2eInsecureHttp(
    isDev: boolean,
    value: string | undefined,
): boolean {
    return isDev && value === '1';
}
