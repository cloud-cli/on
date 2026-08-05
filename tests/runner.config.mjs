import { SecretStore } from '@cloud-cli/on';
import { JsonFileReporter } from '@cloud-cli/on/reporters/json-file';
import { SlackReporter } from '@cloud-cli/on/reporters/slack';
import { createSlackPlugin } from '@cloud-cli/on/plugin/slack';

// 1. Load secrets locally on host startup
const secrets = new SecretStore('./.env');

export default {
  // SQLite HTTP endpoint connection
  sqliteUrl: process.env.SQLITE_HTTP_URL || 'https://server.example.com',

  // Storage for workspace layers & artifacts
  storagePath: '/var/runner/workspaces',

  // 2. Register execution drivers / plugins with scoped secrets
  plugins: [
    createSlackPlugin({
      token: secrets.get('SLACK_BOT_TOKEN'), // Only Slack plugin gets this token!
    }),
  ],

  // 3. Register global execution reporters
  reporters: [
    new JsonFileReporter({
      outputDir: '/var/runner/reports',
    }),
    new SlackReporter({
      token: secrets.get('SLACK_BOT_TOKEN'),
      channel: '#ci-cd-deployments',
      notifyOn: ['success', 'failed'], // Report both successes and failures
    }),
  ],
};
