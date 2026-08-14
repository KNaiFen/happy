/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * Integration suites provision their own isolated environments. Any suite
 * that needs packaged output must build it explicitly before Vitest starts.
 */

export async function setup() {
    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS = '1'
}

export async function teardown() {
    // Per-suite integration environments clean themselves up.
}
