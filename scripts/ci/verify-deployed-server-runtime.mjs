#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";

const productionRootArgument = process.argv[2];

if (!productionRootArgument) {
    throw new Error("usage: verify-deployed-server-runtime.mjs <production-root>");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const productionRoot = path.resolve(productionRootArgument);
const runtimePath = path.join(productionRoot, "dist", "standalone.mjs");
const prismaEntryPath = path.join(productionRoot, "node_modules", "@prisma", "client", "default.js");
const generatedPrismaPath = path.join(productionRoot, "node_modules", ".prisma", "client", "index.js");

function readPackageJson(packageRoot, label) {
    const packagePath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
        throw new Error(`${label} package metadata is missing: ${packagePath}`);
    }
    return JSON.parse(fs.readFileSync(packagePath, "utf8"));
}

function installedPackageRoot(packageName) {
    return path.join(productionRoot, "node_modules", ...packageName.split("/"));
}

for (const requiredPath of [runtimePath, prismaEntryPath, generatedPrismaPath]) {
    if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
        throw new Error(`deployed runtime file is missing: ${requiredPath}`);
    }
}

const sourcePackage = readPackageJson(
    path.join(repositoryRoot, "packages", "happy-server"),
    "source Server",
);
const deployedPackage = readPackageJson(productionRoot, "deployed Server");
const exactRuntimeDependencies = [
    "@electric-sql/pglite",
    "@prisma/client",
    "pglite-prisma-adapter",
    "prisma",
];
const testOnlyCompatibilityAliases = [
    "pglite-0316",
    "pglite-prisma-adapter-072",
];

for (const dependencyName of exactRuntimeDependencies) {
    const sourceVersion = sourcePackage.dependencies?.[dependencyName];
    if (!semver.valid(sourceVersion)) {
        throw new Error(
            `source Server must pin ${dependencyName} to an exact stable version; found ${sourceVersion ?? "missing"}`,
        );
    }

    const deployedVersion = deployedPackage.dependencies?.[dependencyName];
    if (deployedVersion !== sourceVersion) {
        throw new Error(
            `deployed Server declares ${dependencyName}@${deployedVersion ?? "missing"}; expected ${sourceVersion}`,
        );
    }

    const installedPackage = readPackageJson(
        installedPackageRoot(dependencyName),
        `installed ${dependencyName}`,
    );
    if (installedPackage.version !== sourceVersion) {
        throw new Error(
            `deployed Server installed ${dependencyName}@${installedPackage.version}; expected ${sourceVersion}`,
        );
    }
}

for (const alias of testOnlyCompatibilityAliases) {
    if (fs.existsSync(installedPackageRoot(alias))) {
        throw new Error(`test-only compatibility dependency leaked into production: ${alias}`);
    }
}

const adapterPackage = readPackageJson(
    installedPackageRoot("pglite-prisma-adapter"),
    "installed pglite-prisma-adapter",
);
for (const peerName of ["@electric-sql/pglite", "@prisma/client"]) {
    const peerRange = adapterPackage.peerDependencies?.[peerName];
    const peerVersion = readPackageJson(
        installedPackageRoot(peerName),
        `installed ${peerName}`,
    ).version;
    if (typeof peerRange !== "string" || !semver.satisfies(peerVersion, peerRange)) {
        throw new Error(
            `pglite-prisma-adapter@${adapterPackage.version} requires ${peerName}@${peerRange ?? "missing"}, but ${peerVersion} is installed`,
        );
    }
}

const driverUtilsRange = adapterPackage.dependencies?.["@prisma/driver-adapter-utils"];
const driverUtilsPackage = readPackageJson(
    installedPackageRoot("@prisma/driver-adapter-utils"),
    "installed @prisma/driver-adapter-utils",
);
if (
    typeof driverUtilsRange !== "string"
    || !semver.satisfies(driverUtilsPackage.version, driverUtilsRange)
) {
    throw new Error(
        `pglite-prisma-adapter@${adapterPackage.version} requires @prisma/driver-adapter-utils@${driverUtilsRange ?? "missing"}, but ${driverUtilsPackage.version} is installed`,
    );
}
const prismaClientVersion = sourcePackage.dependencies["@prisma/client"];
if (semver.major(driverUtilsPackage.version) !== semver.major(prismaClientVersion)) {
    throw new Error(
        `Prisma driver adapter major ${driverUtilsPackage.version} is incompatible with @prisma/client@${prismaClientVersion}`,
    );
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
