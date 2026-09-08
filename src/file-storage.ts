type StoredFile = { path: string; content: string };

export class FileStorage {
  private readonly baseUrl: string;
  private readonly binId: string;
  private readonly authorization?: string;

  constructor() {
    this.baseUrl = (process.env.RUNNER_FILE_API_URL || 'https://file.api.apphor.de').replace(/\/$/, '');
    this.binId = process.env.RUNNER_FILE_BIN || '';
    this.authorization = process.env.RUNNER_FILE_PASSWORD
      ? `Basic ${Buffer.from(`runner:${process.env.RUNNER_FILE_PASSWORD}`).toString('base64')}`
      : undefined;
  }

  get enabled(): boolean {
    return Boolean(this.binId);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.authorization ? { authorization: this.authorization } : {}), ...extra };
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: this.headers((options.headers || {}) as Record<string, string>),
    });
    if (!response.ok) throw new Error(`File storage request failed: ${response.status} ${path}`);
    return response;
  }

  async save(ownerKey: string, files: StoredFile[]): Promise<void> {
    const existing = await this.index();
    for (const file of files) {
      const name = `${ownerKey}/${file.path}`;
      const fileId = existing.get(name) || await this.create(name);
      await this.request(`/f/${this.binId}/${fileId}`, {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/octet-stream' }),
        body: Buffer.from(file.content, 'base64'),
      });
    }
  }

  async load(ownerKey: string): Promise<StoredFile[]> {
    const index = await this.index();
    const files: StoredFile[] = [];
    for (const [name, fileId] of index) {
      if (!name.startsWith(`${ownerKey}/`)) continue;
      const content = Buffer.from(await (await this.request(`/f/${this.binId}/${fileId}`)).arrayBuffer()).toString('base64');
      files.push({ path: name.slice(ownerKey.length + 1), content });
    }
    return files;
  }

  private async create(name: string): Promise<string> {
    const response = await this.request(`/f/${this.binId}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    return ((await response.json()) as { fileId: string }).fileId;
  }

  private async index(): Promise<Map<string, string>> {
    const response = await this.request(`/bin/${this.binId}`);
    const ids = (await response.json()) as string[];
    const entries = await Promise.all(ids.map(async (id) => {
      const metadata = await this.request(`/meta/${this.binId}/${id}`);
      return [((await metadata.json()) as { name: string }).name, id] as const;
    }));
    return new Map(entries);
  }
}
