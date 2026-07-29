import { MMKV } from 'react-native-mmkv';
import { AppSyncV4DiagnosticStore } from './syncV4Diagnostics';

const syncV4DiagnosticStorage = new MMKV({ id: 'sync-v4-diagnostics' });

export const appSyncV4Diagnostics = new AppSyncV4DiagnosticStore(syncV4DiagnosticStorage);
