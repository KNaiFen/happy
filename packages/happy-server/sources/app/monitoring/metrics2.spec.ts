import { describe, expect, it } from "vitest";
import {
    getMetricsLabelsFromRequest,
    getSyncV4MetricsLabelsFromRequest,
} from "./metrics2";

describe("metric client labels", () => {
    it("uses fixed client buckets instead of client-controlled versions", () => {
        const request = {
            headers: {
                "x-happy-client": "cli-coding-session/1.4.5",
            },
        };

        expect(getMetricsLabelsFromRequest(request)).toEqual({
            client: "cli-coding-session",
            client_type: "cli-coding-session",
        });
        expect(getSyncV4MetricsLabelsFromRequest(request)).toEqual({
            client_type: "cli-coding-session",
        });
    });

    it("buckets hostile and non-string labels as unknown without retaining plaintext", () => {
        const secret = "prompt-reasoning-tool-output-client-secret";
        const hostile = getMetricsLabelsFromRequest({
            headers: { "x-happy-client": `${secret}/999.999.999` },
        });
        const arrayValue = getMetricsLabelsFromRequest({
            headers: { "x-happy-client": [`web/1.11.10`, secret] },
        });

        expect(hostile).toEqual({ client: "unknown", client_type: "unknown" });
        expect(arrayValue).toEqual({ client: "unknown", client_type: "unknown" });
        expect(JSON.stringify([hostile, arrayValue])).not.toContain(secret);
    });
});
