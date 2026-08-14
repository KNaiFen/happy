export class BackoffAbortError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BackoffAbortError';
    }
}
