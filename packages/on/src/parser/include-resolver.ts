import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export class WorkflowIncludeResolver {
  private baseDir: string;
  private maxDepth: number;

  constructor(baseDir: string, maxDepth = 5) {
    this.baseDir = path.resolve(baseDir);
    this.maxDepth = maxDepth;
  }

  /**
   * Recursively loads and merges YAML workflows while guarding against cycles.
   */
  resolve(filePath: string, visited = new Set<string>(), depth = 0): any {
    if (depth > this.maxDepth) {
      throw new Error(`Max include depth of ${this.maxDepth} exceeded at ${filePath}`);
    }

    const absolutePath = path.resolve(this.baseDir, filePath);

    // 1. Security Check: Prevent Directory Traversal outside workspace
    if (!absolutePath.startsWith(this.baseDir)) {
      throw new Error(`Security Violation: Include path '${filePath}' is outside workspace directory.`);
    }

    // 2. Cycle Detection
    if (visited.has(absolutePath)) {
      const cycleTrail = Array.from(visited).concat(absolutePath).join(' -> ');
      throw new Error(`Circular 'includes' dependency detected: ${cycleTrail}`);
    }

    visited.add(absolutePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Included workflow partial not found: ${filePath}`);
    }

    // 3. Parse File
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const parsed = YAML.parse(content);

    // 4. Handle Nested Includes (Depth First)
    if (Array.isArray(parsed.includes)) {
      for (const subInclude of parsed.includes) {
        const partialData = this.resolve(subInclude, new Set(visited), depth + 1);

        // Merge strategy: Append steps, deep-merge env and trigger properties
        parsed.steps = [...(partialData.steps || []), ...(parsed.steps || [])];
        parsed.env = { ...partialData.env, ...parsed.env };
      }
      delete parsed.includes; // Clean up top-level key after merging
    }

    return parsed;
  }
}
