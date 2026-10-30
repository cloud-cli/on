import { describe, expect, it } from "vitest";
import { connectorContextHeaders, safeWebhookHeaders } from "./webhook-headers.js";

describe("safeWebhookHeaders", () => {
  it("preserves useful source metadata and custom headers", () => {
    expect(
      safeWebhookHeaders({
        "content-type": "application/json",
        "x-source-type": "build",
        "x-delivery-id": "delivery-id",
        "x-custom-validation": "value",
      }),
    ).toEqual({
      "content-type": "application/json",
      "x-source-type": "build",
      "x-delivery-id": "delivery-id",
      "x-custom-validation": "value",
    });
  });

  it("removes proxy, routing, browser-origin, and credential headers", () => {
    expect(
      safeWebhookHeaders({
        authorization: "Bearer secret",
        cookie: "session=secret",
        host: "internal.example",
        origin: "https://attacker.example",
        referer: "https://attacker.example/",
        forwarded: "for=10.0.0.1",
        "x-forwarded-host": "internal.example",
        "x-real-ip": "10.0.0.1",
        "proxy-authorization": "secret",
        "x-api-key": "secret",
        "x-custom-auth-token": "secret",
        "x-integration-secret": "secret",
        via: "proxy",
        "x-event-type": "sample.received",
      }),
    ).toEqual({ "x-event-type": "sample.received" });
  });
});

describe("connectorContextHeaders", () => {
  it("keeps sender headers while removing host, origin, and proxy headers", () => {
    expect(
      connectorContextHeaders({
        authorization: "sender-defined",
        cookie: "sender-defined",
        "x-sample-signature": "sha256=abc",
        "x-sample-event": "created",
        host: "internal.example",
        origin: "https://example.test",
        forwarded: "for=192.0.2.1",
        "x-forwarded-host": "internal.example",
        "x-real-ip": "192.0.2.1",
        "proxy-authorization": "internal",
      }),
    ).toEqual({
      authorization: "sender-defined",
      cookie: "sender-defined",
      "x-sample-signature": "sha256=abc",
      "x-sample-event": "created",
    });
  });
});
