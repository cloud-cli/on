export interface RunnerLease {
  leaseId: string;
  leaseToken: string;
  job: Record<string, any>;
  workflow: unknown;
}

export interface RunnerLeaseState {
  jobId: string | number;
  status: string;
  expiresAt: string;
}

export interface RunnerUpdateRequest {
  id: string;
  runnerId: string;
  version: string;
  status: "pending";
}

/** Authenticated HTTP adapter for the coordinator's runner lease protocol. */
export class RunnerApi {
  constructor(
    private readonly serverUrl: string,
    private readonly credential: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const base = new URL(serverUrl);
    if (
      base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))
    ) {
      throw new Error("Runner coordinator URLs must use HTTPS outside loopback");
    }
  }

  private async request(path: string, method: string, body?: unknown, leaseToken?: string): Promise<any> {
    const response = await this.fetcher(new URL(path, this.serverUrl), {
      method,
      headers: {
        Authorization: `Bearer ${this.credential}`,
        ...(leaseToken ? { "X-Runner-Lease-Token": leaseToken } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Runner API ${method} ${path} failed (${response.status})`);
    return data;
  }

  claim(tags: string[]): Promise<RunnerLease | null> {
    return this.request("/api/v1/runner/leases", "POST", { tags }).then((lease) => lease ?? null);
  }

  state(lease: RunnerLease): Promise<RunnerLeaseState> {
    return this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}`,
      "GET",
      undefined,
      lease.leaseToken,
    );
  }

  heartbeat(report: {
    version: string;
    runtime: string;
    capabilities: string[];
    concurrency: number;
    activeJobs: number;
  }): Promise<unknown> {
    return this.request("/api/v1/runner/heartbeat", "POST", report);
  }

  async pendingUpdate(): Promise<RunnerUpdateRequest | null> {
    const result = await this.request("/api/v1/runner/update", "GET");
    return result?.update || null;
  }

  reportUpdate(updateId: string, status: "failed"): Promise<unknown> {
    return this.request("/api/v1/runner/update/status", "POST", {
      updateId,
      status,
    });
  }

  async secrets(lease: RunnerLease): Promise<Record<string, string>> {
    const result = await this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}/secrets`,
      "GET",
      undefined,
      lease.leaseToken,
    );
    return result?.secrets || {};
  }

  renew(lease: RunnerLease): Promise<unknown> {
    return this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}/renew`,
      "POST",
      {},
      lease.leaseToken,
    );
  }

  report(lease: RunnerLease, report: unknown): Promise<unknown> {
    return this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}/report`,
      "PUT",
      report,
      lease.leaseToken,
    );
  }

  log(lease: RunnerLease, jobId: string | number, stepId: string, content: string): Promise<unknown> {
    return this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}/logs`,
      "POST",
      { jobId, stepId, content },
      lease.leaseToken,
    );
  }

  files(lease: RunnerLease, kind: string, action: string, cacheKey: string, files: unknown[]): Promise<any> {
    return this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}/files`,
      "POST",
      { kind, action, cacheKey, files },
      lease.leaseToken,
    );
  }

  complete(lease: RunnerLease, jobId: string | number, status: string, report: unknown): Promise<unknown> {
    return this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}/complete`,
      "POST",
      { jobId, status, report },
      lease.leaseToken,
    );
  }

  release(lease: RunnerLease): Promise<unknown> {
    return this.request(
      `/api/v1/runner/leases/${encodeURIComponent(lease.leaseId)}/release`,
      "POST",
      {},
      lease.leaseToken,
    );
  }
}
