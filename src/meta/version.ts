import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', '..', 'package.json');

interface PackageMetadata {
  name?: string;
  version?: string;
}

function readPackageMetadata(): PackageMetadata {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageMetadata;
  } catch {
    return {};
  }
}

const pkg = readPackageMetadata();

export const APP_NAME = pkg.name ?? 'symbiote';
export const APP_VERSION = pkg.version ?? '0.0.0';
export const RELEASE_CODENAME = 'Apex';
