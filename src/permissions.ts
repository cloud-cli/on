/**
 * Canonical authorization vocabulary.
 *
 * Workspace members share one capability model. A workspace role is a
 * preset; sparse per-principal overrides can grant or deny individual
 * capabilities on top of it. API tokens never carry their own capabilities:
 * they authenticate a principal, and that principal's live grants decide.
 */

export const WORKSPACE_CAPABILITIES = [
  "workspace.view",
  "workspace.delete",
  "runs.view",
  "runs.logs",
  "runs.artifacts",
  "runs.inputs",
  "runs.dispatch",
  "runs.control",
  "runs.delete",
  "workflows.view",
  "workflows.edit",
  "workflows.delete",
  "secrets.view",
  "secrets.edit",
  "members.view",
  "members.manage",
  "webhooks.view",
  "webhooks.manage",
  "runners.view",
  "runners.manage",
  "settings.manage",
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];
export type WorkspaceRole = "viewer" | "collaborator" | "admin";

export const GLOBAL_CAPABILITIES = [
  "platform.users.view",
  "platform.users.manage",
  "platform.workspaces.delete",
  "platform.runners.view",
  "platform.runners.manage",
  "platform.policy.manage",
] as const;

export type GlobalCapability = (typeof GLOBAL_CAPABILITIES)[number];

/** Capabilities that only an interactive human session may exercise. */
export const HUMAN_ONLY_CAPABILITIES = [
  "personal.preferences",
  "personal.session",
  "personal.push",
  "personal.identity-tokens",
] as const;

export type HumanOnlyCapability = (typeof HUMAN_ONLY_CAPABILITIES)[number];

const VIEWER: readonly WorkspaceCapability[] = ["workspace.view", "runs.view", "workflows.view"];

const COLLABORATOR: readonly WorkspaceCapability[] = [
  ...VIEWER,
  "runs.logs",
  "runs.artifacts",
  "runs.inputs",
  "runs.dispatch",
  "runs.control",
  "workflows.edit",
];

const ADMIN: readonly WorkspaceCapability[] = [
  ...COLLABORATOR,
  "workspace.delete",
  "runs.delete",
  "workflows.delete",
  "secrets.view",
  "secrets.edit",
  "members.view",
  "members.manage",
  "webhooks.view",
  "webhooks.manage",
  "runners.view",
  "runners.manage",
  "settings.manage",
];

export const WORKSPACE_ROLE_CAPABILITIES: Readonly<Record<WorkspaceRole, readonly WorkspaceCapability[]>> = {
  viewer: VIEWER,
  collaborator: COLLABORATOR,
  admin: ADMIN,
};

export const WORKSPACE_ROLE_LABELS: Readonly<Record<WorkspaceRole, string>> = {
  viewer: "Viewer",
  collaborator: "Collaborator",
  admin: "Admin",
};

export const WORKSPACE_ROLE_DESCRIPTIONS: Readonly<Record<WorkspaceRole, string>> = {
  viewer: "Audit CI results: run status, workflow names, and summaries. No logs or changes.",
  collaborator: "Day-to-day work: logs, artifacts, dispatch and rerun, and workflow editing.",
  admin: "Workspace owner: destructive cleanup, members, secrets, runners, and webhooks.",
};

export const PLATFORM_ADMIN_CAPABILITIES: readonly GlobalCapability[] = GLOBAL_CAPABILITIES;

export const GLOBAL_CAPABILITY_LABELS: Readonly<Record<GlobalCapability, string>> = {
  "platform.users.view": "View people",
  "platform.users.manage": "Manage people and platform roles",
  "platform.workspaces.delete": "Delete workspaces",
  "platform.runners.view": "View all runners",
  "platform.runners.manage": "Enroll, update, rename, and revoke runners",
  "platform.policy.manage": "Change global roles and platform policy",
};

export type CapabilityGroup = {
  id: string;
  label: string;
  description: string;
  capabilities: ReadonlyArray<{ capability: WorkspaceCapability; label: string; description: string }>;
};

export const WORKSPACE_CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    description: "See the workspace and its automation.",
    capabilities: [
      { capability: "workspace.view", label: "View workspace", description: "See the workspace and its membership." },
      {
        capability: "settings.manage",
        label: "Change workspace settings",
        description: "Rename the workspace and change workspace-wide configuration.",
      },
      {
        capability: "workspace.delete",
        label: "Delete workspace",
        description: "Permanently remove the workspace, its workflows, runs, secrets, and runners.",
      },
    ],
  },
  {
    id: "runs",
    label: "Runs",
    description: "CI results and execution controls.",
    capabilities: [
      { capability: "runs.view", label: "View runs", description: "List runs and read status, timing, and steps." },
      { capability: "runs.logs", label: "Read logs", description: "Read step logs, diagnostics, and AI explanations." },
      {
        capability: "runs.artifacts",
        label: "Read artifacts",
        description: "Download files published by a run.",
      },
      {
        capability: "runs.inputs",
        label: "Read inputs",
        description: "See the inputs and parameters supplied to a run.",
      },
      { capability: "runs.dispatch", label: "Dispatch runs", description: "Start workflows and dispatch jobs." },
      {
        capability: "runs.control",
        label: "Control runs",
        description: "Cancel running jobs and rerun completed jobs.",
      },
      {
        capability: "runs.delete",
        label: "Delete runs",
        description: "Purge a run, its logs, reports, and artifacts. Use for leaked sensitive data.",
      },
    ],
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "Workflow definitions and revisions.",
    capabilities: [
      {
        capability: "workflows.view",
        label: "View workflows",
        description: "Read workflow definitions and revisions.",
      },
      { capability: "workflows.edit", label: "Edit workflows", description: "Create, edit, and publish workflows." },
      { capability: "workflows.delete", label: "Delete workflows", description: "Remove workflows and their history." },
    ],
  },
  {
    id: "secrets",
    label: "Secrets",
    description: "Workspace secrets available to runs.",
    capabilities: [
      {
        capability: "secrets.view",
        label: "View secret names",
        description: "See which secrets exist, never their values.",
      },
      { capability: "secrets.edit", label: "Manage secrets", description: "Create, replace, and delete secrets." },
    ],
  },
  {
    id: "members",
    label: "Members",
    description: "People in this workspace.",
    capabilities: [
      {
        capability: "members.view",
        label: "View members",
        description: "See who belongs to the workspace and their roles.",
      },
      {
        capability: "members.manage",
        label: "Manage members",
        description: "Invite, remove, and change roles or permissions.",
      },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    description: "Webhooks and runners.",
    capabilities: [
      { capability: "webhooks.view", label: "View webhooks", description: "See webhook registrations." },
      { capability: "webhooks.manage", label: "Manage webhooks", description: "Create and revoke webhooks." },
      { capability: "runners.view", label: "View runners", description: "See runners available to the workspace." },
      {
        capability: "runners.manage",
        label: "Manage runners",
        description: "Activate runners and change shared-runner grants.",
      },
    ],
  },
];

export type PermissionEffect = "allow" | "deny";
export type PermissionOverride = {
  capability: WorkspaceCapability;
  effect: PermissionEffect;
};

const workspaceCapabilitySet = new Set<string>(WORKSPACE_CAPABILITIES);
const globalCapabilitySet = new Set<string>(GLOBAL_CAPABILITIES);
const humanOnlyCapabilitySet = new Set<string>(HUMAN_ONLY_CAPABILITIES);

export function isWorkspaceCapability(value: unknown): value is WorkspaceCapability {
  return typeof value === "string" && workspaceCapabilitySet.has(value);
}

export function isGlobalCapability(value: unknown): value is GlobalCapability {
  return typeof value === "string" && globalCapabilitySet.has(value);
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "viewer" || value === "collaborator" || value === "admin";
}

/**
 * Legacy workspace members could edit workflows, dispatch, and rerun; that is
 * the Collaborator preset. Legacy admins map to Admin.
 */
export function roleFromLegacyMemberRole(value: unknown): WorkspaceRole {
  return value === "admin" ? "admin" : "collaborator";
}

export function effectiveWorkspaceCapabilities(
  role: WorkspaceRole,
  overrides: readonly PermissionOverride[] = [],
): Set<WorkspaceCapability> {
  const effective = new Set<WorkspaceCapability>(WORKSPACE_ROLE_CAPABILITIES[role]);
  const denied = new Set<WorkspaceCapability>();
  for (const override of overrides) {
    if (!isWorkspaceCapability(override.capability)) {
      continue;
    }
    if (override.effect === "deny") {
      denied.add(override.capability);
    } else if (override.effect === "allow") {
      effective.add(override.capability);
    }
  }
  // Deny wins over allow so an explicit restriction cannot be undone by a
  // second, conflicting entry.
  for (const capability of denied) {
    effective.delete(capability);
  }
  return effective;
}

export function workspaceAllows(
  role: WorkspaceRole,
  overrides: readonly PermissionOverride[],
  capability: WorkspaceCapability,
): boolean {
  return effectiveWorkspaceCapabilities(role, overrides).has(capability);
}

export function platformAllows(capabilities: readonly GlobalCapability[], capability: GlobalCapability): boolean {
  return capabilities.includes(capability);
}

/** Overrides may only target workspace capabilities; platform grants are explicit. */
export function sanitizeWorkspaceOverrides(value: unknown): PermissionOverride[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byCapability = new Map<WorkspaceCapability, PermissionEffect>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { capability, effect } = entry as { capability?: unknown; effect?: unknown };
    if (!isWorkspaceCapability(capability) || (effect !== "allow" && effect !== "deny")) {
      continue;
    }
    // A duplicate deny must not be overwritten by a later allow.
    if (byCapability.get(capability) === "deny") {
      continue;
    }
    byCapability.set(capability, effect);
  }
  return [...byCapability].map(([capability, effect]) => ({ capability, effect }));
}

export function sanitizeGlobalCapabilities(value: unknown): GlobalCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter(isGlobalCapability))];
}

export function isHumanOnlyCapability(value: unknown): value is HumanOnlyCapability {
  return typeof value === "string" && humanOnlyCapabilitySet.has(value);
}

/**
 * Legacy scope names only exist to translate old API keys and documentation.
 * Authorization never consults scopes: it resolves the principal and evaluates
 * that principal's live workspace role and overrides.
 */
export const LEGACY_SCOPE_CAPABILITIES: Readonly<Record<string, WorkspaceCapability | GlobalCapability>> = {
  "workflows:read": "workflows.view",
  "workflows:write": "workflows.edit",
  "logs:read": "runs.logs",
  "artifacts:read": "runs.artifacts",
  "runs:control": "runs.control",
  "runs:dispatch": "runs.dispatch",
  "workers:read": "platform.runners.view",
  "secrets:read": "secrets.view",
  "secrets:write": "secrets.edit",
};

export function workspaceRoleCapabilities(role: WorkspaceRole): readonly WorkspaceCapability[] {
  return WORKSPACE_ROLE_CAPABILITIES[role];
}

export function globalCapabilitiesForRole(role: "user" | "admin"): GlobalCapability[] {
  return role === "admin" ? [...GLOBAL_CAPABILITIES] : [];
}

const capabilityDescriptions = new Map<string, { label: string; description: string; group: string }>();
for (const group of WORKSPACE_CAPABILITY_GROUPS) {
  for (const entry of group.capabilities) {
    capabilityDescriptions.set(entry.capability, {
      label: entry.label,
      description: entry.description,
      group: group.label,
    });
  }
}

export function describeWorkspaceCapability(capability: WorkspaceCapability) {
  return capabilityDescriptions.get(capability) || { label: capability, description: "", group: "Other" };
}

/** Overrides that grant something the role does not already provide are elevations. */
export function elevatedOverrides(role: WorkspaceRole, overrides: readonly PermissionOverride[]): PermissionOverride[] {
  const base = new Set(WORKSPACE_ROLE_CAPABILITIES[role]);
  return overrides.filter((override) => override.effect === "allow" && !base.has(override.capability));
}
