/* Plugin host types for bundled integrations. */

export type PluginCategory = 'inference' | 'tools' | 'integrations'

export type AuthState =
    | { status: 'unconfigured' }
    | { status: 'connecting' }
    | { status: 'connected'; account?: string }
    | { status: 'error'; message: string }

export interface Plugin {
    id: string
    name: string
    description: string
    vendor: string
    category: PluginCategory
    icon?: string
    accent?: string

    activate(ctx: PluginContext): Promise<void> | void
    connect(ctx: PluginContext): Promise<AuthState>
    disconnect(ctx: PluginContext): Promise<void> | void
    getAuthState(): AuthState
}

export interface PluginContext {
    onAuthChanged(): void
}
