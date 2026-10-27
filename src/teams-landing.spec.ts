import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch, refs, initCallbacks } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  refs: [] as Array<{ value: unknown }>,
  initCallbacks: [] as Array<() => unknown>,
}));

vi.mock("@app/api-client.mjs", () => ({ apiFetch }));
vi.mock("@li3/web", () => ({
  onInit: (callback: () => unknown) => initCallbacks.push(callback),
  ref: (value: unknown) => {
    const result = { value };
    refs.push(result);
    return result;
  },
  templateRef: () => ({ value: null }),
}));

import setup from "./teams-landing.mjs";

describe("workspace creation UI", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    refs.length = 0;
    initCallbacks.length = 0;
  });

  it("shows a useful fallback when a rejected create has an empty body", async () => {
    apiFetch.mockResolvedValueOnce(new Response("", { status: 400 }));
    const state = setup();
    state.newTeamName.value = "test area";

    await state.createTeam({ preventDefault() {} });

    expect(state.message.value).toBe("Unable to create workspace.");
  });

  it("uses the server error when a rejected create returns JSON", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ error: "Workspace name is required." }, { status: 400 }));
    const state = setup();
    state.newTeamName.value = "test area";

    await state.createTeam({ preventDefault() {} });

    expect(state.message.value).toBe("Workspace name is required.");
  });
});
