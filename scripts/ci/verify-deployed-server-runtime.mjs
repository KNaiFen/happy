#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const productionRootArgument = process.argv[2];

if (!productionRootArgument) {
    throw new Error("usage: verify-deployed-server-runtime.mjs <production-root>");
}

const productionRoot = path.resolve(productionRootArgument);
const runtimePath = path.join(productionRoot, "dist", "standalone.mjs");
const prismaEntryPath = path.join(productionRoot, "node_modules", "@prisma", "client", "default.js");
const generatedPrismaPath = path.join(productionRoot, "node_modules", ".prisma", "client", "index.js");

for (const requiredPath of [runtimePath, prismaEntryPath, generatedPrismaPath]) {
    if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
        throw new Error(`deployed runtime file is missing: ${requiredPath}`);
    }
}

const runtime = await import(pathToFileURL(runtimePath).href);
if (typeof runtime.runMigrations !== "function" || typeof runtime.serve !== "function") {
    throw new Error("deployed standalone runtime must export runMigrations and serve");
}

const prismaClient = await import(pathToFileURL(prismaEntryPath).href);
if (typeof prismaClient.PrismaClient !== "function") {
    throw new Error("deployed PrismaClient is not initialized");
}

const expectedRelationshipStatuses = ["none", "requested", "pending", "friend", "rejected"];
const actualRelationshipStatuses = Object.values(prismaClient.RelationshipStatus ?? {});
if (
    actualRelationshipStatuses.length !== expectedRelationshipStatuses.length
    || expectedRelationshipStatuses.some(status => !actualRelationshipStatuses.includes(status))
) {
    throw new Error("deployed Prisma client is missing the RelationshipStatus enum");
}

console.log(`Verified deployed Server runtime at ${productionRoot}`);
