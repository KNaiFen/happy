import { atom } from 'jotai'
import { useEffect, useState } from 'react'
import type { Plugin, PluginContext } from './types'

interface HostState {
    plugins: Plugin[]
    revision: number
}

let state: HostState = { plugins: [], revision: 0 }
const listeners = new Set<() => void>()

function emit() {
    state = { ...state, revision: state.revision + 1 }
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

function createContext(): PluginContext {
    return { onAuthChanged: emit }
}

/** Internal: only plugins/index.ts registers bundled integrations. */
export async function registerPlugin(plugin: Plugin): Promise<void> {
    if (state.plugins.some((existing) => existing.id === plugin.id)) {
        console.warn(`[plugins] duplicate id "${plugin.id}", skipping`)
        return
    }
    state = { plugins: [...state.plugins, plugin], revision: state.revision }
    try {
        await plugin.activate(createContext())
    } catch (error) {
        console.error(`[plugins] activate failed for "${plugin.id}"`, error)
    }
    emit()
}

export const pluginHost = {
    all(): readonly Plugin[] {
        return state.plugins
    },
    get(id: string): Plugin | undefined {
        return state.plugins.find((plugin) => plugin.id === id)
    },
    subscribe,
    async connect(id: string): Promise<void> {
        const plugin = pluginHost.get(id)
        if (!plugin) throw new Error(`unknown plugin: ${id}`)
        await plugin.connect(createContext())
        emit()
    },
    async disconnect(id: string): Promise<void> {
        const plugin = pluginHost.get(id)
        if (!plugin) return
        await plugin.disconnect(createContext())
        emit()
    },
}

const baseAtom = atom(0)
baseAtom.onMount = (set) => subscribe(() => set((revision) => revision + 1))

export const pluginsAtom = atom((get) => {
    get(baseAtom)
    return state.plugins
})

export function usePlugins(): readonly Plugin[] {
    const [, force] = useState(0)
    useEffect(() => subscribe(() => force((revision) => revision + 1)), [])
    return state.plugins
}

export function usePlugin(id: string): Plugin | undefined {
    return usePlugins().find((plugin) => plugin.id === id)
}
