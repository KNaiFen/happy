import packageJson from '../package.json';

export const HAPPY_AGENT_VERSION = packageJson.version;
export const HAPPY_AGENT_CLIENT_HEADER = `cli-control-plane/${HAPPY_AGENT_VERSION}`;
