import { defineConfig } from '@microsoft/tui-test';

export default defineConfig({
    workers: 1,
    retries: 0,
    timeout: 3 * 60 * 1_000,
    globalTimeout: 8 * 60 * 1_000,
    expect: {
        timeout: 120_000,
    },
    trace: true,
    traceFolder: process.env.HAPPY_GATEWAY_TUI_TRACE_DIR ?? 'tui-traces',
});
