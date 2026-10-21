import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import { isProtectedUiRoute, safeReturnUrl } from "./safe-return-url.js";
import { dashboardTemplate, generateDashboardHtml, toDashboardJobs } from "../ui/dashboard.js";
import { EventBroker } from "./events.js";
import { GitHubPreprocessor } from "./preprocessors/github.js";
import { getAppIcon, serviceWorker, webManifest } from "../ui/pwa.js";
import { QueueManager } from "./queue.js";
import { buildRunView, renderRunHtml } from "../ui/run-view.js";
import { SafeExpressionEvaluator } from "./safe-eval.js";
import { expandMatrix, resolveMatrixTags } from "./parser/matrix-expander.js";
import { SecretRepository } from "./secret-repository.js";
import { SecretStore } from "./secrets.js";
import { PushRepository } from "./push.js";
import { renderHelpHtml } from "../ui/help.js";
import openApiSpec from "../openapi.json" with { type: "json" };
import { ApiKeyRepository } from "./api-key-repository.js";
import { generateSettingsHtml } from "../ui/settings-ui.js";
import { generateOperationsHtml } from "../ui/operations-ui.js";
import { generateTeamSettingsHtml } from "../ui/team-settings-ui.js";
import { buildAiHelpMessages, createAiRequest, streamAiHelp } from "./ai-help.js";
import { workflowDocs } from "../ui/help.js";
import appHeaderTemplate from "../ui/app-header.html?raw";
import appShellTemplate from "../ui/app-shell.html?raw";
import teamsLandingTemplate from "./teams-landing.html?raw";
import appRouterTemplate from "../ui/app-router.html?raw";
import { runTemplate } from "../ui/run-view.js";
import type { JobPayload, WebhookPreprocessor, WebhookServerOptions } from "./types.js";
import { generateWorkflowManagementHtml } from "../ui/workflows-ui.js";
import { WorkflowRepository } from "./workflows.js";
import { RecipeRepository, parseRecipe } from "./recipes.js";
import { debug } from "./debug.js";
import { OidcClient } from "./oidc.js";
import { renderErrorPage, type ErrorPageOptions } from "../ui/error-page.js";
import { OidcUserRepository } from "./oidc-user-repository.js";
import { UserPreferencesRepository } from "./user-preferences.js";
import { TeamRepository } from "./teams.js";
import { WorkspaceWebhookRepository } from "./workspace-webhook-repository.js";
import { RunnerRegistry } from "./runner-registry.js";
import { memberViewForCaller, PrincipalRepository } from "./principals.js";
import { RequestAuthorizer, deny, type AuthContext, type WorkspaceAuthorization } from "./authorization.js";
import {
  GLOBAL_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_CAPABILITY_GROUPS,
  WORKSPACE_ROLE_CAPABILITIES,
  WORKSPACE_ROLE_LABELS,
  GLOBAL_CAPABILITY_LABELS,
  isGlobalCapability,
  isWorkspaceCapability,
  isWorkspaceRole,
  sanitizeGlobalCapabilities,
  sanitizeWorkspaceOverrides,
  type GlobalCapability,
  type WorkspaceCapability,
} from "./permissions.js";
import db from "./db-client.js";

function isSafeRunnerFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 500 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function internalApiPath(pathname: string, method: string): string {
  if (pathname === "/api/v1") {
    return pathname;
  }
  if (pathname.startsWith("/api/v1/webhooks/")) {
    return pathname.replace(/^\/api\/v1/, "");
  }
  const restart = pathname.match(/^\/api\/v1\/jobs\/(\d+)\/restart$/);
  if (restart) {
    return `/restart/${restart[1]}`;
  }
  if (pathname === "/api/v1/admin/reload-secrets") {
    return "/admin/reload-secrets";
  }
  if (pathname === "/api/v1/auth/session") {
    return "/api/auth/session";
  }
  if (pathname === "/api/v1/auth/token") {
    return "/api/auth/token";
  }
  if (pathname.startsWith("/api/v1/workspaces")) {
    return pathname.replace(/^\/api\/v1\/workspaces/, "/api/workspaces");
  }
  if (
    (method.toUpperCase() === "PATCH" && /^\/api\/v1\/workflows\/[a-z0-9-]+\/enabled$/.test(pathname)) ||
    (method.toUpperCase() === "POST" && /^\/api\/v1\/workflows\/[a-z0-9-]+\/transfer$/.test(pathname))
  ) {
    return pathname;
  }

  if (
    pathname.startsWith("/api/v1/runner/") ||
    pathname.startsWith("/api/v1/runners") ||
    pathname === "/api/v1/runner-enrollments" ||
    /^\/api\/v1\/teams\/[^/]+\/runners(?:\/[^/]+)?$/.test(pathname) ||
    (["GET", "PUT", "DELETE"].includes(method.toUpperCase()) &&
      /^\/api\/v1\/workflows(?:\/[a-z0-9-]+)?$/.test(pathname))
  ) {
    return pathname;
  }

  return pathname.replace(/^\/api\/v1/, "/api");
}
import apiClientSource from "../ui/api-client.mjs?raw";
import appShellSetup from "../ui/app-shell.mjs?raw";
import appHeaderSetup from "../ui/app-header.mjs?raw";
import appRouterSetup from "../ui/app-router.mjs?raw";
import dashboardSetup from "../ui/dashboard.mjs?raw";
import runSetup from "../ui/run.mjs?raw";
import settingsSetup from "../ui/settings-ui.mjs?raw";
import operationsSetup from "../ui/operations-ui.mjs?raw";
import teamSettingsSetup from "../ui/team-settings-ui.mjs?raw";
import teamsLandingSetup from "./teams-landing.mjs?raw";
import workflowsSetup from "../ui/workflows-ui.mjs?raw";
import recipeInsertionSetup from "../ui/recipe-insertion.mjs?raw";
import recipesTemplate from "../ui/recipes.html?raw";
import recipesSetup from "../ui/recipes-ui.mjs?raw";
import timezoneFormatSource from "../ui/timezone-format.mjs?raw";
import preferencesSource from "../ui/preferences.mjs?raw";
import workspacePathSource from "../ui/workspace-path.mjs?raw";

const DASHBOARD_PAGE_SIZE = 50;
const MAX_DASHBOARD_PAGE_SIZE = 500;

/** A response sink for probes that must not emit anything. */
const SILENT_RESPONSE = {
  headersSent: false,
  writeHead() {
    return this;
  },
  end() {
    return this;
  },
} as unknown as http.ServerResponse;
export class WebhookServer {
  private server: http.Server;
  private preprocessors = new Map<string, WebhookPreprocessor>();
  private workflows = new WorkflowRepository();
  private recipes = new RecipeRepository();
  private secretRepository = new SecretRepository();
  private queue: QueueManager;
  private secrets: SecretStore;
  private push: PushRepository;
  private apiKeys = new ApiKeyRepository();
  private principals = new PrincipalRepository();
  private authorizer: RequestAuthorizer;
  private adminToken: string;
  private workerToken: string;
  private beta: boolean;
  private oidc?: OidcClient;
  private oidcUsers = new OidcUserRepository();
  private userPreferences = new UserPreferencesRepository();
  private teams = new TeamRepository();
  private workspaceWebhooks = new WorkspaceWebhookRepository(this.secretRepository);
  private events = new EventBroker();
  private runners = new RunnerRegistry();
  private workflowsLoaded: Promise<void>;

  static async withPort(options: WebhookServerOptions & { port: number }) {
    const { port, ...o } = options;
    return new WebhookServer(o).listen(port);
  }

  constructor(options: WebhookServerOptions) {
    this.queue = options.queue;
    this.secrets = options.secrets;
    this.push = new PushRepository(options.config);
    this.adminToken = options.adminToken;
    this.workerToken = options.config.workerToken;
    this.beta = options.config.beta ?? false;
    this.oidc = options.config.oidc ? new OidcClient(options.config.oidc) : undefined;
    this.authorizer = new RequestAuthorizer(this.oidc, this.principals);

    this.workflowsLoaded = this.workflows.init().then(async () => {
      await Promise.all([
        this.secretRepository.init(),
        this.apiKeys.init(),
        this.oidcUsers.init(),
        this.principals.init(),
        this.userPreferences.init(),
        this.runners.init(),
        this.workspaceWebhooks.init(),
        this.recipes.init(),
      ]);
    });

    this.registerPreprocessor(new GitHubPreprocessor());
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        const isBrowserDocument =
          (req.method === "GET" || req.method === "HEAD") &&
          !req.url?.startsWith("/api/") &&
          req.headers.accept?.includes("text/html");
        if (isBrowserDocument) {
          this.sendHtmlError(
            res,
            {
              status: 500,
              title: "Something went wrong",
              message: "Flow hit an unexpected problem while handling this page. Please try again.",
              action: { label: "Try again", href: "/ui/runs" },
            },
            req.method === "HEAD",
          );
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      });
    });
  }

  registerPreprocessor(preprocessor: WebhookPreprocessor) {
    this.preprocessors.set(preprocessor.name, preprocessor);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(
      req.url || "/",
      `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`,
    );

    if (
      url.pathname === "/api" ||
      (url.pathname.startsWith("/api/") && url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/"))
    ) {
      res.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "API routes must use /api/v1" }));
    }
    if (
      url.pathname.startsWith("/webhooks/") ||
      url.pathname.startsWith("/restart/") ||
      url.pathname === "/admin/reload-secrets"
    ) {
      res.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Use the versioned API route under /api/v1" }));
    }
    const externalPath = url.pathname;
    if (externalPath === "/" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(302, { Location: `/ui/runs${url.search}`, "Cache-Control": "no-store" });
      return res.end();
    }
    const isVersionedApiPath = externalPath === "/api/v1" || externalPath.startsWith("/api/v1/");
    if (isVersionedApiPath) {
      url.pathname = internalApiPath(url.pathname, req.method || "GET");
    }
    const isUiPage = externalPath === "/ui" || externalPath.startsWith("/ui/");
    const isAsset = externalPath === "/assets" || externalPath.startsWith("/assets/");
    if (externalPath === "/assets" || externalPath === "/assets/") {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (isUiPage) {
      url.pathname = externalPath === "/ui" ? "/" : externalPath.slice(3);
    } else if (isAsset) {
      url.pathname = externalPath === "/assets" ? "/" : externalPath.slice(7);
    } else if (
      externalPath === "/" ||
      ["/runs", "/help", "/settings", "/operations", "/teams", "/workspaces", "/workflows", "/recipes"].includes(
        externalPath,
      ) ||
      /^\/(?:runs|workflows|recipes)\//.test(externalPath) ||
      /^\/(?:teams|workspaces|settings)\//.test(externalPath) ||
      externalPath.startsWith("/pages/") ||
      ["/manifest.webmanifest", "/app-icon.svg", "/on.css", "/service-worker.js"].includes(externalPath) ||
      /\.(?:mjs|js|css|svg|html|ico|png|webmanifest)$/.test(externalPath)
    ) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end();
      return;
    }

    // Global OIDC authentication check for browser UI routes.
    // Exempt routes have their own authorization logic (API, static, auth flow, route-specific controls).
    const method = (req.method || "GET").toUpperCase();
    const requiresUiAuthentication = isProtectedUiRoute(url.pathname, method);
    if (isVersionedApiPath) {
      await this.workflowsLoaded;
    }

    // If OIDC is disabled and this is a protected browser UI route, return 503.
    if (requiresUiAuthentication) {
      if (!this.oidc?.enabled) {
        return this.sendHtmlError(res, {
          status: 503,
          title: "Sign-in is unavailable",
          message: "Authentication is temporarily unavailable. Please try again in a little while.",
          action: { label: "Try signing in", href: "/auth/login?url=%2Fui%2Fruns" },
        });
      }

      const user = this.oidc?.userFromCookie(req.headers.cookie);
      if (!user) {
        const returnTo = encodeURIComponent(safeReturnUrl(externalPath + url.search));
        res.writeHead(302, { Location: `/auth/login?url=${returnTo}` });
        return res.end();
      }
    }

    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Cache-Control": "public, max-age=3600", "Content-Type": "application/manifest+json" });
      return res.end(webManifest);
    }

    if (req.method === "GET" && url.pathname === "/app-icon.svg") {
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "image/svg+xml",
      });
      return res.end(getAppIcon(this.beta));
    }

    if (req.method === "GET" && url.pathname === "/on.css") {
      res.writeHead(200, { "Cache-Control": "public, max-age=3600", "Content-Type": "text/css" });
      return res.end(fs.readFileSync("./dist/on.css", "utf8"));
    }

    if (req.method === "GET" && url.pathname === "/timezone-format.mjs") {
      res.writeHead(200, { "Cache-Control": "public, max-age=3600", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(timezoneFormatSource);
    }

    if (req.method === "GET" && url.pathname === "/preferences.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(preferencesSource);
    }

    if (req.method === "GET" && url.pathname === "/workspace-path.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(workspacePathSource);
    }

    if (req.method === "GET" && url.pathname === "/service-worker.js") {
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/ui/",
      });
      return res.end(serviceWorker);
    }

    if (req.method === "GET" && url.pathname === "/auth/login") {
      return this.handleOidcLogin(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/auth/callback") {
      return this.handleOidcCallback(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/auth/logout") {
      return this.handleOidcLogout(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/session") {
      return this.handleOidcSession(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/token") {
      return this.handleOidcToken(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api-client.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(apiClientSource);
    }
    if (req.method === "GET" && url.pathname === "/app-shell.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(appShellSetup);
    }
    if (req.method === "GET" && url.pathname === "/app-header.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(appHeaderSetup);
    }
    if (req.method === "GET" && url.pathname === "/app-router.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(appRouterSetup);
    }
    if (req.method === "GET" && (url.pathname === "/dashboard.mjs" || url.pathname === "/pages/dashboard.mjs")) {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(dashboardSetup);
    }
    if (req.method === "GET" && (url.pathname === "/run.mjs" || url.pathname === "/pages/run.mjs")) {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(runSetup);
    }
    if (req.method === "GET" && (url.pathname === "/settings-ui.mjs" || url.pathname === "/pages/settings-ui.mjs")) {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(settingsSetup);
    }
    if (req.method === "GET" && url.pathname === "/operations-ui.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(operationsSetup);
    }
    if (req.method === "GET" && url.pathname === "/team-settings-ui.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(teamSettingsSetup);
    }
    if (req.method === "GET" && url.pathname === "/teams-landing.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(teamsLandingSetup);
    }
    if (req.method === "GET" && (url.pathname === "/workflows-ui.mjs" || url.pathname === "/pages/workflows-ui.mjs")) {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(workflowsSetup);
    }
    if (req.method === "GET" && url.pathname === "/pages/recipes-ui.mjs") {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(recipesSetup);
    }
    if (req.method === "GET" && ["/pages/recipe-insertion.mjs", "/recipe-insertion.mjs"].includes(url.pathname)) {
      res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(recipeInsertionSetup);
    }

    if (req.method === "GET" && url.pathname === "/app-header.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(appHeaderTemplate);
    }

    if (req.method === "GET" && url.pathname === "/app-router.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(appRouterTemplate);
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/runs" || url.pathname === "/" || /^\/workspaces\/[^/]+\/runs$/.test(url.pathname))
    ) {
      return this.renderAppShell(res);
    }

    if (req.method === "GET" && url.pathname === "/help") {
      if (url.searchParams.get("embed") === "1") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(renderHelpHtml(true));
      }
      return this.renderAppShell(res);
    }

    if (req.method === "GET" && url.pathname === "/api/v1") {
      if (!(await this.requireAuthenticatedApiRequest(req, res))) {
        return;
      }
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(openApiSpec));
    }

    if (req.method === "POST" && url.pathname === "/api/workers/heartbeat") {
      if (!this.isWorker(req)) {
        res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || body.workerId !== req.headers["x-runner-worker-id"]) {
        return;
      }
      await this.queue.updateWorkerPresence({
        id: body.workerId,
        version: String(body.version || "unknown"),
        tags: Array.isArray(body.tags) ? body.tags : [],
        concurrency: Number(body.concurrency || 0),
        activeJobs: Number(body.activeJobs || 0),
      });
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workers") {
      if (!(await this.authorizer.platform(req, res, "platform.runners.view"))) {
        return;
      }
      const workers = await this.queue.listWorkerPresence();
      const runnerNames = new Map((await this.runners.list()).map((runner) => [runner.id, runner.name]));
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          workers: workers.map((worker) => ({
            ...worker,
            name: runnerNames.get(worker.workerId) || worker.workerId,
          })),
        }),
      );
    }

    if (url.pathname === "/api/v1/runner-enrollments" && req.method === "POST") {
      const context = await this.authorizer.authenticated(req, res);
      if (!context) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || (body.scope !== "shared" && body.scope !== "team")) {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Invalid runner scope" }));
        return;
      }
      let teamId: string | null = null;
      if (body.scope === "shared") {
        if (!(await this.authorizer.platform(req, res, "platform.runners.manage"))) {
          return;
        }
      } else {
        teamId = typeof body.teamId === "string" ? body.teamId : "";
        if (!teamId || !(await this.authorizer.workspace(req, res, "runners.manage", teamId))) {
          return;
        }
      }
      try {
        const enrollment = await this.runners.createEnrollment(body.scope, teamId, context.principal.subject);
        res
          .writeHead(201, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify(enrollment));
      } catch (error: any) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (url.pathname === "/api/v1/runners/enroll" && req.method === "POST") {
      const body = await this.readJson(req, res);
      if (!body || typeof body.code !== "string" || typeof body.name !== "string") {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Code and runner name required" }));
        return;
      }
      try {
        const enrolled = await this.runners.redeemEnrollment(body.code, body.name, String(body.runtime || "unknown"));
        if (!enrolled) {
          res
            .writeHead(400, { "Cache-Control": "no-store", "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Enrollment code is invalid, expired, or already used" }));
          return;
        }
        res
          .writeHead(201, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify(enrolled));
      } catch (error: any) {
        res
          .writeHead(400, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/runners") {
      if (!(await this.authorizer.platform(req, res, "platform.runners.view"))) {
        return;
      }
      res
        .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
        .end(JSON.stringify({ runners: await this.runners.list() }));
      return;
    }
    const runnerUpdateRequest = url.pathname.match(/^\/api\/v1\/runners\/([^/]+)\/update$/);
    if (req.method === "POST" && runnerUpdateRequest) {
      if (!(await this.authorizer.platform(req, res, "platform.runners.manage"))) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.version !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "version required" }));
        return;
      }
      let update;
      try {
        update = await this.runners.requestUpdate(decodeURIComponent(runnerUpdateRequest[1]), body.version);
      } catch (error) {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: (error as Error).message }));
        return;
      }
      if (!update) {
        res
          .writeHead(409, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Runner unavailable, busy, or another update is active" }));
        return;
      }
      this.events.publishRunner(update.runnerId, "runner.update", { updateId: update.id, version: update.version });
      res
        .writeHead(202, { "Cache-Control": "no-store", "Content-Type": "application/json" })
        .end(JSON.stringify(update));
      return;
    }
    const teamRunnersMatch = url.pathname.match(/^\/api\/v1\/teams\/([^/]+)\/runners$/);
    if (req.method === "GET" && teamRunnersMatch) {
      const teamId = decodeURIComponent(teamRunnersMatch[1]);
      if (!(await this.authorizer.workspace(req, res, "runners.view", teamId))) {
        return;
      }
      res
        .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
        .end(JSON.stringify(await this.runners.listForTeam(teamId)));
      return;
    }
    const teamRunnerGrantMatch = url.pathname.match(/^\/api\/v1\/teams\/([^/]+)\/runners\/([^/]+)$/);
    if (teamRunnerGrantMatch && (req.method === "POST" || req.method === "DELETE")) {
      const teamId = decodeURIComponent(teamRunnerGrantMatch[1]);
      const runnerId = decodeURIComponent(teamRunnerGrantMatch[2]);
      const context = await this.authorizer.workspace(req, res, "runners.manage", teamId);
      if (!context) {
        return;
      }
      if (req.method === "POST") {
        const success = await this.runners.grantTeam(runnerId, teamId, context.principal.subject);
        if (!success) {
          res
            .writeHead(409, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Only shared runners can be granted" }));
          return;
        }
        this.events.closeRunnerStreams(runnerId);
      } else {
        if (!(await this.runners.revokeTeamGrant(runnerId, teamId))) {
          res
            .writeHead(404, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Runner grant not found" }));
          return;
        }
        const fencedLeases = await this.queue.revokeRunnerLeasesForTeam(runnerId, teamId);
        for (const lease of fencedLeases) {
          this.events.publish("lease.cancelled", { jobId: lease.jobId, leaseId: lease.leaseId, teamId });
        }
        this.events.closeRunnerStreams(runnerId);
      }
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
      return;
    }
    const revokeRunnerMatch = url.pathname.match(/^\/api\/v1\/runners\/([^/]+)$/);
    if (req.method === "PUT" && revokeRunnerMatch) {
      if (!(await this.authorizer.platform(req, res, "platform.runners.manage"))) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.name !== "string") {
        res
          .writeHead(400, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Runner name is required" }));
        return;
      }
      let renamed: boolean;
      try {
        renamed = await this.runners.rename(decodeURIComponent(revokeRunnerMatch[1]), body.name);
      } catch (error) {
        res
          .writeHead(400, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ error: (error as Error).message }));
        return;
      }
      if (!renamed) {
        res
          .writeHead(404, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Runner not found" }));
        return;
      }
      res
        .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
        .end(
          JSON.stringify({ runner: (await this.runners.list()).find((runner) => runner.id === revokeRunnerMatch[1]) }),
        );
      return;
    }
    if (req.method === "DELETE" && revokeRunnerMatch) {
      if (!(await this.authorizer.platform(req, res, "platform.runners.manage"))) {
        return;
      }
      const runnerId = decodeURIComponent(revokeRunnerMatch[1]);
      const revoked = await this.runners.revoke(runnerId);
      if (revoked) {
        const fencedLeases = await this.queue.revokeRunnerLeases(runnerId);
        for (const lease of fencedLeases) {
          this.events.publish("lease.cancelled", { jobId: lease.jobId, leaseId: lease.leaseId, teamId: lease.teamId });
        }
        this.events.closeRunnerStreams(runnerId);
      }
      res.writeHead(revoked ? 204 : 404, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/runner/heartbeat") {
      const principal = await this.authenticateRunner(req, res);
      if (!principal) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body) {
        return;
      }
      const updated = await this.runners.heartbeat(principal.runnerId, body);
      res.writeHead(updated ? 204 : 401, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/runner/update") {
      const principal = await this.authenticateRunner(req, res);
      if (!principal) {
        return;
      }
      res
        .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
        .end(JSON.stringify({ update: await this.runners.currentUpdate(principal.runnerId) }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/runner/update/status") {
      const principal = await this.authenticateRunner(req, res);
      if (!principal) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.updateId !== "string" || body.status !== "failed") {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Invalid update status" }));
        return;
      }
      const accepted = await this.runners.reportUpdate(principal.runnerId, body.updateId, body.status);
      res.writeHead(accepted ? 204 : 409, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/runner/events") {
      const principal = await this.authenticateRunner(req, res);
      if (!principal) {
        return;
      }
      const context = await this.runners.claimContext(principal.runnerId);
      if (!context) {
        res.writeHead(401, { "Cache-Control": "no-store" }).end();
        return;
      }
      return this.events.subscribe(req, res, undefined, true, context.teamIds, principal.runnerId);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/runner/leases") {
      const principal = await this.authenticateRunner(req, res);
      if (!principal) {
        return;
      }
      const context = await this.runners.claimContext(principal.runnerId);
      if (!context) {
        res.writeHead(401, { "Cache-Control": "no-store" }).end();
        return;
      }
      await this.queue.clearStaleJobs();
      const leaseId = crypto.randomUUID();
      const leaseToken = crypto.randomBytes(32).toString("base64url");
      const job = await this.queue.claimNextForRunner(
        principal.runnerId,
        context.tags,
        context.teamIds,
        leaseId,
        crypto.createHash("sha256").update(leaseToken).digest("hex"),
        90,
        context.concurrency,
      );
      if (!job) {
        res.writeHead(204, { "Cache-Control": "no-store" }).end();
        return;
      }
      const workflow = await this.workflows.getRevision(job.workflow_id, job.workflow_revision);
      if (!workflow) {
        await this.queue.releaseJob(job.id);
        res
          .writeHead(500, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Claimed workflow revision is unavailable" }));
        return;
      }
      res
        .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
        .end(JSON.stringify({ leaseId, leaseToken, expiresInSeconds: 90, job, workflow }));
      return;
    }
    const runnerLeaseMatch = url.pathname.match(
      /^\/api\/v1\/runner\/leases\/([^/]+)(?:\/(renew|workflow|secrets|report|logs|files|complete|release|dispatch))?$/,
    );
    if (runnerLeaseMatch) {
      const [, leaseId, action] = runnerLeaseMatch;
      const principal = await this.authenticateRunner(req, res);
      if (!principal) {
        return;
      }
      const leaseToken = String(req.headers["x-runner-lease-token"] || "");
      const leaseTokenHash = crypto.createHash("sha256").update(leaseToken).digest("hex");
      const job = await this.queue.getLeasedJob(leaseId, principal.runnerId, leaseTokenHash);
      if (!job) {
        res
          .writeHead(409, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Lease is expired, revoked, or not assigned to this runner" }));
        return;
      }
      if (req.method === "GET" && !action) {
        res
          .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ leaseId, jobId: job.id, status: job.status, expiresAt: job.lease_expires_at }));
        return;
      }
      if (job.lease_completed && !(req.method === "POST" && action === "complete")) {
        res.writeHead(409, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (req.method === "POST" && action === "dispatch") {
        const body = await this.readJson(req, res);
        if (body === null && res.headersSent) {
          return;
        }
        try {
          const dispatched = await this.dispatchFromLease(job, body);
          res
            .writeHead(202, { "Cache-Control": "no-store", "Content-Type": "application/json" })
            .end(JSON.stringify(dispatched));
        } catch (error: any) {
          const status = error.status || 400;
          res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
        }
        return;
      }
      if (req.method === "GET" && action === "workflow") {
        if (job.status !== "running") {
          res.writeHead(409, { "Cache-Control": "no-store" }).end();
          return;
        }
        const workflow = await this.workflows.getRevision(job.workflow_id, job.workflow_revision);
        if (!workflow) {
          res.writeHead(404, { "Cache-Control": "no-store" }).end();
          return;
        }
        res
          .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ workflowId: job.workflow_id, revision: job.workflow_revision, definition: workflow }));
        return;
      }
      if (req.method === "GET" && action === "secrets") {
        if (job.status !== "running") {
          res.writeHead(409, { "Cache-Control": "no-store" }).end();
          return;
        }
        if (!job.team_id) {
          res.writeHead(409).end();
          return;
        }
        res
          .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
          .end(JSON.stringify({ secrets: await this.secretRepository.getAllForJob(job.team_id) }));
        return;
      }
      if (req.method === "POST" && action === "renew") {
        const renewed = await this.queue.renewRunnerLease(leaseId, principal.runnerId, leaseTokenHash, 90);
        res.writeHead(renewed ? 204 : 409, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (req.method === "PUT" && action === "report") {
        const body = await this.readJson(req, res);
        if (!body || body.jobId !== job.id || typeof body.status !== "string") {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Invalid job report" }));
          return;
        }
        const saved = await this.queue.saveReportForRunner(job.id, principal.runnerId, leaseId, leaseTokenHash, body);
        res.writeHead(saved ? 204 : 409, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (req.method === "POST" && action === "logs") {
        const body = await this.readJson(req, res);
        if (
          !body ||
          typeof body.stepId !== "string" ||
          typeof body.content !== "string" ||
          body.content.length > 1_000_000
        ) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid step log" }));
          return;
        }
        const saved = await this.queue.saveStepLogForRunner(
          job.id,
          principal.runnerId,
          leaseId,
          leaseTokenHash,
          body.stepId,
          body.content,
        );
        res.writeHead(saved ? 204 : 409, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (req.method === "POST" && action === "files") {
        const body = await this.readJson(req, res);
        if (!body || (body.kind !== "artifact" && body.kind !== "cache") || job.status !== "running") {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Invalid file operation" }));
          return;
        }
        const cacheKey = typeof body.cacheKey === "string" ? body.cacheKey.slice(0, 200) : "";
        if (body.kind !== "artifact" && !job.team_id) {
          res.writeHead(409).end();
          return;
        }
        const ownerKey = body.kind === "artifact" ? String(job.id) : `${job.team_id}:${job.workflow_id}:${cacheKey}`;
        if (body.action === "load") {
          const files = await this.queue.getStoredFilesForRunner(
            body.kind,
            ownerKey,
            job.id,
            principal.runnerId,
            leaseId,
            leaseTokenHash,
          );
          res
            .writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" })
            .end(JSON.stringify({ files }));
          return;
        }
        if (body.action === "save" && Array.isArray(body.files) && body.files.length <= 1000) {
          const totalSize = body.files.reduce(
            (total: number, file: any) => total + (typeof file?.content === "string" ? file.content.length : 0),
            0,
          );
          if (
            totalSize > 4_000_000 ||
            body.files.some(
              (file: any) =>
                typeof file.path !== "string" || !isSafeRunnerFilePath(file.path) || typeof file.content !== "string",
            )
          ) {
            res
              .writeHead(400, { "Content-Type": "application/json" })
              .end(JSON.stringify({ error: "Invalid stored file" }));
            return;
          }
          const saved = await this.queue.saveStoredFilesForRunner(
            body.kind,
            ownerKey,
            body.files,
            job.id,
            principal.runnerId,
            leaseId,
            leaseTokenHash,
          );
          res.writeHead(saved ? 204 : 409, { "Cache-Control": "no-store" }).end();
          return;
        }
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Invalid file operation" }));
        return;
      }
      if (req.method === "POST" && action === "complete") {
        const body = await this.readJson(req, res);
        if (
          !body ||
          body.jobId !== job.id ||
          !["success", "failed", "cancelled"].includes(body.status) ||
          !body.report ||
          typeof body.report !== "object"
        ) {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Invalid completion" }));
          return;
        }
        const saved = await this.queue.completeJobForRunner(
          job.id,
          principal.runnerId,
          leaseId,
          leaseTokenHash,
          body.status,
          body.report,
        );
        if (saved) {
          this.events.publish("jobs.changed", { jobId: job.id, teamId: job.team_id });
        }
        res.writeHead(saved ? 204 : 409, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (req.method === "POST" && action === "release") {
        const released = await this.queue.releaseRunnerLease(leaseId, principal.runnerId, leaseTokenHash);
        if (released) {
          this.events.publish("jobs.available", {
            tags: job.required_tags ? JSON.parse(job.required_tags) : [],
            teamId: job.team_id,
          });
        }
        res.writeHead(released ? 204 : 409, { "Cache-Control": "no-store" }).end();
        return;
      }
      res.writeHead(405, { Allow: "GET, POST, PUT" }).end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/pages/dashboard.html") {
      return this.renderPageComponent(res, "page-dashboard", dashboardTemplate);
    }
    if (req.method === "GET" && url.pathname === "/pages/run.html") {
      return this.renderPageComponent(res, "page-run", runTemplate);
    }
    if (req.method === "GET" && url.pathname === "/pages/help.html") {
      return this.renderPageComponent(res, "page-help", renderHelpHtml(false), true);
    }
    if (req.method === "GET" && url.pathname === "/pages/workflows.html") {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      const page =
        url.searchParams.get("page") === "secrets"
          ? "secrets"
          : url.searchParams.get("page") === "editor"
            ? "editor"
            : "workflows";
      const id = url.searchParams.get("id") || "";
      const revision = Number(url.searchParams.get("revision"));
      return this.renderPageComponent(
        res,
        page === "editor" ? "page-workflow-editor" : page === "secrets" ? "page-secrets" : "page-workflows",
        generateWorkflowManagementHtml(page, id, Number.isSafeInteger(revision) && revision > 0 ? revision : undefined),
      );
    }
    if (req.method === "GET" && url.pathname === "/pages/recipes.html") {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderPageComponent(res, "page-recipes", recipesTemplate);
    }
    if (req.method === "GET" && url.pathname === "/pages/settings.html") {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderPageComponent(res, "page-settings", generateSettingsHtml());
    }
    if (req.method === "GET" && url.pathname === "/pages/operations.html") {
      if (!(await this.requireOperationsAccess(req, res))) {
        return;
      }
      return this.renderPageComponent(res, "page-operations", generateOperationsHtml());
    }
    if (req.method === "GET" && ["/pages/teams.html", "/pages/workspaces.html"].includes(url.pathname)) {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderPageComponent(res, "page-teams", teamsLandingTemplate);
    }
    if (req.method === "GET" && url.pathname === "/pages/team-settings.html") {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderPageComponent(res, "page-team-settings", generateTeamSettingsHtml());
    }

    if (req.method === "GET" && url.pathname === "/workflows") {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderAppShell(res);
    }

    if (req.method === "GET" && /^\/recipes(?:\/new)?$/.test(url.pathname)) {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderAppShell(res);
    }

    if (req.method === "GET" && url.pathname === "/settings") {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderAppShell(res);
    }
    if (req.method === "GET" && url.pathname === "/operations") {
      if (!(await this.requireOperationsAccess(req, res))) {
        return;
      }
      return this.renderAppShell(res);
    }
    if (req.method === "GET" && ["/teams", "/workspaces"].includes(url.pathname)) {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderAppShell(res);
    }
    if (req.method === "GET" && /^\/(?:teams|workspaces)\/[^/]+\/settings$/.test(url.pathname)) {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderAppShell(res);
    }

    if (req.method === "GET" && /^\/settings\/workflows(?:\/|$)/.test(url.pathname)) {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      const destination = url.pathname.replace(/^\/settings\/workflows/, "/ui/workflows") + url.search;
      res.writeHead(302, { Location: destination });
      return res.end();
    }

    if (url.pathname === "/api/session" && req.method === "GET") {
      const context = await this.authorizer.authenticated(req, res);
      if (!context) {
        return;
      }
      const meUrl = this.oidc?.providerUrl ? new URL("/me", this.oidc.providerUrl).toString() : null;
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          user: {
            id: context.principal.subject,
            name: context.principal.name || "",
            email: context.principal.email || "",
            photo: context.principal.photo || "",
            role: context.principal.platformRole,
            kind: context.principal.kind,
            capabilities: context.principal.platformCapabilities,
          },
          workspaces: await this.principals.workspaceListFor(context.principal.subject),
          meUrl,
        }),
      );
    }

    if (req.method === "GET" && ["/teams/accept", "/workspaces/accept"].includes(url.pathname)) {
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return res.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join team · Flow</title>
<body style="font:16px system-ui;max-width:36rem;margin:15vh auto;padding:1rem;color:#17202a">
<h1>Join a Flow team</h1><p id="status">Checking invitation…</p>
<button id="accept" style="padding:.7rem 1rem" hidden>Accept invitation</button>
<p><a href="/ui/runs">Back to Flow</a></p>
<script>
const status=document.querySelector('#status');
const token=new URLSearchParams(location.hash.slice(1)).get('token')||sessionStorage.getItem('runner-pending-team-invite')||'';
history.replaceState(null,'',location.pathname);
sessionStorage.removeItem('runner-pending-team-invite');
(async()=>{
  if(!token){status.textContent='Invitation link is missing or invalid.';return}
  const sessionResponse=await fetch('/api/v1/auth/session');
  const session=sessionResponse.ok?await sessionResponse.json():{};
  if(!session.authenticated){sessionStorage.setItem('runner-pending-team-invite',token);location.assign('/auth/login?url=%2Fui%2Fteams%2Faccept');return}
  status.textContent='Accept this invitation to join the team.';
  const button=document.querySelector('#accept');button.hidden=false;
  button.addEventListener('click',async()=>{try{const response=await fetch('/api/v1/workspaces/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});if(!response.ok)throw new Error('This invitation is invalid, expired, or for a different verified sign-in email.');status.textContent='You joined the workspace. Redirecting…';setTimeout(()=>location.assign('/ui/settings'),700)}catch(error){status.textContent=error.message}})
})().catch(()=>{status.textContent='Could not validate this invitation. Please try again.'});
</script></body></html>`);
    }
    if (url.pathname.startsWith("/api/teams")) {
      return this.handleTeams(req, res, url);
    }
    if (url.pathname.startsWith("/api/workspaces")) {
      return this.handleTeams(req, res, url);
    }

    if (url.pathname === "/api/preferences" && req.method === "GET") {
      const context = await this.authorizer.human(req, res);
      if (!context) {
        return;
      }
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ timezone: await this.userPreferences.getTimezone(context.principal.subject) }));
    }

    if (url.pathname === "/api/preferences" && req.method === "PUT") {
      const context = await this.authorizer.human(req, res);
      if (!context) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || res.headersSent) {
        return;
      }
      const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
      if (!timezone || timezone.length > 100) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "timezone must be a valid IANA timezone" }));
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "timezone must be a valid IANA timezone" }));
      }
      await this.userPreferences.setTimezone(context.principal.subject, timezone);
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ timezone }));
    }

    if (req.method === "GET" && url.pathname === "/api/users") {
      if (!(await this.requirePlatformCapability(req, res, "platform.users.view"))) {
        return;
      }
      await this.workflowsLoaded;
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ users: await this.oidcUsers.list() }));
    }

    const userRoleMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/role$/);
    if (req.method === "PUT" && userRoleMatch) {
      const actor = await this.requirePlatformCapability(req, res, "platform.users.manage");
      if (!actor) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || res.headersSent) {
        return;
      }
      if (body.role !== "user" && body.role !== "admin") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: 'role must be either "user" or "admin"' }));
      }
      let subject: string;
      try {
        subject = decodeURIComponent(userRoleMatch[1]);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "Invalid user subject" }));
      }
      const result = await this.oidcUsers.setRole(subject, body.role);
      if (result === "not-found") {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "User not found" }));
      }
      if (result === "last-admin") {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "Cannot demote the last administrator" }));
      }
      this.oidc?.setRoleForUser(subject, body.role);
      await this.principals.recordAudit({
        actor: actor.principal.subject,
        action: "platform-role.update",
        target: subject,
        detail: { role: body.role },
      });
      const user = (await this.oidcUsers.list()).find((entry) => entry.id === subject);
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ user }));
    }

    if (req.method === "GET" && url.pathname === "/api/platform/workspaces") {
      if (!(await this.requirePlatformCapability(req, res, "platform.users.view"))) {
        return;
      }
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ workspaces: await this.principals.allWorkspaces() }));
    }

    if (req.method === "GET" && url.pathname === "/api/system-users") {
      if (!(await this.requirePlatformCapability(req, res, "platform.users.view"))) {
        return;
      }
      const principals = (await this.principals.listPrincipals()).filter((entry) => entry.kind === "system");
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ systemUsers: principals }));
    }

    if (req.method === "POST" && url.pathname === "/api/system-users") {
      const actor = await this.requirePlatformCapability(req, res, "platform.users.manage");
      if (!actor) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.name !== "string") {
        if (!res.headersSent) {
          res.writeHead(400).end(JSON.stringify({ error: "name is required" }));
        }
        return;
      }
      try {
        const principal = await this.principals.createSystemUser({
          name: body.name,
          actor: actor.principal.subject,
          email: typeof body.email === "string" ? body.email : undefined,
        });
        res.writeHead(201, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ systemUser: principal }));
      } catch (error: any) {
        res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
        return;
      }
    }

    const systemUserMatch = url.pathname.match(/^\/api\/system-users\/([^/]+)$/);
    if (systemUserMatch && req.method === "PUT") {
      const actor = await this.requirePlatformCapability(req, res, "platform.users.manage");
      if (!actor) {
        return;
      }
      const subject = decodeURIComponent(systemUserMatch[1]);
      const body = await this.readJson(req, res);
      if (!body || res.headersSent) {
        return;
      }
      try {
        const principal = await this.principals.updateSystemUser(
          subject,
          {
            name: typeof body.name === "string" ? body.name : undefined,
            disabled: typeof body.disabled === "boolean" ? body.disabled : undefined,
          },
          actor.principal.subject,
        );
        if (!principal) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
          return;
        }
        res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ systemUser: principal }));
      } catch (error: any) {
        res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
        return;
      }
    }
    if (systemUserMatch && req.method === "DELETE") {
      const actor = await this.requirePlatformCapability(req, res, "platform.users.manage");
      if (!actor) {
        return;
      }
      const subject = decodeURIComponent(systemUserMatch[1]);
      const removed = await this.principals.deleteSystemUser(subject, actor.principal.subject);
      res.writeHead(removed ? 204 : 404).end();
      return;
    }

    if (url.pathname === "/api/api-keys" || /^\/api\/api-keys\/[^/]+$/.test(url.pathname)) {
      res.writeHead(410, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          error: "Legacy API keys are retired. Issue a token for a named system user in workspace settings instead.",
        }),
      );
    }

    const workflowEditorMatch = url.pathname.match(/^\/workflows\/(new|[a-z0-9-]+)$/);
    if (req.method === "GET" && workflowEditorMatch) {
      if (!(await this.requireAuthenticatedUser(req, res))) {
        return;
      }
      return this.renderAppShell(res);
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      if (!(await this.requireAuthenticatedApiRequest(req, res))) {
        return;
      }
      const afterIdParam = url.searchParams.get("afterId");
      const beforeIdParam = url.searchParams.get("beforeId");
      const limitParam = url.searchParams.get("limit");
      const filter = url.searchParams.get("filter")?.trim() || undefined;
      const workflowId = url.searchParams.get("workflowId")?.trim() || undefined;
      const afterId = afterIdParam === null ? undefined : Number(afterIdParam);
      const beforeId = beforeIdParam === null ? undefined : Number(beforeIdParam);
      const limit = limitParam === null ? DASHBOARD_PAGE_SIZE : Number(limitParam);

      if (afterId !== undefined && (!Number.isSafeInteger(afterId) || afterId < 0)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "afterId must be a non-negative integer" }));
      }
      if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "beforeId must be a positive integer" }));
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DASHBOARD_PAGE_SIZE) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: `limit must be an integer from 1 to ${MAX_DASHBOARD_PAGE_SIZE}` }));
      }
      if (filter && filter.length > 200) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "filter must be at most 200 characters" }));
      }

      return this.renderDashboardJobs(req, res, limit, afterId, beforeId, filter, workflowId);
    }

    const workflowApiV1Match = url.pathname.match(/^\/api\/v1\/workflows(?:\/([a-z0-9-]+))?$/);
    const workflowEnabledMatch = url.pathname.match(/^\/api\/v1\/workflows\/([a-z0-9-]+)\/enabled$/);
    if (workflowEnabledMatch && req.method === "PATCH") {
      const authorized = await this.requireWorkspaceCapability(req, res, "workflows.edit");
      if (!authorized) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.enabled !== "boolean") {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "enabled must be a boolean" }));
        }
        return;
      }
      const updated = await this.workflows.setEnabledForTeam(authorized.teamId, workflowEnabledMatch[1], body.enabled);
      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Workflow not found" }));
        return;
      }
      await this.principals.recordAudit({
        actor: authorized.principal.subject,
        action: body.enabled ? "workflow.enable" : "workflow.disable",
        target: workflowEnabledMatch[1],
        teamId: authorized.teamId,
      });
      res.writeHead(204).end();
      return;
    }
    const workflowTransferMatch = url.pathname.match(/^\/api\/v1\/workflows\/([a-z0-9-]+)\/transfer$/);
    if (workflowTransferMatch && req.method === "POST") {
      const source = await this.requireWorkspaceCapability(req, res, "workflows.edit");
      if (!source) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.targetWorkspaceId !== "string" || !body.targetWorkspaceId.trim()) {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "targetWorkspaceId is required" }));
        }
        return;
      }
      const targetWorkspaceId = body.targetWorkspaceId.trim();
      const target = await this.authorizer.workspace(req, res, "workflows.edit", targetWorkspaceId);
      if (!target) {
        return;
      }
      const moved = await this.workflows.transferDraftForTeam(
        source.teamId,
        targetWorkspaceId,
        workflowTransferMatch[1],
      );
      if (!moved) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Only an unexecuted draft can be moved between workspaces" }));
        return;
      }
      await this.principals.recordAudit({
        actor: source.principal.subject,
        action: "workflow.transfer",
        target: workflowTransferMatch[1],
        teamId: source.teamId,
        detail: JSON.stringify({ targetWorkspaceId }),
      });
      await this.principals.recordAudit({
        actor: source.principal.subject,
        action: "workflow.transfer.received",
        target: workflowTransferMatch[1],
        teamId: targetWorkspaceId,
        detail: JSON.stringify({ sourceWorkspaceId: source.teamId }),
      });
      res.writeHead(204).end();
      return;
    }
    if (workflowApiV1Match) {
      const workflowId = workflowApiV1Match[1];
      if (req.method === "GET") {
        const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.view"))?.teamId;
        if (!teamId) {
          return;
        }
        await this.workflowsLoaded;
        if (!workflowId) {
          const workflows =
            url.searchParams.get("activeOnly") === "true"
              ? await this.workflows.listActiveForTeam(teamId)
              : await this.workflows.listForTeam(teamId);
          res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ workflows }));
        }
        const revisionParam = url.searchParams.get("revision");
        const revision = revisionParam === null ? undefined : Number(revisionParam);
        if (revisionParam !== null && (!Number.isSafeInteger(revision) || (revision as number) < 1)) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ error: "revision must be a positive integer" }));
        }
        const owned = await this.workflows.getForTeam(teamId, workflowId);
        const workflow =
          revision === undefined
            ? owned
            : owned
              ? await this.workflows.getRevisionSnapshot(workflowId, revision)
              : null;
        if (!workflow) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ error: "Workflow not found" }));
        }
        res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(workflow));
      }
      if (workflowId && req.method === "PUT") {
        const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.edit"))?.teamId;
        if (!teamId) {
          return;
        }
        const body = await this.readJson(req, res);
        if (!body || typeof body.sourceYaml !== "string") {
          if (!res.headersSent) {
            res
              .writeHead(400, { "Content-Type": "application/json; charset=utf-8" })
              .end(JSON.stringify({ error: "sourceYaml is required" }));
          }
          return;
        }
        try {
          const workflow = await this.workflows.saveDraftForTeam(
            teamId,
            workflowId,
            body.sourceYaml,
            body.enabled !== false,
          );
          res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify(workflow));
        } catch (error: any) {
          res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ error: error.message }));
        }
      }
      if (workflowId && req.method === "DELETE") {
        const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.delete"))?.teamId;
        if (!teamId) {
          return;
        }
        if (!(await this.workflows.deleteForTeam(teamId, workflowId))) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ error: "Workflow not found" }));
        }
        return res.writeHead(204).end();
      }
    }

    const dispatchMatch = url.pathname.match(/^\/api\/dispatch\/([a-z0-9-]+)$/);
    if (req.method === "POST" && dispatchMatch) {
      return this.handleDispatch(req, res, dispatchMatch[1]);
    }
    const workflowRunMatch = url.pathname.match(/^\/api\/workflows\/([a-z0-9-]+)\/run$/);
    if (req.method === "POST" && workflowRunMatch) {
      return this.handleWorkflowRun(req, res, workflowRunMatch[1]);
    }
    const statusMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      return this.handleJobStatus(req, statusMatch[1], res);
    }
    const waitMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/wait$/);
    if (req.method === "GET" && waitMatch) {
      if (!(await this.requireAuthenticatedApiRequest(req, res))) {
        return;
      }
      return this.handleJobWait(req, waitMatch[1], url.searchParams.get("timeout"), res);
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      if (this.isWorker(req)) {
        return this.events.subscribe(req, res, undefined, true);
      }
      const teamId = (await this.requireWorkspaceCapability(req, res, "runs.view"))?.teamId;
      if (!teamId) {
        return;
      }
      return this.events.subscribe(req, res, teamId);
    }

    if (req.method === "GET" && url.pathname === "/api/push/public-key") {
      if (!(await this.requireAuthenticatedApiRequest(req, res))) {
        return;
      }
      return this.handlePushPublicKey(res);
    }
    if (req.method === "POST" && url.pathname === "/api/push/subscriptions") {
      if (!(await this.requireAuthenticatedApiRequest(req, res))) {
        return;
      }
      return this.handlePushSubscribe(req, res);
    }
    if (req.method === "DELETE" && url.pathname === "/api/push/subscriptions") {
      if (!(await this.requireAuthenticatedApiRequest(req, res))) {
        return;
      }
      return this.handlePushUnsubscribe(req, res);
    }

    if (url.pathname === "/api/workflows/validate" && req.method === "POST") {
      return this.handleWorkflowValidation(req, res);
    }

    if (url.pathname === "/api/recipes/validate" && req.method === "POST") {
      return this.handleRecipeValidation(req, res);
    }
    if (url.pathname === "/api/recipes" && req.method === "GET") {
      return this.handleRecipeList(req, res);
    }
    if (url.pathname === "/api/recipes" && req.method === "POST") {
      return this.handleRecipePublish(req, res);
    }
    const recipeVersionMatch = url.pathname.match(
      /^\/api\/recipes\/([a-z0-9-]+)\/([a-z0-9-]+)\/versions\/(\d+)(\/revoke)?$/,
    );
    if (recipeVersionMatch && req.method === "GET" && !recipeVersionMatch[4]) {
      return this.handleRecipeGet(
        req,
        res,
        recipeVersionMatch[1],
        recipeVersionMatch[2],
        Number(recipeVersionMatch[3]),
      );
    }
    if (recipeVersionMatch && req.method === "POST" && recipeVersionMatch[4]) {
      return this.handleRecipeRevoke(
        req,
        res,
        recipeVersionMatch[1],
        recipeVersionMatch[2],
        Number(recipeVersionMatch[3]),
      );
    }

    if (url.pathname === "/api/secrets" && req.method === "GET") {
      return this.handleSecretList(req, res);
    }
    const secretMatch = url.pathname.match(/^\/api\/secrets\/([A-Z][A-Z0-9_]*)$/);
    if (secretMatch && req.method === "PUT") {
      return this.handleSecretSave(req, res, secretMatch[1]);
    }
    if (secretMatch && req.method === "DELETE") {
      return this.handleSecretDelete(req, res, secretMatch[1]);
    }
    const jobSecretsMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/secrets$/);
    if (jobSecretsMatch && req.method === "GET") {
      return this.handleJobSecrets(req, res, jobSecretsMatch[1]);
    }
    const cancelJobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/cancel$/);
    if (cancelJobMatch && req.method === "POST") {
      return this.handleCancelJob(req, res, cancelJobMatch[1]);
    }

    if (url.pathname === "/api/workflows" && req.method === "GET") {
      return this.handleWorkflowList(req, res);
    }

    const workflowMatch = url.pathname.match(/^\/api\/workflows\/([a-z0-9-]+)(\/publish)?$/);
    if (workflowMatch) {
      const [, workflowId, publish] = workflowMatch;
      if (req.method === "GET" && !publish) {
        return this.handleWorkflowGet(req, res, workflowId, url.searchParams.get("revision"));
      }
      if (req.method === "PUT" && !publish) {
        return this.handleWorkflowSave(req, res, workflowId);
      }
      if (req.method === "DELETE" && !publish) {
        return this.handleWorkflowDelete(req, res, workflowId);
      }
      if (req.method === "POST" && publish) {
        return this.handleWorkflowPublish(req, res, workflowId);
      }
    }

    if (req.method === "POST" && url.pathname === "/api/events") {
      return this.handleWorkerEvent(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/ai/workflow-help") {
      return this.handleWorkflowAiHelp(req, res);
    }

    if (req.method === "GET" && /^\/runs\/\d+$/.test(url.pathname)) {
      return this.renderAppShell(res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
      const jobId = url.pathname.replace("/runs/", "");
      return this.renderRunDetails(req, jobId, res, "html");
    }

    const aiHelpMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/ai-help$/);
    if (req.method === "POST" && aiHelpMatch) {
      return this.handleAiHelp(req, res, aiHelpMatch[1]);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      if (!(await this.requireAuthenticatedApiRequest(req, res))) {
        return;
      }
      const diagnosticsMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/diagnostics$/);
      if (diagnosticsMatch) {
        return this.handleDiagnostics(req, res, diagnosticsMatch[1]);
      }
      const artifactMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/artifacts\/(.+)$/);
      if (artifactMatch) {
        return this.handleArtifactDownload(req, res, artifactMatch[1], decodeURIComponent(artifactMatch[2]));
      }
      const jobId = url.pathname.replace("/api/runs/", "");
      return this.renderRunDetails(req, jobId, res, "json");
    }

    const deleteRunMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (deleteRunMatch && req.method === "DELETE") {
      const authorized = await this.requireWorkspaceCapability(req, res, "runs.delete");
      if (!authorized) {
        return;
      }
      const removed = await this.queue.deleteJobForTeam(authorized.teamId, deleteRunMatch[1]);
      if (removed) {
        await this.principals.recordAudit({
          actor: authorized.principal.subject,
          action: "run.delete",
          target: deleteRunMatch[1],
          teamId: authorized.teamId,
        });
      }
      res.writeHead(removed ? 204 : 404).end();
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/restart/")) {
      const jobId = url.pathname.replace("/restart/", "");
      return this.handleRestartJob(req, jobId, res);
    }

    if (req.method === "POST" && url.pathname === "/admin/reload-secrets") {
      return this.handleSecretReload(req, res);
    }

    if (req.method === "POST" && url.pathname.startsWith("/webhooks/team/")) {
      const match = url.pathname.match(/^\/webhooks\/team\/([^/]+)\/([a-z0-9-]+)$/);
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      const team = await this.teams.teamForWebhookToken(decodeURIComponent(match[1]));
      if (!team) {
        res.writeHead(404).end();
        return;
      }
      return this.handleWebhook(match[2], req, res, team.id);
    }

    if (req.method === "POST" && url.pathname.startsWith("/webhooks/workspace/")) {
      const token = url.pathname.slice("/webhooks/workspace/".length);
      const webhook = await this.workspaceWebhooks.lookupByToken(decodeURIComponent(token));
      if (!webhook) {
        res.writeHead(404).end();
        return;
      }
      return this.handleWebhook(webhook.provider, req, res, webhook.workspaceId, webhook.signingSecret);
    }

    if (req.method === "POST" && url.pathname.startsWith("/webhooks/")) {
      const provider = url.pathname.replace("/webhooks/", "");
      const workspaceId = await this.legacyWebhookWorkspace();
      if (!workspaceId) {
        res.writeHead(404).end();
        return;
      }
      return this.handleWebhook(provider, req, res, workspaceId);
    }

    // Keep machine-readable errors for APIs, but give browser navigation a helpful not-found page.
    if ((req.method === "GET" || req.method === "HEAD") && req.headers.accept?.includes("text/html")) {
      return this.sendHtmlError(
        res,
        {
          status: 404,
          title: "We couldn't find that page",
          message: "The link may be out of date, or the page may have moved.",
          action: { label: "Back to Flow", href: "/ui/runs" },
        },
        req.method === "HEAD",
      );
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  }

  private sendHtmlError(res: http.ServerResponse, options: ErrorPageOptions, headOnly = false) {
    res.writeHead(options.status, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    });
    return res.end(headOnly ? undefined : renderErrorPage(options));
  }

  /**
   * Processes incoming HTTP webhooks
   */
  private async handleWebhook(
    provider: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    teamId: string,
    signingSecret?: string,
  ) {
    try {
      const { rawBuffer, headers } = await this.readRequest(req, res);

      if (res.headersSent || !rawBuffer) {
        return;
      }

      const { isValid, inputs, secretValues } = await this.preprocess(
        provider,
        headers,
        rawBuffer,
        teamId,
        signingSecret,
      );

      if (!isValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid HMAC signature or authentication failed" }));
        return;
      }

      await this.workflowsLoaded;
      await this.matchWorkflows(provider, inputs, await this.workflows.publishedForTeam(teamId), secretValues, teamId);

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "OK" }));
    } catch (err: any) {
      console.error("❌ Webhook Ingress Error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Ingress Error", details: err.message }));
    }
  }

  /** Keep the legacy provider URL/secret serving the adopted workspace until its webhook is cut over. */
  private async legacyWebhookWorkspace(): Promise<string | null> {
    const markerTable = await db.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_adoptions'",
    );
    if (!markerTable) {
      return null;
    }
    const adoption = await db.get(
      "SELECT target_workspace_id FROM workspace_adoptions WHERE version = ? AND source_workspace_id = 'default'",
      ["default-to-workspace-v1"],
    );
    return adoption?.target_workspace_id || null;
  }

  private async handleDispatch(req: http.IncomingMessage, res: http.ServerResponse, provider: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.dispatch"))?.teamId;
    if (!teamId) {
      return;
    }
    const body = await this.readJson(req, res);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return;
    }
    const jobs = await this.matchWorkflows(
      provider,
      body,
      await this.workflows.publishedForTeam(teamId),
      await this.currentSecrets(teamId),
      teamId,
    );
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ jobs: jobs.map((id) => ({ id, provider })) }));
  }

  /** Resolve/enqueue a child run only from a live, team-owned runner lease. */
  private async dispatchFromLease(job: any, body: any) {
    const fail = (status: number, message: string): never => {
      const error: any = new Error(message);
      error.status = status;
      throw error;
    };
    if (
      !body ||
      body.jobId !== job.id ||
      typeof body.stepId !== "string" ||
      !/^[\w.-]{1,100}$/.test(body.stepId) ||
      typeof body.target !== "string" ||
      !body.target.trim() ||
      !body.inputs ||
      typeof body.inputs !== "object" ||
      Array.isArray(body.inputs) ||
      job.status !== "running" ||
      !job.team_id
    ) {
      fail(400, "Invalid dispatch request");
    }
    if (Buffer.byteLength(JSON.stringify(body.inputs)) > 256_000) {
      fail(413, "Dispatch inputs exceed 256KB");
    }
    const depth = await db.get(
      `WITH RECURSIVE ancestors(id, parentId, depth) AS (
         SELECT id, parentId, 0 FROM jobs WHERE id = ? AND team_id = ?
         UNION ALL SELECT p.id, p.parentId, ancestors.depth + 1 FROM jobs p JOIN ancestors ON p.id = ancestors.parentId
         WHERE p.team_id = ? AND ancestors.depth < 10
       ) SELECT MAX(depth) AS depth FROM ancestors`,
      [job.id, job.team_id, job.team_id],
    );
    if (Number(depth?.depth || 0) >= 5) {
      fail(400, "Dispatch depth limit exceeded");
    }
    const candidates = await this.workflows.publishedForTeam(job.team_id);
    const matches = candidates.filter(
      ({ workflowId, definition }) =>
        workflowId === body.target || definition.id === body.target || definition.name === body.target,
    );
    if (matches.length !== 1) {
      fail(
        matches.length ? 409 : 404,
        matches.length ? "Workflow target name is ambiguous" : "Workflow not found in workspace",
      );
    }
    const { workflowId, definition, revision } = matches[0];
    const tags = await resolveMatrixTags(definition.tags, {}, body.inputs);
    const downstreamId = await this.queue.enqueueDispatch(
      workflowId,
      revision,
      { inputs: body.inputs },
      tags,
      job.team_id,
      job.id,
      `dispatch:${job.id}:${body.stepId}`,
    );
    if (!downstreamId) {
      fail(404, "Workflow target is not workspace-owned");
    }
    this.events.publish("jobs.available", { tags, teamId: job.team_id });
    return { jobId: downstreamId, workflowId, parentId: job.id };
  }

  private async handleWorkflowRun(req: http.IncomingMessage, res: http.ServerResponse, workflowId: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.dispatch"))?.teamId;
    if (!teamId) {
      return;
    }
    const body = await this.readJson(req, res);
    if (body === null && res.headersSent) {
      return;
    }
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Request body must be an object" }));
    }

    await this.workflowsLoaded;
    const owned = await this.workflows.getForTeam(teamId, workflowId);
    const latest = owned ? await this.workflows.latestRevision(workflowId) : null;
    if (!latest) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Workflow not found" }));
    }

    const suppliedInputs = body?.inputs;
    if (
      suppliedInputs !== undefined &&
      (typeof suppliedInputs !== "object" || suppliedInputs === null || Array.isArray(suppliedInputs))
    ) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "inputs must be an object" }));
    }
    const inputs = { ...(suppliedInputs || {}), trigger: { type: "manual", source: "editor" } };
    const jobs: number[] = [];
    for (const variant of expandMatrix(latest.definition)) {
      const requiredTags = await resolveMatrixTags(variant.tags, variant.matrixContext, inputs);
      const jobId = await this.queue.enqueue(
        workflowId,
        latest.revision,
        { inputs, matrix: variant.matrixContext },
        requiredTags,
        "",
      );
      if (jobId) {
        jobs.push(jobId);
      }
      this.events.publish("jobs.available", { tags: requiredTags, teamId });
    }

    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ workflowId, revision: latest.revision, jobs }));
  }

  private async handleJobWait(
    req: http.IncomingMessage,
    jobId: string,
    timeoutParam: string | null,
    res: http.ServerResponse,
  ) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.view"))?.teamId;
    if (!teamId) {
      return;
    }
    const timeout = Math.min(120_000, Math.max(0, Number(timeoutParam || 30_000)));
    const started = Date.now();
    let job;
    do {
      job = await this.queue.getJobForTeam(teamId, jobId);
      if (!job || ["success", "failed", "cancelled"].includes(job.status) || Date.now() - started >= timeout) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (true);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Job not found" }));
    }
    const payload = {
      job: toDashboardJobs([job])[0],
      terminal: ["success", "failed", "cancelled"].includes(job.status),
    };
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(this.redactStructured(payload, await this.currentSecrets(teamId))));
  }

  private async handleJobStatus(req: http.IncomingMessage, jobId: string, res: http.ServerResponse) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.view"))?.teamId;
    if (!teamId) {
      return;
    }
    const job = await this.queue.getJobForTeam(teamId, jobId);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Job not found" }));
    }
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        id: Number(job.id),
        status: job.status,
        createdAt: job.created_at,
        lastUpdated: job.updated_at,
      }),
    );
  }

  private async handleDiagnostics(req: http.IncomingMessage, res: http.ServerResponse, jobId: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.logs"))?.teamId;
    if (!teamId) {
      return;
    }
    const job = await this.queue.getJobForTeam(teamId, jobId);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Run not found" }));
    }
    const report = job.report ? JSON.parse(job.report) : null;
    const definition = await this.workflows.getRevision(job.workflow_id, job.workflow_revision);
    const snapshot = await this.workflows.getRevisionSnapshot(job.workflow_id, job.workflow_revision);
    const logs = await this.queue.getJobLogs(jobId);
    const secrets = await this.currentSecrets(teamId);
    const safeReport = this.redactStructured(report || {}, secrets);
    const safeLogs = this.redactStructured(logs, secrets);
    const failedIndex = report?.steps?.findIndex((step) => step.status === "failed") ?? -1;
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        jobId: String(job.id),
        workflow: {
          id: job.workflow_id,
          revision: job.workflow_revision,
          sourceYaml: snapshot?.sourceYaml ? this.redact(snapshot.sourceYaml, secrets) : undefined,
        },
        status: job.status,
        inputs: safeReport.inputs || {},
        failedStep: failedIndex >= 0 ? safeReport.steps[failedIndex] : null,
        steps: failedIndex >= 0 ? safeReport.steps.slice(0, failedIndex + 1) : safeReport.steps || [],
        logs: safeLogs,
        artifacts: safeReport.artifacts || [],
        workflowFound: Boolean(definition),
      }),
    );
  }

  private async readRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_PAYLOAD_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload size exceeds limit" }));
        return { rawBuffer: null, headers: {} };
      }

      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    const rawBuffer = Buffer.concat(chunks);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v || ""]),
    );

    return { rawBuffer, headers };
  }

  private async preprocess(provider: string, headers, rawBuffer: Buffer, teamId: string, signingSecret?: string) {
    let dbSecrets: Record<string, string> = {};
    try {
      dbSecrets = await this.secretRepository.getAllForTeam(teamId);
    } catch (error) {
      if (process.env.RUNNER_MASTER_KEY || process.env.CREDENTIALS_DIRECTORY) {
        throw error;
      }
    }
    const secret = signingSecret || dbSecrets[`${provider.toUpperCase()}_WEBHOOK_SECRET`] || undefined;
    const preprocessor = this.preprocessors.get(provider);
    try {
      if (preprocessor) {
        const result = preprocessor.parse(headers, rawBuffer, secret);
        const { inputs, isValid } = result;
        return { inputs, isValid, secretValues: dbSecrets };
      }

      // Provider registrations are routing labels, not parsers. Verify the
      // GitHub-compatible signature against the untouched request bytes and
      // expose the transport envelope for workflow-owned normalization.
      const signature = headers["x-hub-signature-256"];
      // A configured secret always makes a signature mandatory, regardless
      // of whether it came from a per-registration secret or workspace secret.
      // Alias ingress is an authenticated webhook boundary; never accept an
      // unsigned request merely because a workspace has not configured a key.
      let isValid = false;
      if (secret && signature) {
        const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBuffer).digest("hex")}`;
        const suppliedBytes = Buffer.from(String(signature));
        const expectedBytes = Buffer.from(expected);
        isValid = suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
      }
      const body = JSON.parse(rawBuffer.toString("utf-8"));
      if (!body || typeof body !== "object" || Array.isArray(body) || !isValid) {
        return { isValid: false, inputs: null, secretValues: dbSecrets };
      }
      // Only forward event metadata needed by intake workflows. An arbitrary
      // webhook header may contain a credential and is persisted with inputs.
      const safeHeaderNames = new Set([
        "content-type",
        "user-agent",
        "x-github-event",
        "x-github-delivery",
        "x-github-hook-id",
      ]);
      const safeHeaders = Object.fromEntries(
        Object.entries(headers).filter(([name]) => safeHeaderNames.has(name.toLowerCase())),
      );
      const inputs = { ...body, body, raw: body, headers: safeHeaders, request: { body, headers: safeHeaders } };
      return { isValid, inputs, secretValues: dbSecrets };
    } catch {
      return { isValid: false, inputs: null, secretValues: dbSecrets };
    }
  }

  private async matchWorkflows(
    provider: string,
    inputs: any,
    workflows: import("./types.js").WorkflowRevision[],
    secretValues: Record<string, string> = {},
    teamId: string,
  ) {
    const jobIds: number[] = [];
    for (const { definition: workflow, revision } of workflows) {
      if (workflow.on.provider !== provider) {
        continue;
      }

      const preprocessor = this.preprocessors.get(provider);
      if (preprocessor?.filter && !preprocessor.filter(inputs, workflow.on).isValid) {
        debug(`⏩ Skipped ${workflow.id} based on ${provider} webhook filters`, { inputs });
        continue;
      }

      if (workflow.on.if) {
        try {
          const conditionContext = preprocessor?.conditionContext?.(inputs, secretValues) || {};
          const shouldRun = await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, {
            inputs,
            ...conditionContext,
          });

          if (!shouldRun) {
            debug(`⏩ Skipped ${workflow.id} based on conditions: ${workflow.on.if}`, { inputs });
            continue;
          }
        } catch (evalErr: any) {
          console.error(`⚠️ Condition evaluation error in workflow [${workflow.id}]:`, evalErr.message);
          continue; // Skip this workflow without crashing server
        }
      }

      for (const variant of expandMatrix(workflow)) {
        const requiredTags = await resolveMatrixTags(variant.tags, variant.matrixContext, inputs);
        let concurrencyKey = "";
        if (variant.concurrency?.group) {
          concurrencyKey = await SafeExpressionEvaluator.evaluateValue(variant.concurrency.group, { inputs });
        }

        const jobPayload: JobPayload = {
          inputs,
          matrix: variant.matrixContext,
        };

        const jobId = await this.queue.enqueue(workflow.id, revision, jobPayload, requiredTags, concurrencyKey);
        if (jobId) {
          jobIds.push(jobId);
        }
        this.events.publish("jobs.available", { tags: requiredTags, teamId });
      }
    }
    return jobIds;
  }

  private isAdmin(req: http.IncomingMessage): boolean {
    // Cached session role is only used for redirect UX. Every authorization
    // decision resolves the principal from storage.
    return this.oidc?.roleFromCookie(req.headers.cookie) === "admin";
  }

  private isWorker(req: http.IncomingMessage): boolean {
    return this.matchesToken(req, this.workerToken, false);
  }

  private async authenticateRunner(req: http.IncomingMessage, res: http.ServerResponse) {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const runner = await this.runners.authenticate(token);
    if (!runner) {
      res.writeHead(401, {
        "Cache-Control": "no-store",
        "WWW-Authenticate": "Bearer",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Runner credential is invalid or revoked" }));
      return null;
    }
    return runner;
  }

  /** Resolve a live principal. Sessions and bearers must agree when both exist. */
  private async authenticate(req: http.IncomingMessage, res: http.ServerResponse): Promise<AuthContext | null> {
    return this.authorizer.authenticated(req, res);
  }

  private async requireAuthenticatedUser(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    return Boolean(await this.authenticate(req, res));
  }

  private async requireAuthenticatedApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    return Boolean(await this.authenticate(req, res));
  }

  /** Require one workspace capability and return the resolved workspace. */
  private async requireWorkspaceCapability(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    capability: WorkspaceCapability,
    teamId?: string,
  ): Promise<WorkspaceAuthorization | null> {
    return this.authorizer.workspace(req, res, capability, teamId);
  }

  private async requirePlatformCapability(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    capability: GlobalCapability,
  ): Promise<AuthContext | null> {
    return this.authorizer.platform(req, res, capability);
  }

  private async handleTeams(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const context = await this.authorizer.authenticated(req, res);
    if (!context) {
      return;
    }
    await this.workflowsLoaded;
    const workspaceApi = url.pathname === "/api/workspaces" || url.pathname.startsWith("/api/workspaces/");
    const basePath = workspaceApi ? "/api/workspaces" : "/api/teams";
    const prefix = workspaceApi ? "workspaces" : "teams";

    if (url.pathname === basePath && req.method === "GET") {
      const isAdmin = await this.authorizer.hasOidcAdmin(req, context.principal);
      const workspaces = isAdmin
        ? await this.teams.listAll()
        : await this.principals.workspaceListFor(context.principal.subject);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ [workspaceApi ? "workspaces" : "teams"]: workspaces }));
      return;
    }

    if (url.pathname === basePath && req.method === "POST") {
      if (context.principal.kind !== "human") {
        deny(res, 403, "Only a human user can create a workspace");
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.name !== "string" || !body.name.trim()) {
        if (!res.headersSent) {
          res.writeHead(400).end();
        }
        return;
      }
      try {
        const team = await this.teams.createTeam(body.name, context.principal.subject);
        await this.principals.recordAudit({
          actor: context.principal.subject,
          action: "workspace.create",
          target: team.id,
          teamId: team.id,
        });
        res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
          JSON.stringify({
            [workspaceApi ? "workspace" : "team"]: { id: team.id, name: team.name, role: "admin" },
            ...(!workspaceApi
              ? { webhookPath: `/api/v1/webhooks/team/${encodeURIComponent(team.webhookToken)}/{provider}` }
              : {}),
          }),
        );
      } catch (error: any) {
        res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    const workspaceMatch = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)$`));
    if (workspaceMatch && req.method === "DELETE") {
      const teamId = decodeURIComponent(workspaceMatch[1]);
      const authorized = await this.authorizer.workspace(req, res, "workspace.delete", teamId);
      if (!authorized) {
        return;
      }
      if (!(await this.teams.markWorkspaceDeleting(teamId))) {
        res.writeHead(404).end();
        return;
      }
      await this.queue.deleteJobsForTeam(teamId);
      const removed = await this.teams.deleteWorkspace(teamId);
      await this.principals.recordAudit({
        actor: authorized.principal.subject,
        action: "workspace.delete",
        target: teamId,
        teamId,
      });
      res.writeHead(removed ? 204 : 404).end();
      return;
    }
    if (workspaceMatch && (req.method === "PATCH" || req.method === "PUT")) {
      const teamId = decodeURIComponent(workspaceMatch[1]);
      const authorized = await this.authorizer.workspace(req, res, "settings.manage", teamId);
      if (!authorized) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.name !== "string") {
        if (!res.headersSent) {
          res.writeHead(400).end(JSON.stringify({ error: "name is required" }));
        }
        return;
      }
      try {
        const updated = await this.teams.renameTeam(teamId, body.name);
        await this.principals.recordAudit({
          actor: authorized.principal.subject,
          action: "workspace.rename",
          target: teamId,
          teamId,
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ workspace: updated }));
      } catch (error: any) {
        res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (url.pathname.match(new RegExp(`^/api/${prefix}/[^/]+/api-keys(?:/[^/]+)?$`))) {
      res.writeHead(410, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "Legacy API keys are retired. Issue a token for a named system user in workspace settings instead.",
        }),
      );
      return;
    }

    const permissionsMatch = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/permissions$`));
    if (permissionsMatch && req.method === "GET") {
      const teamId = decodeURIComponent(permissionsMatch[1]);
      const authorized = await this.authorizer.workspace(req, res, "members.view", teamId);
      if (!authorized) {
        return;
      }
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          workspace: { id: teamId, role: authorized.role },
          roles: WORKSPACE_ROLE_CAPABILITIES,
          roleLabels: WORKSPACE_ROLE_LABELS,
          groups: WORKSPACE_CAPABILITY_GROUPS,
          members: (await this.principals.listMembers(teamId)).map((member) =>
            memberViewForCaller(member, authorized.capabilities.includes("members.manage")),
          ),
          canManage: authorized.capabilities.includes("members.manage"),
        }),
      );
      return;
    }

    const systemUsersMatch = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/system-users$`));
    if (systemUsersMatch && req.method === "POST") {
      const teamId = decodeURIComponent(systemUsersMatch[1]);
      const authorized = await this.authorizer.workspace(req, res, "tokens.manage", teamId);
      if (!authorized) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.name !== "string") {
        if (!res.headersSent) {
          res.writeHead(400).end(JSON.stringify({ error: "name is required" }));
        }
        return;
      }
      try {
        const principal = await this.principals.createSystemUser({
          name: body.name,
          actor: authorized.principal.subject,
        });
        await this.principals.addMember(teamId, principal.subject, "collaborator", authorized.principal.subject);
        await this.principals.recordAudit({
          actor: authorized.principal.subject,
          action: "system-user.create",
          target: principal.subject,
          teamId,
          detail: { name: principal.name },
        });
        res.writeHead(201, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ systemUser: principal }));
      } catch (error: any) {
        res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    const tokensMatch = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/tokens$`));
    const tokenMatch = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/tokens/([^/]+)$`));
    if (tokensMatch && req.method === "GET") {
      const teamId = decodeURIComponent(tokensMatch[1]);
      if (!(await this.authorizer.workspace(req, res, "tokens.view", teamId))) {
        return;
      }
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ tokens: await this.principals.listTokensForWorkspace(teamId) }));
      return;
    }
    if (tokensMatch && req.method === "POST") {
      const teamId = decodeURIComponent(tokensMatch[1]);
      const authorized = await this.authorizer.workspace(req, res, "tokens.manage", teamId);
      if (!authorized) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.subject !== "string" || typeof body.name !== "string") {
        if (!res.headersSent) {
          res.writeHead(400).end(JSON.stringify({ error: "subject and name are required" }));
        }
        return;
      }
      const membership = await this.principals.membership(teamId, body.subject);
      const principal = await this.principals.principal(body.subject);
      if (!membership || !principal || principal.kind !== "system") {
        res
          .writeHead(404, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "A system user in this workspace is required" }));
        return;
      }
      try {
        const token = await this.principals.issueToken(body.subject, body.name, authorized.principal.subject);
        res.writeHead(201, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(token));
      } catch (error: any) {
        res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (tokenMatch && req.method === "DELETE") {
      const teamId = decodeURIComponent(tokenMatch[1]);
      const authorized = await this.authorizer.workspace(req, res, "tokens.manage", teamId);
      if (!authorized) {
        return;
      }
      const tokenId = decodeURIComponent(tokenMatch[2]);
      const owned = (await this.principals.listTokensForWorkspace(teamId)).some((token) => token.id === tokenId);
      if (!owned) {
        res.writeHead(404).end();
        return;
      }
      const revoked = await this.principals.revokeToken(tokenId, authorized.principal.subject, teamId);
      res.writeHead(revoked ? 204 : 404).end();
      return;
    }

    const webhooks = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/webhooks$`));
    const webhook = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/webhooks/([^/]+)$`));
    if (webhooks && ["GET", "POST"].includes(req.method || "")) {
      const teamId = decodeURIComponent(webhooks[1]);
      const capability = req.method === "GET" ? "webhooks.view" : "webhooks.manage";
      const authorized = await this.authorizer.workspace(req, res, capability, teamId);
      if (!authorized) {
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ webhooks: await this.workspaceWebhooks.list(teamId) }));
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.provider !== "string") {
        if (!res.headersSent) {
          res.writeHead(400).end(JSON.stringify({ error: "provider is required" }));
        }
        return;
      }
      try {
        const created = await this.workspaceWebhooks.create(teamId, body.provider);
        await this.principals.recordAudit({
          actor: authorized.principal.subject,
          action: "workspace.webhook.create",
          target: created.id,
          teamId,
          detail: { provider: created.provider },
        });
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(
          JSON.stringify({
            webhook: { id: created.id, provider: created.provider, createdAt: created.createdAt },
            url: `/api/v1/webhooks/workspace/${encodeURIComponent(created.token)}`,
            signingSecret: created.signingSecret,
          }),
        );
      } catch (error: any) {
        res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (webhook && req.method === "DELETE") {
      const teamId = decodeURIComponent(webhook[1]);
      const authorized = await this.authorizer.workspace(req, res, "webhooks.manage", teamId);
      if (!authorized) {
        return;
      }
      const webhookId = decodeURIComponent(webhook[2]);
      const removed = await this.workspaceWebhooks.revoke(teamId, webhookId);
      if (removed) {
        await this.principals.recordAudit({
          actor: authorized.principal.subject,
          action: "workspace.webhook.revoke",
          target: webhookId,
          teamId,
        });
      }
      res.writeHead(removed ? 204 : 404).end();
      return;
    }

    const invite = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/invitations$`));
    const members = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/members$`));
    const member = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/members/([^/]+)$`));
    if (member && req.method === "PUT") {
      const teamId = decodeURIComponent(member[1]);
      const subject = decodeURIComponent(member[2]);
      const authorized = await this.authorizer.workspace(req, res, "members.manage", teamId);
      if (!authorized) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || !isWorkspaceRole(body.role)) {
        if (!res.headersSent) {
          res.writeHead(400).end(JSON.stringify({ error: "role must be viewer, collaborator, or admin" }));
        }
        return;
      }
      const overrides = sanitizeWorkspaceOverrides(body.overrides);
      const result = await this.principals.setMemberPermissions(
        teamId,
        subject,
        body.role,
        overrides,
        authorized.principal.subject,
      );
      if (result === "updated") {
        res.writeHead(204).end();
        return;
      }
      const status = result === "not-found" ? 404 : 409;
      const error =
        result === "last-admin"
          ? "A workspace must retain at least one admin"
          : result === "system-user-elevation"
            ? "System users cannot be workspace admins"
            : "Workspace member not found";
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
      return;
    }
    if (member && req.method === "DELETE") {
      const teamId = decodeURIComponent(member[1]);
      const subject = decodeURIComponent(member[2]);
      const authorized = await this.authorizer.workspace(req, res, "members.manage", teamId);
      if (!authorized) {
        return;
      }
      const result = await this.principals.removeMember(teamId, subject, authorized.principal.subject);
      if (result === "admin") {
        res
          .writeHead(409, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "A workspace must retain at least one admin" }));
        return;
      }
      res.writeHead(result === "removed" ? 204 : 404).end();
      return;
    }
    if (members && req.method === "GET") {
      const teamId = decodeURIComponent(members[1]);
      const authorized = await this.authorizer.workspace(req, res, "members.view", teamId);
      if (!authorized) {
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
        JSON.stringify({
          members: (await this.principals.listMembers(teamId)).map((member) =>
            memberViewForCaller(member, authorized.capabilities.includes("members.manage")),
          ),
        }),
      );
      return;
    }
    if (members && req.method === "POST") {
      const teamId = decodeURIComponent(members[1]);
      const authorized = await this.authorizer.workspace(req, res, "members.manage", teamId);
      if (!authorized) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.subject !== "string") {
        if (!res.headersSent) {
          res.writeHead(400).end(JSON.stringify({ error: "subject is required" }));
        }
        return;
      }
      const role = isWorkspaceRole(body.role) ? body.role : "collaborator";
      const result = await this.principals.addMember(teamId, body.subject, role, authorized.principal.subject);
      if (result === "added") {
        res.writeHead(201).end();
        return;
      }
      const status = result === "not-found" ? 404 : result === "exists" ? 409 : 409;
      const error =
        result === "system-user-elevation"
          ? "System users cannot be workspace admins"
          : result === "exists"
            ? "Principal is already a member"
            : "Principal not found";
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
      return;
    }
    if (invite && req.method === "POST") {
      const teamId = decodeURIComponent(invite[1]);
      const authorized = await this.authorizer.workspace(req, res, "members.manage", teamId);
      if (!authorized) {
        return;
      }
      const body = await this.readJson(req, res);
      if (!body || typeof body.email !== "string") {
        return;
      }
      try {
        const record = await this.teams.createInvitation(teamId, body.email, authorized.principal.subject);
        res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
          JSON.stringify({
            link: `/ui/teams/accept#token=${encodeURIComponent(record.token)}`,
            expiresAt: record.expiresAt,
          }),
        );
      } catch (e: any) {
        res.writeHead(422).end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    const rotateWebhook = url.pathname.match(new RegExp(`^/api/${prefix}/([^/]+)/webhook-token$`));
    if (rotateWebhook && req.method === "POST") {
      const teamId = decodeURIComponent(rotateWebhook[1]);
      if (!(await this.authorizer.workspace(req, res, "settings.manage", teamId))) {
        return;
      }
      const token = await this.teams.rotateWebhookToken(teamId);
      if (!token) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ webhookPath: `/api/v1/webhooks/team/${encodeURIComponent(token)}/{provider}` }));
      return;
    }
    if ((url.pathname === "/api/teams/accept" || url.pathname === "/api/workspaces/accept") && req.method === "POST") {
      const human = await this.authorizer.human(req, res);
      if (!human) {
        return;
      }
      const body = await this.readJson(req, res);
      const email = human.principal.email;
      if (!body || typeof body.token !== "string" || !email) {
        res.writeHead(403).end(JSON.stringify({ error: "A verified sign-in email is required" }));
        return;
      }
      const result = await this.teams.acceptInvitation(body.token, human.principal.subject, email);
      res
        .writeHead(result === "accepted" ? 200 : 404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ result }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
  }

  private async userForRequest(req: http.IncomingMessage) {
    const sessionUser = this.oidc?.userFromCookie(req.headers.cookie);
    if (sessionUser) {
      return sessionUser;
    }
    const bearer = this.oidcBearer(req);
    return bearer ? await this.oidc?.userFromAccessToken(bearer) : undefined;
  }

  private requireSameOrigin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const origin = req.headers.origin;
    const requestHost = String(req.headers.host || "")
      .trim()
      .toLowerCase();
    try {
      const parsedOrigin = origin ? new URL(origin) : null;
      if (
        parsedOrigin &&
        ["http:", "https:"].includes(parsedOrigin.protocol) &&
        parsedOrigin.host.toLowerCase() === requestHost
      ) {
        return true;
      }
    } catch {
      // Reject malformed Origin and Host values.
    }
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Same-origin request required" }));
    return false;
  }

  private async handleOidcLogin(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const requestedReturnTo = url.searchParams.get("url") || "/ui/runs";
    const sanitizedReturnTo = safeReturnUrl(requestedReturnTo);
    if (!this.oidc?.enabled) {
      return this.sendHtmlError(res, {
        status: 503,
        title: "Sign-in is unavailable",
        message: "Authentication is not configured on this server. Please contact your administrator.",
        action: { label: "Back to Flow", href: "/ui/runs" },
      });
    }
    try {
      res.writeHead(302, { Location: await this.oidc.loginUrl(this.oidcRedirectUri(req), sanitizedReturnTo) });
      return res.end();
    } catch (error: any) {
      return this.sendHtmlError(res, {
        status: 503,
        title: "Couldn't start sign-in",
        message: "The authentication service couldn't be reached. Please try again shortly.",
        action: { label: "Try again", href: `/auth/login?url=${encodeURIComponent(sanitizedReturnTo)}` },
        secondaryAction: { label: "Back to Flow", href: "/ui/runs" },
      });
    }
  }

  private async handleOidcCallback(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (!this.oidc?.enabled) {
      return this.sendHtmlError(res, {
        status: 503,
        title: "Sign-in is unavailable",
        message: "Authentication is not configured on this server. Please contact your administrator.",
        action: { label: "Back to Flow", href: "/ui/runs" },
      });
    }
    if (url.searchParams.get("error")) {
      return this.sendHtmlError(res, {
        status: 401,
        title: "Sign-in wasn't completed",
        message: "You cancelled sign-in or the identity provider couldn't authenticate you. You can safely try again.",
        action: { label: "Try signing in again", href: "/auth/login?url=%2Fui%2Fruns" },
        secondaryAction: { label: "Back to Flow", href: "/ui/runs" },
      });
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return this.sendHtmlError(res, {
        status: 400,
        title: "Sign-in link is incomplete",
        message: "The identity provider returned an incomplete response. Please start sign-in again.",
        action: { label: "Try signing in again", href: "/auth/login?url=%2Fui%2Fruns" },
        secondaryAction: { label: "Back to Flow", href: "/ui/runs" },
      });
    }
    try {
      const result = await this.oidc.completeLogin(code, state, this.oidcRedirectUri(req));
      const user = this.oidc.userFromCookie(result.cookie);
      if (user) {
        await this.oidcUsers.upsert(user);
        this.oidc.setRole(result.cookie, await this.oidcUsers.role(user.id));
      }
      // Validate return target again before redirecting
      const safeReturnTo = safeReturnUrl(result.returnTo);
      res.writeHead(302, {
        Location: safeReturnTo,
        "Set-Cookie": `${result.cookie}${this.isHttps(req) ? "; Secure" : ""}`,
      });
      return res.end();
    } catch (error: any) {
      return this.sendHtmlError(res, {
        status: 502,
        title: "Couldn't complete sign-in",
        message:
          "We couldn't verify your identity with the sign-in provider. Please try again. If the problem continues, contact your administrator.",
        action: { label: "Try signing in again", href: "/auth/login?url=%2Fui%2Fruns" },
        secondaryAction: { label: "Back to Flow", href: "/ui/runs" },
      });
    }
  }

  private handleOidcLogout(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.oidc) {
      return this.sendHtmlError(res, {
        status: 404,
        title: "Sign-out is unavailable",
        message: "This application does not have an active sign-in session to end.",
        action: { label: "Back to Flow", href: "/ui/runs" },
      });
    }
    res.writeHead(302, {
      Location: "/ui/runs",
      "Set-Cookie": `${this.oidc.clearCookie(req.headers.cookie)}${this.isHttps(req) ? "; Secure" : ""}`,
    });
    return res.end();
  }

  private async handleOidcSession(req: http.IncomingMessage, res: http.ServerResponse) {
    const sessionUser = this.oidc?.userFromCookie(req.headers.cookie);
    if (!sessionUser) {
      res.writeHead(401, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          configured: Boolean(this.oidc?.enabled),
          authenticated: false,
          providerUrl: this.oidc?.providerUrl,
          error: "Authentication required",
        }),
      );
    }
    const principal = await this.principals.principal(sessionUser.id);
    if (!principal || principal.disabled) {
      res.writeHead(401, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          configured: Boolean(this.oidc?.enabled),
          authenticated: false,
          providerUrl: this.oidc?.providerUrl,
          error: "Authentication required",
        }),
      );
    }
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        configured: Boolean(this.oidc?.enabled),
        authenticated: true,
        user: {
          id: principal.subject,
          name: principal.name || "",
          email: principal.email || "",
          photo: principal.photo || "",
          role: principal.platformRole,
          kind: principal.kind,
          capabilities: principal.platformCapabilities,
        },
        workspaces: await this.principals.workspaceListFor(principal.subject),
        providerUrl: this.oidc?.providerUrl,
      }),
    );
  }

  private async handleOidcToken(req: http.IncomingMessage, res: http.ServerResponse) {
    let token: { accessToken: string; expiresAt: number } | undefined;
    try {
      token = await this.oidc?.accessTokenFromCookie(req.headers.cookie);
    } catch {
      res.writeHead(503, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Token refresh unavailable" }));
    }
    if (!token) {
      res.writeHead(401, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Authentication required" }));
    }
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ access_token: token.accessToken, token_type: "Bearer", expires_at: token.expiresAt }),
    );
  }

  private oidcRedirectUri(req: http.IncomingMessage) {
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `${protocol}://${host}/auth/callback`;
  }

  private isHttps(req: http.IncomingMessage) {
    return (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() === "https";
  }

  private async listOidcTokens(req: http.IncomingMessage) {
    try {
      const response = await this.oidc?.tokenApiRequest(
        req.headers.cookie,
        `/api-tokens/${this.oidcClientId()}`,
        {},
        this.oidcBearer(req),
      );
      if (!response || !response.ok) {
        return undefined;
      }
      const payload = (await response.json()) as any[] | { tokens?: any[] };
      const tokens = Array.isArray(payload) ? payload : payload.tokens || [];
      return tokens.map((token) => ({
        id: token.label || token.id,
        name: token.label || token.name,
        scopes: token.scopes || [],
        created_at: token.created_at || token.createdAt || "",
      }));
    } catch {
      return undefined;
    }
  }

  private async issueOidcToken(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.oidc?.userFromCookie(req.headers.cookie) && !this.oidcBearer(req)) {
      return undefined;
    }
    const body = await this.readJson(req, res);
    if (!body) {
      return null;
    }
    const response = await this.oidc!.tokenApiRequest(
      req.headers.cookie,
      `/api-tokens/${this.oidcClientId()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: body.name, scopes: body.scopes }),
      },
      this.oidcBearer(req),
    );
    if (!response) {
      return undefined;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error || "OIDC token issuance failed" }));
      return null;
    }
    return {
      ...result,
      token: result.token || result.access_token,
      name: result.label || body.name,
      scopes: result.scopes || body.scopes,
    };
  }

  private async revokeOidcToken(req: http.IncomingMessage, label: string) {
    if (!this.oidc?.userFromCookie(req.headers.cookie) && !this.oidcBearer(req)) {
      return undefined;
    }
    const response = await this.oidc!.tokenApiRequest(
      req.headers.cookie,
      `/api-tokens/${this.oidcClientId()}/${encodeURIComponent(label)}`,
      { method: "DELETE" },
      this.oidcBearer(req),
    );
    return response;
  }

  private oidcClientId() {
    return this.oidc?.clientId || "";
  }

  private oidcBearer(req: http.IncomingMessage) {
    const authorization = req.headers.authorization || "";
    return authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  }

  private matchesToken(req: http.IncomingMessage, token: string, allowBasic: boolean): boolean {
    if (!token) {
      return false;
    }
    const auth = req.headers.authorization || "";
    const matches = (value: string) => {
      const expected = Buffer.from(token);
      const received = Buffer.from(value);
      return expected.length === received.length && crypto.timingSafeEqual(expected, received);
    };
    if (auth.startsWith("Bearer ") && matches(auth.slice(7))) {
      return true;
    }
    if (!allowBasic || !auth.startsWith("Basic ")) {
      return false;
    }
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      return separator > 0 && decoded.slice(0, separator) === "admin" && matches(decoded.slice(separator + 1));
    } catch {
      return false;
    }
  }

  private async requireAdmin(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const context = await this.authorizer.platform(req, res, "platform.policy.manage");
    if (context) {
      return true;
    }
    // Browser navigations get a redirect instead of a bare JSON error.
    const path = (req.url || "/").split("?")[0];
    if (res.headersSent) {
      return false;
    }
    if (req.method === "GET" && !path.startsWith("/api/")) {
      if (this.oidc?.userFromCookie(req.headers.cookie)) {
        res.writeHead(302, { Location: "/ui/settings" });
        res.end();
        return false;
      }
      const returnTo = encodeURIComponent(req.url || "/ui/settings");
      res.writeHead(302, { Location: `/auth/login?url=${returnTo}` });
      res.end();
      return false;
    }
    return false;
  }

  private async requireAdminSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    return Boolean(await this.requirePlatformCapability(req, res, "platform.policy.manage"));
  }

  /** Operations is readable by any platform administrator capability; mutations check their own capability. */
  private async requireOperationsAccess(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    return Boolean(
      await this.authorizer.platformAny(req, res, [
        "platform.users.view",
        "platform.users.manage",
        "platform.runners.view",
        "platform.runners.manage",
        "platform.policy.manage",
      ]),
    );
  }

  private async readJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<any | null> {
    const { rawBuffer } = await this.readRequest(req, res);
    if (!rawBuffer || res.headersSent) {
      return null;
    }
    try {
      return JSON.parse(rawBuffer.toString("utf8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return null;
    }
  }

  private async handleWorkflowValidation(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.requireAuthenticatedUser(req, res))) {
      return;
    }
    const body = await this.readJson(req, res);
    if (!body) {
      return;
    }
    try {
      await this.workflowsLoaded;
      const workflows = await this.workflows.validateForSave(body.sourceYaml);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ valid: true, workflows }));
    } catch (error: any) {
      res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ valid: false, error: error.message }));
    }
  }

  private async handleRecipeList(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.requireAuthenticatedUser(req, res))) {
      return;
    }
    await this.workflowsLoaded;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ recipes: await this.recipes.list() }));
  }

  private async handleRecipeValidation(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.requireAuthenticatedUser(req, res))) {
      return;
    }
    const body = await this.readJson(req, res);
    if (!body || typeof body.sourceYaml !== "string") {
      if (!res.headersSent) {
        deny(res, 400, "sourceYaml is required");
      }
      return;
    }
    try {
      const recipe = parseRecipe(body.sourceYaml);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ valid: true, inputs: recipe.inputs }));
    } catch (error) {
      res.writeHead(422, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ valid: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async handleRecipeGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    namespace: string,
    slug: string,
    version: number,
  ) {
    if (!(await this.requireAuthenticatedUser(req, res))) {
      return;
    }
    await this.workflowsLoaded;
    const recipe = await this.recipes.get(namespace, slug, version);
    if (!recipe) {
      return res.writeHead(404).end(JSON.stringify({ error: "Recipe not found" }));
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(recipe));
  }

  private async handleRecipePublish(req: http.IncomingMessage, res: http.ServerResponse) {
    const context = await this.authenticate(req, res);
    if (!context) {
      return;
    }
    if (context.principal.kind !== "human") {
      return deny(res, 403, "Only human users may publish recipes");
    }
    const body = await this.readJson(req, res);
    if (
      !body ||
      typeof body.slug !== "string" ||
      typeof body.name !== "string" ||
      typeof body.sourceYaml !== "string"
    ) {
      if (!res.headersSent) {
        deny(res, 400, "slug, name, and sourceYaml are required");
      }
      return;
    }
    try {
      parseRecipe(body.sourceYaml);
      await this.workflowsLoaded;
      const username = await this.oidcUsers.preferredUsername(context.principal.subject);
      const namespace = await this.recipes.getOrCreateNamespace(context.principal.subject, username || "");
      const recipe = await this.recipes.publish(
        namespace,
        body.slug,
        body.name,
        context.principal.subject,
        body.sourceYaml,
      );
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(recipe));
    } catch (error) {
      deny(res, 422, error instanceof Error ? error.message : "Recipe could not be published");
    }
  }

  private async handleRecipeRevoke(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    namespace: string,
    slug: string,
    version: number,
  ) {
    const admin = await this.requirePlatformCapability(req, res, "platform.policy.manage");
    if (!admin) {
      return;
    }
    await this.workflowsLoaded;
    const revoked = await this.recipes.revoke(namespace, slug, version);
    if (!revoked) {
      return deny(res, 404, "Recipe version not found");
    }
    await this.principals.recordAudit({
      actor: admin.principal.subject,
      action: "recipe.version.revoke",
      target: `${namespace}/${slug}@v${version}`,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ revoked: true }));
  }

  private async handleWorkflowList(req: http.IncomingMessage, res: http.ServerResponse) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.view"))?.teamId;
    if (!teamId) {
      return;
    }
    await this.workflowsLoaded;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ workflows: await this.workflows.listForTeam(teamId) }));
  }

  private async handleWorkflowGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    revisionParam: string | null = null,
  ) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.view"))?.teamId;
    if (!teamId) {
      return;
    }
    const revision = revisionParam === null ? undefined : Number(revisionParam);
    const workflow =
      revision !== undefined && Number.isSafeInteger(revision) && revision > 0
        ? (await this.workflows.getForTeam(teamId, id))
          ? await this.workflows.getRevisionSnapshot(id, revision)
          : null
        : await this.workflows.getForTeam(teamId, id);
    if (!workflow) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Workflow not found" }));
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(workflow));
  }

  private async handleWorkflowSave(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.edit"))?.teamId;
    if (!teamId) {
      return;
    }
    await this.workflowsLoaded;
    const body = await this.readJson(req, res);
    if (!body || typeof body.sourceYaml !== "string") {
      if (!res.headersSent) {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "sourceYaml is required" }));
      }
      return;
    }
    try {
      const workflow = await this.workflows.saveDraftForTeam(teamId, id, body.sourceYaml, body.enabled !== false);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(workflow));
    } catch (error: any) {
      res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleWorkflowDelete(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.delete"))?.teamId;
    if (!teamId) {
      return;
    }
    if (!(await this.workflows.deleteForTeam(teamId, id))) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Workflow not found" }));
    }
    res.writeHead(204).end();
  }

  private async handleWorkflowPublish(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.edit"))?.teamId;
    if (!teamId) {
      return;
    }
    if (!(await this.workflows.getForTeam(teamId, id))) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Workflow not found" }));
    }
    const workflow = await this.workflows.publishForTeam(teamId, id);
    if (!workflow) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Workflow not found" }));
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(workflow));
  }

  private async handleSecretList(req: http.IncomingMessage, res: http.ServerResponse) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "secrets.view"))?.teamId;
    if (!teamId) {
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ secrets: await this.secretRepository.namesForTeam(teamId) }));
  }

  private async handleSecretSave(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "secrets.edit"))?.teamId;
    if (!teamId) {
      return;
    }
    const body = await this.readJson(req, res);
    if (!body || typeof body.value !== "string") {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "value is required" }));
      }
      return;
    }
    try {
      await this.secretRepository.setForTeam(teamId, name, body.value, body.encoding || "utf8");
      res.writeHead(204).end();
    } catch (error: any) {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleSecretDelete(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "secrets.edit"))?.teamId;
    if (!teamId) {
      return;
    }
    if (!(await this.secretRepository.deleteForTeam(teamId, name))) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Secret not found" }));
    }
    res.writeHead(204).end();
  }

  private async handleJobSecrets(req: http.IncomingMessage, res: http.ServerResponse, jobId: string) {
    if (!this.isWorker(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    const job = await this.queue.getJob(jobId);
    if (!job || job.status !== "running" || job.worker_id !== req.headers["x-runner-worker-id"]) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Job is not assigned to this worker" }));
    }
    if (!job.team_id) {
      res.writeHead(409).end();
      return;
    }
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ secrets: await this.secretRepository.getAllForJob(job.team_id) }));
  }

  /**
   * Handles Zero-Downtime Secret Reload
   */
  private async handleSecretReload(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.requirePlatformCapability(req, res, "platform.policy.manage"))) {
      return;
    }

    // Trigger in-memory secret reload
    this.secrets.reload();
    console.log("🔄 SecretStore reloaded successfully without downtime!");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Secrets reloaded successfully" }));
  }

  private async handleWorkerEvent(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.isWorker(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }

    const { rawBuffer } = await this.readRequest(req, res);
    if (!rawBuffer || res.headersSent) {
      return;
    }

    let jobId: number | undefined;
    try {
      const payload = rawBuffer.length ? JSON.parse(rawBuffer.toString("utf8")) : {};
      const parsedJobId = Number(payload.jobId);
      if (Number.isSafeInteger(parsedJobId) && parsedJobId > 0) {
        jobId = parsedJobId;
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid event payload" }));
    }

    if (jobId) {
      const job = await this.queue.getJob(jobId);
      if (job) {
        if (job.team_id) {
          this.events.publish("jobs.changed", { jobId, teamId: job.team_id });
        }
        void this.push.notify(job);
      }
    }
    res.writeHead(202).end();
  }

  private handlePushPublicKey(res: http.ServerResponse) {
    if (!this.push.publicKey) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Push notifications are not configured" }));
    }
    res.writeHead(200, { "Cache-Control": "public, max-age=3600", "Content-Type": "application/json" });
    res.end(JSON.stringify({ publicKey: this.push.publicKey }));
  }

  private async handlePushSubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.authorizer.human(req, res))) {
      return;
    }
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.view"))?.teamId;
    if (!teamId) {
      return;
    }
    const body = await this.readJson(req, res);
    if (!body) {
      return;
    }
    if (
      !this.push.publicKey ||
      typeof body.endpoint !== "string" ||
      !body.keys ||
      typeof body.keys.p256dh !== "string" ||
      typeof body.keys.auth !== "string"
    ) {
      if (!res.headersSent) {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Invalid push subscription" }));
      }
      return;
    }
    await this.push.save(body, teamId);
    res.writeHead(204).end();
  }

  private async handlePushUnsubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.authorizer.human(req, res))) {
      return;
    }
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.view"))?.teamId;
    if (!teamId) {
      return;
    }
    const body = await this.readJson(req, res);
    if (!body) {
      return;
    }
    if (typeof body.endpoint !== "string") {
      if (!res.headersSent) {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "endpoint is required" }));
      }
      return;
    }
    await this.push.remove(body.endpoint, teamId);
    res.writeHead(204).end();
  }

  /**
   * Serves the Server Health & Jobs Dashboard
   */
  private async renderDashboard(res: http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(generateDashboardHtml());
  }

  private renderAppShell(res: http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(appShellTemplate);
  }

  private renderPageComponent(res: http.ServerResponse, name: string, source: string, body = false) {
    const components = Array.from(source.matchAll(/<link\b[^>]*\brel=["'](?:component|stylesheet)["'][^>]*>/gi))
      .map((match) => match[0])
      .join("");
    const styles = Array.from(source.matchAll(/<style[\s\S]*?<\/style>/gi))
      .map((match) => match[0])
      .join("");
    let content = source;
    if (body) {
      content = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || source;
    } else {
      const appTemplate = source.match(/<template\s+app\b[^>]*>/i);
      const start = appTemplate ? appTemplate.index! + appTemplate[0].length : -1;
      const end = source.lastIndexOf("</template>");
      if (start !== -1 && end > start) {
        content = source.slice(start, end);
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(`<template component="${name}">${components}${styles}${content}</template>`);
  }

  private async renderDashboardJobs(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    limit: number,
    afterId?: number,
    beforeId?: number,
    filter?: string,
    workflowId?: string,
  ) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.view"))?.teamId;
    if (!teamId) {
      return;
    }
    let rows;
    try {
      rows = await this.queue.listJobsForTeam(teamId, limit + 1, afterId, beforeId, filter, workflowId);
    } catch (error: any) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: error.message }));
    }
    const runnerNames = new Map((await this.runners.list()).map((runner) => [runner.id, runner.name]));
    const jobs = toDashboardJobs(rows.slice(0, limit)).map((job) => ({
      ...job,
      workerName: job.workerId ? runnerNames.get(job.workerId) || job.workerId : null,
    }));
    const body = JSON.stringify(
      this.redactStructured({ jobs, hasMore: rows.length > limit }, await this.currentSecrets(teamId)),
    );
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(body);
  }

  /**
   * Serves single job HTML report
   */
  private async renderRunDetails(
    req: http.IncomingMessage,
    jobId: string,
    res: http.ServerResponse,
    format: "html" | "json",
  ) {
    const access = await this.requireWorkspaceCapability(req, res, "runs.view");
    if (!access) {
      return;
    }
    const teamId = access.teamId;
    const capabilities = new Set(access.capabilities);
    const canViewLogs = capabilities.has("runs.logs");
    const canViewInputs = capabilities.has("runs.inputs");
    const canViewArtifacts = capabilities.has("runs.artifacts");
    const job = await this.queue.getJobForTeam(teamId, jobId);

    if (!job) {
      if (format === "json") {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "Run not found" }));
      }
      return this.sendHtmlError(res, {
        status: 404,
        title: "We couldn't find that run",
        message: "The run may have been removed, or the link may be out of date.",
        action: { label: "Back to runs", href: "/ui/runs" },
      });
    }

    const logsMap = canViewLogs ? await this.queue.getJobLogs(jobId) : {};
    const secretValues = await this.secretRepository.getAllForTeam(teamId);
    const definition = await this.workflows.getRevision(job.workflow_id, job.workflow_revision);
    const snapshot = canViewLogs
      ? await this.workflows.getRevisionSnapshot(job.workflow_id, job.workflow_revision)
      : null;
    const report = buildRunView(
      job,
      logsMap,
      (value) => this.redact(value, secretValues),
      definition?.steps,
      canViewLogs,
      snapshot?.sourceYaml,
      definition?.name,
      {
        logs: canViewLogs,
        inputs: canViewInputs,
        artifacts: canViewArtifacts,
        control: capabilities.has("runs.control"),
        editWorkflow: capabilities.has("workflows.edit"),
      },
    );
    report.workerName = report.workerId
      ? (await this.runners.list()).find((runner) => runner.id === report.workerId)?.name
      : undefined;

    if (format === "json") {
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(report));
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderRunHtml(report));
  }

  private async handleRestartJob(req: http.IncomingMessage, jobId: string, res: http.ServerResponse) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.control"))?.teamId;
    if (!teamId) {
      return;
    }
    const job = await this.queue.getJobForTeam(teamId, jobId);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Job not found" }));
      return;
    }
    const body = req.headers["content-length"] || req.headers["transfer-encoding"] ? await this.readJson(req, res) : {};
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body.inputs !== undefined && (!body.inputs || typeof body.inputs !== "object" || Array.isArray(body.inputs)))
    ) {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Restart inputs must be a JSON object" }));
      }
      return;
    }
    const id = await this.queue.restartJob(jobId, body.inputs || {});

    if (id) {
      this.events.publish("jobs.available", { teamId });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Job not found" }));
  }

  private async handleArtifactDownload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    jobId: string,
    filePath: string,
  ) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.artifacts"))?.teamId;
    if (!teamId) {
      return;
    }
    const file = (await this.queue.getStoredFilesForTeam(teamId, "artifact", jobId)).find(
      (entry) => entry.path === filePath,
    );
    if (!file) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Artifact not found" }));
    }
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filePath.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
    });
    return res.end(Buffer.from(file.content, "base64"));
  }

  private async handleAiHelp(req: http.IncomingMessage, res: http.ServerResponse, jobId: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.logs"))?.teamId;
    if (!teamId) {
      return;
    }
    const apiKey = await this.currentSecrets(teamId).then(
      (secrets) => secrets.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    );
    const model = process.env.OPENAI_API_MODEL;
    const apiUrl = process.env.OPENAI_API_URL;
    if (!model || !apiUrl) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "AI help is not configured" }));
    }
    const job = await this.queue.getJobForTeam(teamId, jobId);
    if (!job?.report) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Run report not found" }));
    }
    const body = await this.readJson(req, res);
    const failedStepId = typeof body?.stepId === "string" ? body.stepId : "";
    const question = typeof body?.question === "string" && body.question.trim() ? body.question.trim() : undefined;
    const conversation = Array.isArray(body?.conversation)
      ? body.conversation
          .filter(
            (message: any) =>
              (message?.role === "user" || message?.role === "assistant") && typeof message.content === "string",
          )
          .slice(-20)
      : [];
    const report = JSON.parse(job.report);
    const snapshot = await this.workflows.getRevisionSnapshot(job.workflow_id, job.workflow_revision);
    if (!snapshot || !failedStepId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "A failed step and workflow revision are required" }));
    }
    const secretValues = await this.currentSecrets(teamId);
    const messages = buildAiHelpMessages(
      snapshot.sourceYaml,
      report.steps || [],
      await this.queue.getJobLogs(jobId),
      failedStepId,
      (value) => this.redact(value, secretValues),
      question,
      conversation,
    );
    try {
      const requestBody = createAiRequest(model, messages);
      const workflowUrl = new URL(
        `/ui/runs/${jobId}`,
        `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`,
      ).toString();
      await this.queue.saveAiRequest(jobId, workflowUrl, requestBody);
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      await streamAiHelp(apiUrl, apiKey, requestBody, (delta) => res.write(`data: ${JSON.stringify({ delta })}\n\n`));
      res.write('data: {"done":true}\n\n');
      return res.end();
    } catch (error: any) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        return res.end();
      }
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleWorkflowAiHelp(req: http.IncomingMessage, res: http.ServerResponse) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "workflows.edit"))?.teamId;
    if (!teamId) {
      return;
    }
    const body = await this.readJson(req, res);
    const request = typeof body?.request === "string" ? body.request.trim() : "";
    const sourceYaml = typeof body?.sourceYaml === "string" ? body.sourceYaml : "";
    const apiKey = (await this.currentSecrets(teamId)).OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_API_MODEL;
    const apiUrl = process.env.OPENAI_API_URL;
    if (!request) {
      return res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "request is required" }));
    }
    if (!model || !apiUrl) {
      return res
        .writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "AI help is not configured" }));
    }

    const requestBody = createAiRequest(model, [
      {
        role: "system",
        content:
          "You are an expert workflow author. Return only a complete replacement workflow YAML document, without Markdown fences or explanations. Preserve valid existing behavior unless the user explicitly asks to change it.",
      },
      { role: "user", content: `The complete workflow syntax documentation is:\n\n${workflowDocs}` },
      { role: "user", content: `The current workflow YAML is:\n\n${sourceYaml || "(empty editor)"}` },
      { role: "user", content: `Apply this requested change and return the complete replacement YAML:\n\n${request}` },
    ]);
    try {
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      await streamAiHelp(apiUrl, apiKey, requestBody, (delta) => res.write(`data: ${JSON.stringify({ delta })}\n\n`));
      res.write('data: {"done":true}\n\n');
      res.end();
    } catch (error: any) {
      if (res.headersSent) {
        return res.end(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      }
      res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleCancelJob(req: http.IncomingMessage, res: http.ServerResponse, jobId: string) {
    const teamId = (await this.requireWorkspaceCapability(req, res, "runs.control"))?.teamId;
    if (!teamId) {
      return;
    }
    const job = await this.queue.getJobForTeam(teamId, jobId);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Job not found" }));
    }

    const result = await this.queue.cancelJob(jobId);
    if (result === "not_found") {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Job not found" }));
    }
    if (result === "not_active") {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Job is no longer running" }));
    }

    this.events.publish("jobs.changed", { jobId: Number(jobId), teamId });
    if (job.lease_id) {
      this.events.publish("lease.cancelled", { jobId: Number(jobId), leaseId: job.lease_id, teamId });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: Number(jobId), status: "cancelled" }));
  }

  private async currentSecrets(teamId: string): Promise<Record<string, string>> {
    try {
      return await this.secretRepository.getAllForTeam(teamId);
    } catch (error) {
      throw error;
    }
  }

  private redact(value: string, secrets: Record<string, string>): string {
    const redactor = new SecretStore();
    redactor.replace(secrets);
    return redactor.redactText(value);
  }

  private redactStructured<T>(value: T, secrets: Record<string, string>): T {
    if (typeof value === "string") {
      return this.redact(value, secrets) as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactStructured(item, secrets)) as T;
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.redactStructured(item, secrets)]),
      ) as T;
    }
    return value;
  }

  async listen(port: number): Promise<WebhookServer> {
    await this.workflowsLoaded;
    return new Promise((resolve) => {
      this.server.listen(port, process.env.RUNNER_HOST || "0.0.0.0", () => {
        console.log(`🌐 Webhook Ingress Server running on port ${port}`);
        resolve(this);
      });
    });
  }

  async stop(): Promise<void> {
    this.events.close();
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log("🌐 Webhook Ingress Server stopped listening.");
        resolve();
      });
    });
  }
}
