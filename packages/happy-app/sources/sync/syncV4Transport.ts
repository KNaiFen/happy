import { apiSocket } from './apiSocket';
import { AppSyncV4HttpTransport } from './syncV4HttpTransportCore';

export {
    AppSyncV4HttpTransport,
    type AppSyncV4HttpRequest,
} from './syncV4HttpTransportCore';

export class HttpAppSyncV4Transport extends AppSyncV4HttpTransport {
    constructor() {
        super((path, init) => apiSocket.request(path, init));
    }
}
