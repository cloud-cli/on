import { readdirSync } from 'node:fs';
import { WorkflowIncludeResolver } from './include-resolver.js';
import { expandMatrix } from './matrix-expander.js';
import { WorkflowDefinition } from '../ingress/types.js';

export class YamlLoader {
  static from(dir: string) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const workflows: WorkflowDefinition[] = [];
    const resolver = new WorkflowIncludeResolver(dir);

    for (const file of files) {
      try {
        // Resolve includes & partials
        const resolved = resolver.resolve(file);

        // Expand matrix strategy into concrete job specs
        const expandedWorkflows = expandMatrix(resolved);

        for (const wf of expandedWorkflows) {
          workflows.push({
            id: wf.id || wf.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
            name: wf.name,
            on: {
              provider: Object.keys(wf.on || {})[0] || 'generic',
              if: wf.on?.[Object.keys(wf.on || {})[0]]?.if,
            },
            concurrency: wf.concurrency,
            steps: wf.steps,
          });
        }
      } catch (err: any) {
        console.error(`❌ Error parsing workflow '${file}':`, err.message);
      }
    }

    return workflows;
  }
}
