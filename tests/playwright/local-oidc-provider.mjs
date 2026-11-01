import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A deliberately small, loopback-only OIDC provider for browser tests. It supports
// confidential clients, authorization-code S256 PKCE, nonce-bound RS256 ID tokens,
// JWKS, userinfo, and refresh-token grants.
export async function startLocalOidcProvider(host = "127.0.0.1") {
  const certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-oidc-cert-"));
  const keyPath = path.join(certificateDirectory, "key.pem");
  const certPath = path.join(certificateDirectory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const keyId = randomUUID();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const human = { sub: "local-human", name: "Synthetic Human", email: "human@example.test", email_verified: true };
  let origin;
  const json = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  const handler = async (request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === "/identity") {
      response.writeHead(204, {
        "set-cookie": `local_identity=${url.searchParams.get("as") === "agent" ? "agent_local" : "local-human"}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return response.end();
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        userinfo_endpoint: `${origin}/userinfo`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") {
      return json(response, 200, { keys: [{ ...jwk, kid: keyId, use: "sig", alg: "RS256" }] });
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      if (
        url.searchParams.get("client_id") !== "local-client" ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        return json(response, 400, { error: "invalid_request" });
      }
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
        redirect: url.searchParams.get("redirect_uri"),
        subject: (request.headers.cookie || "").includes("local_identity=agent_local") ? "agent_local" : "local-human",
      });
      response.writeHead(302, {
        location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}`,
      });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
      }
      const form = new URLSearchParams(raw);
      if (form.get("client_id") !== "local-client" || form.get("client_secret") !== "local-secret") {
        return json(response, 401, { error: "invalid_client" });
      }
      let claims = human;
      if (form.get("grant_type") === "authorization_code") {
        const record = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        const digest = createHash("sha256").update(form.get("code_verifier")).digest("base64url");
        if (!record || record.redirect !== form.get("redirect_uri") || digest !== record.challenge) {
          return json(response, 400, { error: "invalid_grant" });
        }
        claims = {
          ...human,
          sub: record.subject,
          name: record.subject === "agent_local" ? "Synthetic Agent" : human.name,
          nonce: record.nonce,
        };
      } else if (form.get("grant_type") === "refresh_token") {
        const subject = refreshTokens.get(form.get("refresh_token"));
        if (!subject) {
          return json(response, 400, { error: "invalid_grant" });
        }
        claims = { ...human, sub: subject };
      } else {
        return json(response, 400, { error: "unsupported_grant_type" });
      }
      const now = Math.floor(Date.now() / 1000);
      const token = randomUUID();
      accessTokens.set(token, claims.sub);
      const refresh = randomUUID();
      refreshTokens.set(refresh, claims.sub);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ iss: origin, aud: "local-client", sub: claims.sub, iat: now, exp: now + 900, ...claims }),
      ).toString("base64url");
      const unsigned = `${header}.${payload}`;
      const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
      return json(response, 200, {
        access_token: token,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 900,
        id_token: `${unsigned}.${signature}`,
      });
    }
    if (url.pathname === "/userinfo" && request.method === "GET") {
      const subject = accessTokens.get(request.headers.authorization?.replace(/^Bearer /, ""));
      if (!subject) {
        return json(response, 401, { error: "invalid_token" });
      }
      return json(response, 200, {
        ...human,
        sub: subject,
        ...(subject !== human.sub ? { name: "Synthetic Agent" } : {}),
      });
    }
    response.writeHead(404);
    response.end();
  };
  const server =
    host === "127.0.0.1"
      ? createHttpsServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler)
      : createHttpServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  origin = `${host === "127.0.0.1" ? "https" : "http"}://${host}:${server.address().port}`;
  return {
    origin,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => {
          fs.rmSync(certificateDirectory, { recursive: true, force: true });
          error ? reject(error) : resolve();
        }),
      ),
  };
}
