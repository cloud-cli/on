import { describe, expect, it } from "vitest";
import { renderErrorPage } from "./error-page.js";

describe("renderErrorPage", () => {
  it("renders an accessible branded error with safe actions", () => {
    const html = renderErrorPage({
      status: 502,
      title: "Couldn't complete sign-in",
      message: "Please try again.",
      action: { label: "Try again", href: "/auth/login?url=%2Fruns" },
      secondaryAction: { label: "Back to Flow", href: "/runs" },
    });

    expect(html).toContain("<title>502 — Couldn&#39;t complete sign-in · Flow</title>");
    expect(html).toContain('aria-labelledby="error-title"');
    expect(html).toContain('href="/auth/login?url=%2Fruns"');
    expect(html).toContain('href="/runs"');
    expect(html).not.toContain("access-token");
  });

  it("escapes untrusted text and disallows external action URLs", () => {
    const html = renderErrorPage({
      status: 400,
      title: "<script>alert(1)</script>",
      message: `Bad "request" & response`,
      action: { label: "Continue", href: "//attacker.test/" },
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Bad &quot;request&quot; &amp; response");
    expect(html).toContain('href="/runs"');
  });
});
