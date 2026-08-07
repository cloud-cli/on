import { SecretStore, SlackReporter } from '@cloud-cli/on';

// 1. Load secrets locally on host startup
const secrets = new SecretStore('./.env');

export default {
  database: process.env.SQLITE_HTTP_URL,
  storagePath: '/var/tmp/workspaces',
  reporters: [
    new SlackReporter({
      token: secrets.get('SLACK_BOT_TOKEN'),
      channel: '#ci-cd-deployments',
      notifyOn: ['success', 'failed'],
    }),
  ],
};
