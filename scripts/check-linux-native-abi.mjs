#!/usr/bin/env node
/**
 * Rejects Linux release addons that require a newer glibc than the supported
 * floor, or a dynamic GCC Toolset runtime absent from a stock RHEL/Rocky 8
 * host. Run against build-tarball.mjs's staging directory inside Linux CI.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const GLIBC_FLOOR = [2, 28];
const root = process.argv[2];
if (root === undefined) fail('usage: check-linux-native-abi.mjs <staging-directory>');

const nativeFiles = findNativeFiles(resolve(root));
if (nativeFiles.length === 0) fail(`no native addons found below ${root}`);

for (const nativeFile of nativeFiles) {
  const versions = execFileSync('readelf', ['--version-info', nativeFile], { encoding: 'utf8' });
  const glibcVersions = [...versions.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
  if (glibcVersions.length === 0) fail(`${nativeFile} declares no readable glibc versions`);

  const newest = glibcVersions.reduce((left, right) =>
    compareVersions(left, right) > 0 ? left : right,
  );
  if (compareVersions(newest, GLIBC_FLOOR) > 0) {
    fail(`${nativeFile} requires GLIBC_${newest.join('.')}; the release floor is GLIBC_2.28`);
  }
  if (/\b(?:GLIBCXX|CXXABI)_/.test(versions)) {
    fail(`${nativeFile} dynamically requires the GCC Toolset C++ runtime`);
  }
  console.log(`native ABI: ${nativeFile} (GLIBC_${newest.join('.')}, C++ runtime static)`);
}

function findNativeFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...findNativeFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.node')) files.push(path);
  }
  return files;
}

function compareVersions(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

function fail(message) {
  console.error(`check-linux-native-abi: ${message}`);
  process.exit(1);
}
