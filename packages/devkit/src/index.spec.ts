import { test, expect } from "vitest";
import { interpolate } from "./index.js";

test("should interpolate a JS snippet with a context object", async () => {
  const context = { foo: true, bar: "world" };
  const template = "Hello ${bar}! The value of foo is ${foo}.";
  const result = interpolate(template, context);
  expect(result).toBe("Hello world! The value of foo is true.");
});
