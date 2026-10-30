import { describe, expect, it } from "vitest";
import { evaluateConnector, parseConnectorDefinition } from "./connector-definition.js";

const yaml = (
  steps = `- id: event\n  eval: ${JSON.stringify("({type: 'sample.received', data: {body: body, prior: steps.first}})")}`,
) =>
  `kind: connector\nid: webhook\nname: Webhook\nsteps:\n  - id: first\n    eval: input.body.value\n${steps
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}`;

describe("connector definitions", () => {
  it("parses an accepted connector definition", () => {
    expect(parseConnectorDefinition(yaml())).toMatchObject({ kind: "connector", id: "webhook", name: "Webhook" });
  });

  it("rejects run steps and unsupported keys", () => {
    expect(() => parseConnectorDefinition(yaml("- id: event\n  run: echo nope"))).toThrow();
    expect(() => parseConnectorDefinition(`${yaml()}\nextra: true`)).toThrow();
    expect(() => parseConnectorDefinition(yaml().replace("eval:", "other:").replace("({type", "({type"))).toThrow();
  });

  it("rejects unbounded helper calls", () => {
    expect(() =>
      parseConnectorDefinition(yaml(`- id: event\n  eval: ${JSON.stringify("body.value.repeat(1000000)")}`)),
    ).toThrow("bounded data and JSON helpers");
  });

  it("enforces step, expression, YAML, and id limits", () => {
    expect(() => parseConnectorDefinition("kind: connector\nid: A\nname: x\nsteps: []")).toThrow();
    expect(() =>
      parseConnectorDefinition(
        `kind: connector\nid: x\nname: x\nsteps:\n${Array.from({ length: 33 }, (_, i) => `  - id: s${i}\n    eval: 1`).join("\n")}`,
      ),
    ).toThrow();
    expect(() =>
      parseConnectorDefinition(`kind: connector\nid: x\nname: x\nsteps:\n  - id: s\n    eval: ${"x".repeat(8193)}`),
    ).toThrow();
    expect(() => parseConnectorDefinition(" ".repeat(256001))).toThrow();
    expect(() => parseConnectorDefinition("kind: connector\nid: X\nname: x\nsteps:\n  - id: s\n    eval: 1")).toThrow();
    expect(() =>
      parseConnectorDefinition(
        "kind: connector\nid: x\nname: x\nsteps:\n  - id: same\n    eval: 1\n  - id: same\n    eval: 2",
      ),
    ).toThrow();
  });

  it("evaluates steps sequentially with only the permitted context", async () => {
    const source = `kind: connector\nid: test\nname: Test\nsteps:\n  - id: first\n    eval: input.body.value\n  - id: event\n    eval: ${JSON.stringify("({type: 'test.event', data: {value: steps.first, alias: body.value, header: headers.accept}})")}`;
    await expect(
      evaluateConnector(source, {
        input: { contentType: "application/json", body: { value: 7 } },
        headers: { accept: "application/json" },
      }),
    ).resolves.toEqual({ type: "test.event", data: { value: 7, alias: 7, header: "application/json" } });
  });

  it.each([
    "[]",
    "({type: 'Bad', data: {}})",
    "({type: 'ok', data: []})",
    "({type: 'ok', data: {n: 1 / 0}})",
    "({type: 'ok', data: {f: String}})",
  ])("rejects invalid evaluated output %s", async (expression) => {
    const source = `kind: connector\nid: test\nname: Test\nsteps:\n  - id: out\n    eval: ${JSON.stringify(expression)}`;
    await expect(evaluateConnector(source, { input: {} })).rejects.toThrow();
  });
});
