import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { WorkflowIncludeResolver } from './include-resolver.js';
import { expandMatrix } from './matrix-expander.js';
import { WorkflowDefinition } from '../types.js';
import { randomUUID } from 'node:crypto';

export class YamlLoader {
  static async from(path: string) {
    const absolutePath = isAbsolute(path) ? resolve('/', path) : join(process.cwd(), resolve('/', path));
    const list = await readdir(absolutePath, { withFileTypes: true });
    const files = list
      .filter((f) => f.isFile() && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')))
      .map((f) => join(absolutePath, f.name));

    const workflows: WorkflowDefinition[] = [];
    const resolver = new WorkflowIncludeResolver(path);

    for (const file of files) {
      workflows.push(...(await YamlLoader.loadFile(file, resolver)));
    }

    return workflows;
  }

  static loadFile(path: string, resolver: WorkflowIncludeResolver) {
    const workflows: WorkflowDefinition[] = [];

    try {
      // Resolve includes & partials
      const resolved = resolver.resolve(path);

      // Expand matrix strategy into concrete job specs
      const expandedWorkflows = expandMatrix(resolved);

      for (const wf of expandedWorkflows) {
        if (typeof wf.on !== 'object') {
          console.error(`on: not defined in ${path}! Ignoring this workflow.`);
          continue;
        }

        const provider = Object.keys(wf.on)[0] || 'generic';
        workflows.push({
          id: (wf.id || wf.name)?.toLowerCase().replace(/[^a-z0-9]/g, '-') ?? randomUUID(),
          name: wf.name,
          on: {
            provider,
            if: wf.on[provider]?.if,
          },
          concurrency: wf.concurrency,
          steps: wf.steps,
          env: wf.env,
        });
      }
    } catch (err: any) {
      console.error(`❌ Error parsing workflow '${path}':`, err.message);
      return [];
    }

    return workflows;
  }
}
