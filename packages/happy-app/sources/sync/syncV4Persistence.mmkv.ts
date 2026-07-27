import { MMKV } from 'react-native-mmkv';
import { randomUUID } from 'expo-crypto';
import { SyncV4Persistence } from './syncV4Persistence';

const syncV4Storage = new MMKV({ id: 'sync-v4' });

export const syncV4Persistence = new SyncV4Persistence(syncV4Storage, randomUUID);
