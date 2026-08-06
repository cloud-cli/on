import { WorkflowIncludeResolver } from './include-resolver.js';
import { WorkflowDefinition } from '../ingress/types.js';
export declare class YamlLoader {
    static from(path: string): Promise<WorkflowDefinition[]>;
    static loadFile(path: string, resolver: WorkflowIncludeResolver): WorkflowDefinition[];
}
//# sourceMappingURL=yaml-loader.d.ts.map