import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    findSiblingServerPackagePathFromCliPackageRoot,
    resolveInstalledServerPackage,
    resolveServerArtifacts,
} from './server';

const artifactCommand = process.execPath;

function packageWithArtifact() {
    return {
        resolveServerArtifact: () => ({
            command: artifactCommand,
            cwd: path.dirname(artifactCommand),
        }),
    };
}

describe('happy-server package resolution', () => {
    it('prefers a normally resolvable local co-installation', () => {
        const loadPackage = vi.fn(() => packageWithArtifact());
        const resolvePackage = vi.fn(() => '/project/node_modules/happy-server-self-host/index.cjs');
        const artifact = resolveInstalledServerPackage({
            loadPackage,
            resolvePackage,
            siblingPackagePath: () => '/prefix/lib/node_modules/happy-server-self-host',
        });

        expect(artifact).toMatchObject({
            command: artifactCommand,
            source: 'package',
        });
        expect(loadPackage).toHaveBeenCalledExactlyOnceWith('happy-server-self-host');
    });

    it('loads the Unix global sibling after the normal package lookup fails', () => {
        const siblingPath = findSiblingServerPackagePathFromCliPackageRoot(
            '/prefix/lib/node_modules/happy',
        );
        const loadPackage = vi.fn((request: string) => {
            if (request === siblingPath) return packageWithArtifact();
            throw new Error('module not found');
        });
        const resolvePackage = vi.fn((request: string) => {
            if (request === siblingPath) return `${siblingPath}/index.cjs`;
            throw new Error('module not found');
        });

        const artifact = resolveInstalledServerPackage({
            loadPackage,
            resolvePackage,
            siblingPackagePath: () => siblingPath,
        });

        expect(siblingPath).toBe('/prefix/lib/node_modules/happy-server-self-host');
        expect(artifact).toMatchObject({ source: 'package' });
        expect(loadPackage).toHaveBeenNthCalledWith(1, 'happy-server-self-host');
        expect(loadPackage).toHaveBeenNthCalledWith(2, siblingPath);
    });

    it('derives the Windows global sibling from the active happy package root', () => {
        const siblingPath = findSiblingServerPackagePathFromCliPackageRoot(
            'C:\\Users\\runneradmin\\AppData\\Roaming\\npm\\node_modules\\happy',
            path.win32,
        );
        const loadPackage = vi.fn((request: string) => {
            if (request === siblingPath) return packageWithArtifact();
            throw new Error('module not found');
        });
        const resolvePackage = vi.fn((request: string) => {
            if (request === siblingPath) return `${siblingPath}\\index.cjs`;
            throw new Error('module not found');
        });

        const artifact = resolveInstalledServerPackage({
            loadPackage,
            resolvePackage,
            siblingPackagePath: () => siblingPath,
        });

        expect(siblingPath).toBe('C:\\Users\\runneradmin\\AppData\\Roaming\\npm\\node_modules\\happy-server-self-host');
        expect(artifact).toMatchObject({ source: 'package' });
        expect(loadPackage).toHaveBeenNthCalledWith(2, siblingPath);
    });

    it('falls back to monorepo source only after both package lookups fail', () => {
        const loadPackage = vi.fn(() => {
            throw new Error('module not found');
        });
        const resolvePackage = vi.fn(() => {
            throw new Error('module not found');
        });
        const packageArtifact = resolveInstalledServerPackage({
            loadPackage,
            resolvePackage,
            siblingPackagePath: () => '/prefix/lib/node_modules/happy-server-self-host',
        });
        const sourceEntry = '/workspace/packages/happy-server/sources/standalone.ts';
        const artifact = resolveServerArtifacts({
            resolveInstalledServerPackage: () => packageArtifact,
            resolveLegacyBundledServer: () => undefined,
            findSourceStandalone: () => sourceEntry,
            findTsxBinary: () => 'tsx',
        });

        expect(loadPackage).toHaveBeenNthCalledWith(1, 'happy-server-self-host');
        expect(loadPackage).toHaveBeenNthCalledWith(2, '/prefix/lib/node_modules/happy-server-self-host');
        expect(artifact).toEqual({
            command: 'tsx',
            prefixArgs: [sourceEntry],
            cwd: '/workspace/packages/happy-server',
            bundled: false,
            source: 'source',
        });
    });
});
