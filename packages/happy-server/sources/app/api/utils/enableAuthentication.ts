import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            log({
                module: 'auth-decorator',
                path: request.routeOptions?.url,
                hasAuthorization: Boolean(authHeader),
            }, 'Auth check');
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return reply.code(401).send({ error: 'Invalid token' });
            }

            request.userId = verified.userId;
            request.authCredentialId = verified.credentialId;
            request.authMachineId = verified.machineId;
        } catch {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
