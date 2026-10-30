import { describe, expect, it } from "vitest";
import { createWorkflowPlugin, registerWorkflowPlugin } from "./workflow-registry.js";

describe("workflow plugin registry", () => {
  it("supports externally registered plugin factories", () => {
    registerWorkflowPlugin("test-plugin", () => ({
      name: "test-plugin",
    }));

    expect(createWorkflowPlugin({ name: "test-plugin", secrets: {} }).name).toBe("test-plugin");
  });
});
