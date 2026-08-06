import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { WorkflowIncludeResolver } from './include-resolver.js';
import { expandMatrix } from './matrix-expander.js';
export class YamlLoader {
    static async from(path) {
        const absolutePath = isAbsolute(path) ? resolve('/', path) : join(process.cwd(), resolve('/', path));
        const list = await readdir(absolutePath, { withFileTypes: true });
        const files = list
            .filter((f) => f.isFile() && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')))
            .map((f) => join(absolutePath, f.name));
        const workflows = [];
        const resolver = new WorkflowIncludeResolver(path);
        for (const file of files) {
            workflows.push(...(await YamlLoader.loadFile(file, resolver)));
        }
        return workflows;
    }
    static loadFile(path, resolver) {
        const workflows = [];
        try {
            // Resolve includes & partials
            const resolved = resolver.resolve(path);
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
        }
        catch (err) {
            console.error(`❌ Error parsing workflow '${path}':`, err.message);
            return [];
        }
        return workflows;
    }
}
//# sourceMappingURL=yaml-loader.js.map