import packageJson from '../package.json';

interface PackageMetadata {
  version: string;
}

const { version } = packageJson as PackageMetadata;

export const appVersion = version;
