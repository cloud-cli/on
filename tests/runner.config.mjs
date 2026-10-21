export default {
  database: process.env.SQLITE_HTTP_URL,
  storagePath: "/var/tmp/workspaces",
  // GitHub status updates are workflow-owned (see tests/test.yaml).
};
