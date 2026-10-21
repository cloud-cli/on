import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CAPABILITIES,
  WORKSPACE_ROLE_CAPABILITIES,
  GLOBAL_CAPABILITIES,
  WORKSPACE_CAPABILITY_GROUPS,
  describeWorkspaceCapability,
  effectiveWorkspaceCapabilities,
  sanitizeWorkspaceOverrides,
  sanitizeGlobalCapabilities,
  roleFromLegacyMemberRole,
  globalCapabilitiesForRole,
  elevatedOverrides,
} from "./permissions.js";

describe("unified permission model", () => {
  it("defines strictly nested documented presets", () => {
    const { viewer, collaborator, admin } = WORKSPACE_ROLE_CAPABILITIES;
    expect(viewer).toEqual(["workspace.view", "runs.view", "workflows.view"]);
    expect(new Set(collaborator).size).toBeGreaterThan(viewer.length);
    expect(viewer.every((cap) => collaborator.includes(cap))).toBe(true);
    for (const cap of [
      "runs.logs",
      "runs.artifacts",
      "runs.inputs",
      "runs.dispatch",
      "runs.control",
      "workflows.edit",
    ] as const) {
      expect(collaborator).toContain(cap);
    }
    for (const cap of [
      "secrets.view",
      "secrets.edit",
      "members.view",
      "members.manage",
      "tokens.view",
      "tokens.manage",
      "workspace.delete",
    ] as const) {
      expect(collaborator).not.toContain(cap);
    }
    expect(collaborator.every((cap) => admin.includes(cap))).toBe(true);
    expect(admin.length).toBeGreaterThan(collaborator.length);
    expect(new Set(admin).size).toBe(admin.length);
  });

  it("applies overrides with deny precedence and ignores invalid entries", () => {
    const result = effectiveWorkspaceCapabilities("viewer", [
      { capability: "runs.logs", effect: "allow" },
      { capability: "runs.view", effect: "deny" },
      { capability: "not.real", effect: "allow" } as any,
      { capability: "runs.logs", effect: "wat" } as any,
    ]);
    expect(result.has("runs.logs")).toBe(true);
    expect(result.has("runs.view")).toBe(false);
    expect(result.size).toBe(3);
  });

  it("sanitizes overrides and global capabilities", () => {
    expect(
      sanitizeWorkspaceOverrides([
        { capability: "runs.logs", effect: "deny" },
        { capability: "runs.logs", effect: "allow" },
        { capability: "runs.view", effect: "allow" },
        { capability: "invalid", effect: "deny" },
        { capability: "workspace.view", effect: "invalid" },
        null,
      ] as any),
    ).toEqual([
      { capability: "runs.logs", effect: "deny" },
      { capability: "runs.view", effect: "allow" },
    ]);
    expect(sanitizeGlobalCapabilities([GLOBAL_CAPABILITIES[0], "invalid", GLOBAL_CAPABILITIES[0], null])).toEqual([
      GLOBAL_CAPABILITIES[0],
    ]);
  });

  it("maps legacy/global roles and elevated overrides", () => {
    expect(roleFromLegacyMemberRole("admin")).toBe("admin");
    expect(roleFromLegacyMemberRole("viewer")).toBe("collaborator");
    expect(globalCapabilitiesForRole("admin")).toEqual(GLOBAL_CAPABILITIES);
    expect(globalCapabilitiesForRole("user")).toEqual([]);
    expect(
      elevatedOverrides("viewer", [
        { capability: "workspace.view", effect: "allow" },
        { capability: "runs.logs", effect: "allow" },
        { capability: "runs.view", effect: "deny" },
      ]),
    ).toEqual([{ capability: "runs.logs", effect: "allow" }]);
  });

  it("documents every workspace capability exactly once", () => {
    const grouped = WORKSPACE_CAPABILITY_GROUPS.flatMap((group) => group.capabilities.map((entry) => entry.capability));
    expect([...grouped].sort()).toEqual([...WORKSPACE_CAPABILITIES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const capability of WORKSPACE_CAPABILITIES) {
      expect(describeWorkspaceCapability(capability).label).toBeTruthy();
    }
  });
});
