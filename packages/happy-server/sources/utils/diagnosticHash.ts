import { createHash } from "node:crypto";

export function diagnosticHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
