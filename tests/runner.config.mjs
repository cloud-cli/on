import { GitHubStatusPlugin } from '@cloud-cli/on';

export default {
  database: process.env.SQLITE_HTTP_URL,
  storagePath: '/var/tmp/workspaces',
  plugins: [
    new GitHubStatusPlugin({
      token: process.env.SECRET_GITHUB_TOKEN,
    }),
  ],
};
