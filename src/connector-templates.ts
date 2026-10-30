import db from "./db-client.js";
import { parseConnectorDefinition } from "./connector-definition.js";

export type ConnectorTemplate = {
  namespace: string;
  slug: string;
  version: number;
  name: string;
  description: string;
  sourceYaml: string;
  publisher?: string;
};

export const GITHUB_PUSH_TEMPLATE = {
  namespace: "on",
  slug: "github-push",
  version: 1,
  name: "GitHub push",
  description:
    "Verify GitHub's webhook signature and normalize push events. Configure this workspace's signing secret in its webhook settings.",
  sourceYaml: `run: |
  if (!verifyBody(body, headers['x-hub-signature-256'])) {
    throw new Error('Invalid GitHub signature');
  }
  if (headers['x-github-event'] !== 'push') {
    throw new Error('Only GitHub push events are supported');
  }
  if (inputs.deleted || !inputs.after || inputs.after === '0000000000000000000000000000000000000000') {
    throw new Error('Deleted refs and zero commits are not supported');
  }
  if (!inputs.repository || !inputs.repository.owner || !inputs.repository.owner.login || !inputs.repository.name ||
      !inputs.repository.full_name || !inputs.repository.clone_url || !inputs.repository.default_branch || !inputs.ref) {
    throw new Error('Incomplete GitHub push payload');
  }
  if (!inputs.ref.startsWith('refs/heads/')) {
    throw new Error('Only branch pushes are supported');
  }
  emit('git.push', {
    owner: inputs.repository.owner.login,
    repo: inputs.repository.name,
    branch: inputs.ref.slice('refs/heads/'.length),
    ref: inputs.ref,
    repository: inputs.repository.full_name,
    clone_url: inputs.repository.clone_url,
    commit_sha: inputs.after,
    default_branch: inputs.repository.default_branch,
    source: 'github'
  });
`,
};

function validateTemplate(slug: string, name: string, description: string, sourceYaml: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new Error("Invalid connector template slug");
  }
  if (!name.trim() || name.length > 200) {
    throw new Error("Connector template name must contain 1 to 200 characters");
  }
  if (!description.trim() || description.length > 2000) {
    throw new Error("Connector template description is required");
  }
  parseConnectorDefinition(sourceYaml);
}

export class ConnectorTemplateRepository {
  async namespaceForOwner(ownerSubject: string, preferredUsername: string): Promise<string> {
    const existing = await db.get("SELECT namespace FROM connector_template_publishers WHERE owner_subject = ?", [
      ownerSubject,
    ]);
    if (existing?.namespace) {
      return existing.namespace;
    }
    const namespace = preferredUsername
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) {
      throw new Error("OIDC preferred_username is required to publish a connector template");
    }
    await db.run(
      "INSERT INTO connector_template_publishers(owner_subject, namespace) VALUES (?, ?) ON CONFLICT(owner_subject) DO NOTHING",
      [ownerSubject, namespace],
    );
    const persisted = await db.get("SELECT namespace FROM connector_template_publishers WHERE owner_subject = ?", [
      ownerSubject,
    ]);
    if (persisted?.namespace !== namespace) {
      throw new Error("That connector template namespace is already owned");
    }
    return namespace;
  }

  async list(): Promise<ConnectorTemplate[]> {
    const rows = await db.all(`SELECT v.namespace, v.slug, v.version, v.name, v.description, v.source_yaml,
      p.namespace AS publisher FROM connector_template_versions v
      JOIN connector_template_publishers p ON p.owner_subject = v.publisher_subject
      WHERE v.version = (SELECT MAX(latest.version) FROM connector_template_versions latest
        WHERE latest.namespace = v.namespace AND latest.slug = v.slug)
      ORDER BY v.namespace, v.slug`);
    return rows.map((row: any) => this.fromRow(row));
  }

  async get(namespace: string, slug: string, version: number): Promise<ConnectorTemplate | null> {
    const row = await db.get(
      `SELECT v.namespace, v.slug, v.version, v.name, v.description, v.source_yaml, p.namespace AS publisher
       FROM connector_template_versions v JOIN connector_template_publishers p ON p.owner_subject = v.publisher_subject
       WHERE v.namespace = ? AND v.slug = ? AND v.version = ?`,
      [namespace, slug, version],
    );
    return row ? this.fromRow(row) : null;
  }

  async publish(
    namespace: string,
    ownerSubject: string,
    slug: string,
    name: string,
    description: string,
    sourceYaml: string,
  ): Promise<ConnectorTemplate> {
    validateTemplate(slug, name, description, sourceYaml);
    const row = await db.get(
      `INSERT INTO connector_template_versions(namespace, slug, version, name, description, source_yaml, publisher_subject)
       SELECT ?, ?, COALESCE((SELECT MAX(version) FROM connector_template_versions WHERE namespace = ? AND slug = ?), 0) + 1,
         ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM connector_template_publishers WHERE owner_subject = ? AND namespace = ?
       )
       RETURNING namespace, slug, version, name, description, source_yaml, namespace AS publisher`,
      [namespace, slug, namespace, slug, name.trim(), description.trim(), sourceYaml, ownerSubject, namespace],
    );
    if (!row) {
      throw new Error("Connector template could not be published for this owner");
    }
    return this.fromRow(row);
  }

  private fromRow(row: any): ConnectorTemplate {
    return {
      namespace: row.namespace,
      slug: row.slug,
      version: Number(row.version),
      name: row.name,
      description: row.description,
      sourceYaml: row.source_yaml,
      ...(typeof row.publisher === "string" ? { publisher: row.publisher } : {}),
    };
  }
}
