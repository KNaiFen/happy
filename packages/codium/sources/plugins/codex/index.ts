import type { AuthState, Plugin, PluginContext } from '../types'

/**
 * Codex authentication is handled by the bundled Codex CLI.
 */
class CodexPlugin implements Plugin {
    id = 'codex'
    name = 'Codex'
    description = 'Sign in with your ChatGPT account for the bundled Codex CLI.'
    vendor = 'OpenAI'
    category = 'inference' as const
    accent = '#10a37f'

    private auth: AuthState = { status: 'unconfigured' }

    async activate(_ctx: PluginContext) {
        try {
            const snap = await window.codexAuth.status()
            if (snap.status === 'connected') {
                this.auth = { status: 'connected', account: snap.email }
            }
        } catch {
            /* codexAuth IPC not available — leave unconfigured. */
        }
    }

    async connect(ctx: PluginContext): Promise<AuthState> {
        try {
            this.auth = { status: 'connecting' }
            ctx.onAuthChanged()
            const snap = await window.codexAuth.login()
            if (snap.status !== 'connected') {
                this.auth = { status: 'error', message: 'Login finished but no tokens were written.' }
                ctx.onAuthChanged()
                return this.auth
            }
            this.auth = { status: 'connected', account: snap.email }
            ctx.onAuthChanged()
            return this.auth
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.auth = { status: 'error', message: msg }
            ctx.onAuthChanged()
            return this.auth
        }
    }

    async disconnect(ctx: PluginContext) {
        try { await window.codexAuth.logout() } catch {}
        this.auth = { status: 'unconfigured' }
        ctx.onAuthChanged()
    }

    getAuthState(): AuthState { return this.auth }
}

export const codexPlugin: Plugin = new CodexPlugin()
