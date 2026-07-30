import { apiSocket } from './apiSocket';
import { AppSyncV4HttpTransport } from './syncV4HttpTransportCore';

export {
    AppSyncV4HttpTransport,
    type AppSyncV4HttpRequest,
} from './syncV4HttpTransportCore';

export class HttpAppSyncV4Transport extends AppSyncV4HttpTransport {
    constructor(machineId?: string | null) {
        const normalizedMachineId = machineId?.trim() || null;
        super((path, init = {}) => {
            const headers = new Headers(init.headers);
            if (normalizedMachineId) {
                headers.set('X-Happy-Machine-Id', normalizedMachineId);
            }
            return apiSocket.request(path, {
                ...init,
                headers,
            });
        });
    }
}
