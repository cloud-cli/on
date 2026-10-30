import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateConnector, parseConnectorDefinition, type ConnectorContext } from "./connector-definition.js";

const yaml = (run: string) =>
  `run: |\n${run
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}`;
const context = (overrides: Partial<ConnectorContext> = {}): ConnectorContext => ({
  inputs: { value: 7, name: " x " },
  body: Buffer.from("payload"),
  headers: { accept: "json" },
  secrets: {},
  ...overrides,
});

describe("connector definitions", () => {
  it("accepts only a top-level run program", () => {
    expect(parseConnectorDefinition(yaml("emit('ok', {})"))).toMatchObject({ run: expect.any(String) });
    expect(() => parseConnectorDefinition("kind: connector\nid: x\nname: y\nsteps: []")).toThrow();
    expect(() => parseConnectorDefinition(`${yaml("1")}\nid: x`)).toThrow();
  });

  it("executes stored legacy mappings only through the evaluator compatibility path", async () => {
    const legacy = `kind: connector\nid: normalize\nname: Normalize\nsteps:\n  - id: map\n    eval: "({ type: 'sample.received', data: { value: body.value, valueString: String(body.value), header: headers.accept } })"`;
    expect(() => parseConnectorDefinition(legacy)).toThrow();
    await expect(
      evaluateConnector(legacy, context({ body: Buffer.from('{"value":9}'), contentType: "application/json" })),
    ).resolves.toEqual([{ type: "sample.received", data: { value: 9, valueString: "9", header: "json" } }]);
    await expect(
      evaluateConnector(
        legacy,
        context({
          body: Buffer.from('{"value":9}'),
          contentType: "application/json",
          secrets: { WEBHOOK_SECRET: "secret" },
        }),
      ),
    ).rejects.toThrow(/must be updated/);
  });

  it("rejects malformed legacy definitions and unsafe expressions", async () => {
    for (const legacy of [
      "kind: connector\nid: Bad_ID\nname: Name\nsteps: []",
      "kind: connector\nid: ok\nname: Name\nsteps: [{id: map, eval: '({type: \"ok\", data: {}})'}, {id: map, eval: '({type: \"ok\", data: {}})'}]",
      `kind: connector\nid: ok\nname: Name\nsteps:\n  - id: map\n    eval: "emit('ok', {})"`,
      `kind: connector\nid: ok\nname: Name\nsteps:\n  - id: map\n    eval: "({type: 'bad', data: {}})"\nextra: true`,
    ]) {
      await expect(evaluateConnector(legacy, context())).rejects.toThrow();
    }
  });

  it("evaluates blocks and if/else, emitting events in order", async () => {
    const source = yaml(
      `if (inputs.value > 2) {\n  emit('test.received', {value: inputs.value, header: headers.accept, clean: inputs.name.trim(), body: body.toString('utf8')})\n} else {\n  emit('test.ignored', {})\n}`,
    );
    await expect(evaluateConnector(source, context())).resolves.toEqual([
      { type: "test.received", data: { value: 7, header: "json", clean: "x", body: "payload" } },
    ]);
    await expect(evaluateConnector(source, context({ inputs: { value: 1 } }))).resolves.toEqual([
      { type: "test.ignored", data: {} },
    ]);
  });

  it("supports zero events and permits at most 32 validated events", async () => {
    await expect(evaluateConnector(yaml("if (inputs.value) { }"), context())).resolves.toEqual([]);
    await expect(evaluateConnector(yaml("emit('x', {});".repeat(32)), context())).resolves.toHaveLength(32);
    await expect(evaluateConnector(yaml("emit('x', {});".repeat(33)), context())).rejects.toThrow(/32/);
    await expect(evaluateConnector(yaml("emit('Bad', {})"), context())).rejects.toThrow();
  });

  it("caps the combined serialized size of buffered emissions", async () => {
    const largeContext = context({ inputs: { text: "x".repeat(140_000) } });
    await expect(
      evaluateConnector(yaml("emit('first', inputs); emit('second', inputs)"), largeContext),
    ).rejects.toThrow(/total size limit/);
  });

  it("verifies exact raw body bytes with constant-time HMAC comparison", async () => {
    const secret = "test-secret";
    const raw = Buffer.from('{"x":1}\n');
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const program =
      "if (!verifyBody(body, headers.signature)) { throw new Error('invalid signature'); } emit('ok', {raw: body.toString('utf8')})";
    await expect(
      evaluateConnector(
        yaml(program),
        context({ body: raw, headers: { signature }, secrets: { WEBHOOK_SECRET: secret } }),
      ),
    ).resolves.toEqual([{ type: "ok", data: { raw: raw.toString() } }]);
    await expect(
      evaluateConnector(
        yaml(program),
        context({ body: Buffer.from('{"x":1}'), headers: { signature }, secrets: { WEBHOOK_SECRET: secret } }),
      ),
    ).rejects.toThrow("invalid signature");
    await expect(evaluateConnector(yaml("emit('ok', {valid: verifyBody(body, 'bad')})"), context())).resolves.toEqual([
      { type: "ok", data: { valid: false } },
    ]);
  });

  it("rejects unsupported syntax, arbitrary calls, and prototype access", async () => {
    for (const run of [
      "while (true) {}",
      "const x = 1",
      "return 1",
      "inputs.constructor",
      "inputs.value.repeat(100000)",
      "globalThis.process",
    ]) {
      await expect(evaluateConnector(yaml(run), context())).rejects.toThrow();
    }
    await expect(evaluateConnector(yaml("throw new Error('bad payload')"), context())).rejects.toThrow("bad payload");
  });

  it("enforces bounded JSON helpers, result size, and raw Buffer context", async () => {
    await expect(evaluateConnector(yaml("emit('ok', JSON.parse(JSON.stringify({n: 3})))"), context())).resolves.toEqual(
      [{ type: "ok", data: { n: 3 } }],
    );
    await expect(evaluateConnector(yaml("emit('ok', {n: 1 / 0})"), context())).rejects.toThrow();
    await expect(
      evaluateConnector(
        yaml("emit('ok', {x: body.toString('utf8')})"),
        context({ body: "not-a-buffer" as unknown as Buffer }),
      ),
    ).rejects.toThrow(/Buffer/);
    expect(() => parseConnectorDefinition(" ".repeat(256001))).toThrow();
  });
});
