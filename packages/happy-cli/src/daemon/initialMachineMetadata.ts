import os from 'node:os';
import type { MachineMetadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { detectCLIAvailability } from '@/utils/detectCLI';
import packageJson from '../../package.json';

// Keep metadata construction independent from daemon/run so Gateway workers
// do not evaluate the daemon lifecycle module merely to register the machine.
const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';

export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: {
    rpcAvailable: true,
    codexThreadHistoryRpcAvailable: true,
    preflightRpcAvailable: true,
    requiresSameMachine: true,
    detectedAt: Date.now(),
  },
};
