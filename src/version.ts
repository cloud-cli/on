import packageJson from '../package.json' with { type: 'json' };

export const RUNNER_VERSION = packageJson.version;
