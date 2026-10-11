import { describe, expect, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };

describe("OpenAPI specification", () => {
  it("documents discovery and core API paths", () => {
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.paths["/api"]).toHaveProperty("get");
    expect(spec.paths["/api/v1"].get.security).toEqual([{ oidcSessionCookie: [] }, { bearerAuth: [] }]);
    expect(spec.paths["/api/jobs"]).toHaveProperty("get");
    expect(spec.paths["/api/jobs"].get.security).toEqual([{ oidcSessionCookie: [] }, { bearerAuth: [] }]);
    for (const [path, method] of [
      ["/api", "get"],
      ["/api/jobs/{jobId}/wait", "get"],
      ["/api/runs/{jobId}", "get"],
      ["/api/events", "get"],
      ["/api/push/public-key", "get"],
      ["/api/push/subscriptions", "post"],
      ["/api/push/subscriptions", "delete"],
    ]) {
      expect(spec.paths[path][method].security).toEqual([{ oidcSessionCookie: [] }, { bearerAuth: [] }]);
    }
    const jobStatus = spec.paths["/api/jobs/{jobId}/status"].get;
    expect(jobStatus.security).toEqual([{ oidcSessionCookie: [] }, { bearerAuth: [] }]);
    expect(jobStatus.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/JobStatusDetails",
    });
    expect(spec.components.schemas.JobStatusDetails.required).toEqual(["id", "status", "createdAt", "lastUpdated"]);
    expect(spec.paths["/api/v1/jobs"]).toHaveProperty("get");
    expect(spec.paths["/api/session"].get.security).toEqual([{ oidcSessionCookie: [] }]);
    expect(spec.paths["/api/workflows/{workflowId}"]).toHaveProperty("put");
    expect(spec.paths["/api/workflows/{workflowId}/run"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/workflows"].get.security).toEqual([{ oidcSessionCookie: [] }, { bearerAuth: [] }]);
    expect(spec.paths["/api/v1/workflows/{workflowId}"].get.security).toEqual([
      { oidcSessionCookie: [] },
      { bearerAuth: [] },
    ]);
    expect(spec.paths["/api/v1/workflows/{workflowId}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/workflows/{workflowId}"]).toHaveProperty("delete");
    expect(spec.paths["/api/runs/{jobId}/artifacts/{path}"]).toHaveProperty("get");
    expect(spec.paths["/webhooks/{provider}"]).toHaveProperty("post");
    expect(spec.paths["/webhooks/team/{webhookToken}/{provider}"]).toHaveProperty("post");
    expect(spec.paths["/api/teams"].get.security).toEqual([{ oidcSessionCookie: [] }]);
    expect(spec.paths["/api/teams/{teamId}/invitations"]).toHaveProperty("post");
    expect(spec.paths["/api/teams/{teamId}/members/{subject}"]).toHaveProperty("delete");
    expect(spec.paths["/api/teams/{teamId}/members/{subject}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/members/{subject}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/webhooks"].post).toBeDefined();
    expect(spec.paths["/api/v1/workspaces/{workspaceId}/webhooks/{webhookId}"].delete).toBeDefined();
    expect(spec.paths["/webhooks/workspace/{token}"]).toHaveProperty("post");
  });

  it("documents workflow and secret settings as OIDC-session protected", () => {
    expect(spec.components.securitySchemes.oidcSessionCookie).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "runner_oidc_session",
    });
    expect(spec.paths["/api/workflows"].get.security).toEqual([{ oidcSessionCookie: [] }]);
    expect(spec.paths["/api/secrets"].get.security).toEqual([{ oidcSessionCookie: [] }]);
    expect(spec.paths["/api/ai/workflow-help"].post.security).toEqual([{ oidcSessionCookie: [] }]);
  });

  it("documents runner enrollment, inventory, team grants, and lease endpoints", () => {
    expect(spec.paths["/api/v1/runner-enrollments"].post.security).toEqual([{ oidcSessionCookie: [] }]);
    expect(spec.paths["/api/v1/runners/enroll"].post.security).toEqual([]);
    expect(spec.paths["/api/v1/runners"].get.security).toEqual([{ oidcAdminSession: [] }]);
    expect(spec.paths["/api/v1/runners/{runnerId}"].delete).toBeDefined();
    expect(spec.paths["/api/v1/teams/{teamId}/runners/{runnerId}"]).toHaveProperty("post");
    expect(spec.paths["/api/v1/runner/heartbeat"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths["/api/v1/runner/events"].get.responses["200"].content).toHaveProperty("text/event-stream");
    expect(spec.paths["/api/v1/runner/leases"].post.responses).toHaveProperty("204");
    expect(spec.paths["/api/v1/runner/leases/{leaseId}/{action}"]).toHaveProperty("put");
    expect(spec.paths["/api/v1/runners/{runnerId}/update"].post.security).toEqual([{ oidcAdminSession: [] }]);
    expect(spec.paths["/api/v1/runner/update"].get.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths["/api/v1/runner/update/status"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(
      spec.paths["/api/v1/runner/update/status"].post.requestBody.content["application/json"].schema.properties.status
        .enum,
    ).toEqual(["failed"]);
  });
});
