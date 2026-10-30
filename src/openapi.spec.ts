import { describe, expect, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };

describe("OpenAPI specification", () => {
  it("documents discovery and core API paths", () => {
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.paths["/api/v1"]).toHaveProperty("get");
    expect(spec.paths["/api/v1"].get.security).toEqual([]);
    expect(spec.paths["/api/v1/jobs"]).toHaveProperty("get");
    expect(spec.paths["/api/v1/jobs"].get.security).toEqual([
      { oidcSessionCookie: [] },
      { bearerAuth: [] },
      { oidcAdminBearer: [] },
    ]);
    for (const [path, method] of [
      ["/api/v1/jobs/{jobId}/wait", "get"],
      ["/api/v1/runs/{jobId}", "get"],
      ["/api/v1/events", "get"],
      ["/api/v1/push/public-key", "get"],
      ["/api/v1/push/subscriptions", "post"],
      ["/api/v1/push/subscriptions", "delete"],
    ]) {
      expect(spec.paths[path][method].security).toEqual([
        { oidcSessionCookie: [] },
        { bearerAuth: [] },
        { oidcAdminBearer: [] },
      ]);
    }
    const jobStatus = spec.paths["/api/v1/jobs/{jobId}/status"].get;
    expect(jobStatus.security).toEqual([{ oidcSessionCookie: [] }, { bearerAuth: [] }, { oidcAdminBearer: [] }]);
    expect(jobStatus.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/JobStatusDetails",
    });
    expect(spec.components.schemas.JobStatusDetails.required).toEqual(["id", "status", "createdAt", "lastUpdated"]);
    expect(spec.paths["/api/v1/jobs"]).toHaveProperty("get");
    expect(spec.paths["/api/v1/api-keys"]).toBeUndefined();
    expect(spec.paths["/api/v1/api-keys/{keyId}"]).toBeUndefined();
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/api-keys"]).toBeUndefined();
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/api-keys/{keyId}"]).toBeUndefined();
    expect(spec.paths["/api/v1/session"].get.security).toEqual([{ oidcSessionCookie: [] }, { oidcAdminBearer: [] }]);
    expect(spec.paths["/api/v1/workflows/{workflowId}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/workflows/{workflowId}/run"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/channels/{channelId}/threads"]).toHaveProperty("get");
    expect(spec.paths["/api/v1/channels/{channelId}/threads"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/channels/{channelId}/threads/{threadId}/messages"]).toHaveProperty("get");
    expect(spec.paths["/api/v1/channels/{channelId}/threads/{threadId}/messages"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/workflows"].get.security).toEqual([
      { oidcSessionCookie: [] },
      { bearerAuth: [] },
      { oidcAdminBearer: [] },
    ]);
    expect(spec.paths["/api/v1/workflows/{workflowId}/enabled"].patch.summary).toContain("without changing");
    expect(spec.paths["/api/v1/workflows/{workflowId}/transfer"].post.responses).toHaveProperty("409");
    expect(spec.paths["/api/v1/workflows/{workflowId}"].get.security).toEqual([
      { oidcSessionCookie: [] },
      { bearerAuth: [] },
      { oidcAdminBearer: [] },
    ]);
    expect(spec.paths["/api/v1/workflows/{workflowId}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/workflows/{workflowId}"]).toHaveProperty("delete");
    expect(spec.paths["/api/v1/runs/{jobId}/artifacts/{path}"]).toHaveProperty("get");
    expect(spec.paths["/webhooks/connectors/{token}"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/connectors"].post).toBeDefined();
    expect(spec.paths["/api/v1/teams"].get.security).toEqual([{ oidcSessionCookie: [] }, { oidcAdminBearer: [] }]);
    expect(spec.paths["/api/v1/teams/{teamId}/invitations"]).toHaveProperty("post");
    expect(
      spec.paths["/api/v1/workspaces/{workspaceId}/invitations"].post.requestBody.content["application/json"].schema
        .oneOf,
    ).toEqual([{ required: ["email"] }, { required: ["subject"] }]);
    expect(spec.paths["/api/v1/teams/{teamId}/members/{subject}"]).toHaveProperty("delete");
    expect(spec.paths["/api/v1/teams/{teamId}/members/{subject}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/members/{subject}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/connectors"].post).toBeDefined();
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/connectors"].post.security).toContainEqual({
      oidcAdminBearer: [],
    });
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/connectors/{connectorId}"].delete).toBeDefined();
    expect(spec.paths["/api/v1/recipes/validate"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/recipes"]).not.toHaveProperty("delete");
    expect(spec.paths["/api/v1/recipes/{namespace}/{slug}/versions/{version}"]).not.toHaveProperty("delete");
  });

  it("documents only canonical application API routes and runner rename", () => {
    expect(
      Object.keys(spec.paths).every(
        (path) => path === "/api/v1" || path.startsWith("/api/v1/") || path === "/webhooks/connectors/{token}",
      ),
    ).toBe(true);
    expect(Object.keys(spec.paths).some((path) => /system-users|api-keys|workspace.+\/tokens/.test(path))).toBe(false);
    expect(spec.paths["/api/v1/auth/session"].get.security).toEqual([
      { oidcSessionCookie: [] },
      { oidcAdminBearer: [] },
    ]);
    expect(spec.paths["/api/v1/auth/token"].get.security).toEqual([{ oidcSessionCookie: [] }, { oidcAdminBearer: [] }]);
    expect(spec.paths["/api/v1/jobs/{jobId}/restart"]).toHaveProperty("post");
    const restart = spec.paths["/api/v1/jobs/{jobId}/restart"].post;
    expect(restart.responses).toHaveProperty("201");
    expect(restart.requestBody.required).toBe(false);
    expect(restart.requestBody.content["application/json"].schema.properties.inputs.type).toBe("object");
    expect(restart.parameters).toContainEqual({ $ref: "#/components/parameters/WorkspaceId" });
    const rename = spec.paths["/api/v1/runners/{runnerId}"].put;
    expect(rename.security).toEqual([{ oidcAdminSession: [] }, { oidcAdminBearer: [] }]);
    expect(rename.requestBody.content["application/json"].schema.properties.name).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 32,
    });
  });

  it("documents normalized event outcome projection states", () => {
    const projection = spec.paths["/api/v1/domain-events/{eventId}/outcome-projection"].get;
    expect(projection.security).toEqual([{ oidcSessionCookie: [] }, { bearerAuth: [] }, { oidcAdminBearer: [] }]);
    const schema = projection.responses["200"].content["application/json"].schema;
    expect(schema.required).toEqual(["eventId", "fanout", "repeatSemantics", "deliveries"]);
    expect(schema.properties.fanout.enum).toEqual(["matched", "repeat", "unmatched", null]);
    expect(schema.properties.deliveries.items.properties.status.enum).toEqual([
      "pending",
      "in-progress",
      "accepted",
      "filtered",
      "failed",
    ]);
  });

  it("documents scoped workflow access and OIDC-session secret settings", () => {
    expect(spec.components.parameters.WorkspaceId.name).toBe("X-Workspace-ID");
    expect(spec.components.securitySchemes.oidcSessionCookie).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "runner_oidc_session",
    });
    expect(spec.components.securitySchemes.oidcAdminBearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.paths["/api/v1/workflows"].get.security).toEqual([
      { oidcSessionCookie: [] },
      { bearerAuth: [] },
      { oidcAdminBearer: [] },
    ]);
    expect(spec.paths["/api/v1/secrets"].get.security).toEqual([{ oidcSessionCookie: [] }, { oidcAdminBearer: [] }]);
    expect(spec.paths["/api/v1/ai/workflow-help"].post.security).toEqual([
      { oidcSessionCookie: [] },
      { oidcAdminBearer: [] },
    ]);
  });

  it("documents authenticated global recipe publishing and administrator revocation without deletion", () => {
    expect(spec.paths["/api/v1/recipes"].get).toBeDefined();
    expect(spec.paths["/api/v1/recipes"].post.requestBody.content["application/json"].schema.required).toEqual([
      "slug",
      "name",
      "sourceYaml",
    ]);
    expect(spec.paths["/api/v1/recipes/{namespace}/{slug}/versions/{version}"].get).toBeDefined();
    expect(spec.paths["/api/v1/recipes/{namespace}/{slug}/versions/{version}/revoke"].post).toBeDefined();
    expect(spec.paths["/api/v1/recipes/{namespace}/{slug}/versions/{version}"].delete).toBeUndefined();
  });

  it("documents runner enrollment, inventory, team grants, and lease endpoints", () => {
    expect(spec.paths["/api/v1/runner-enrollments"].post.security).toEqual([
      { oidcSessionCookie: [] },
      { oidcAdminBearer: [] },
    ]);
    expect(spec.paths["/api/v1/runners/enroll"].post.security).toEqual([]);
    expect(spec.paths["/api/v1/runners"].get.security).toEqual([{ oidcAdminSession: [] }, { oidcAdminBearer: [] }]);
    expect(spec.paths["/api/v1/runners/{runnerId}"].delete).toBeDefined();
    expect(spec.paths["/api/v1/teams/{teamId}/runners/{runnerId}"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/runner/heartbeat"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths["/api/v1/runner/events"].get.responses["200"].content).toHaveProperty("text/event-stream");
    expect(spec.paths["/api/v1/runner/leases"].post.responses).toHaveProperty("204");
    expect(spec.paths["/api/v1/runner/leases/{leaseId}/{action}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/runners/{runnerId}/update"].post.security).toEqual([
      { oidcAdminSession: [] },
      { oidcAdminBearer: [] },
    ]);
    expect(spec.paths["/api/v1/runner/update"].get.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths["/api/v1/runner/update/status"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(
      spec.paths["/api/v1/runner/update/status"].post.requestBody.content["application/json"].schema.properties.status
        .enum,
    ).toEqual(["failed"]);
  });
});
