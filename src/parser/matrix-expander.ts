import type { ParsedWorkflow } from '../types.js';

/**
 * Expands a workflow definition containing a `strategy.matrix` into dynamic single-instance workflow jobs.
 */
export function expandMatrix(workflow: ParsedWorkflow): ParsedWorkflow[] {
  // If no matrix strategy is defined, return workflow as a single-element array
  if (!workflow.strategy?.matrix || Object.keys(workflow.strategy.matrix).length === 0) {
    return [workflow];
  }

  const matrix = workflow.strategy.matrix;
  const keys = Object.keys(matrix);

  // Calculate Cartesian Product across all matrix keys
  const combinations: Record<string, any>[] = keys.reduce(
    (acc, key) => {
      const values = Array.isArray(matrix[key]) ? matrix[key] : [matrix[key]];
      return acc.flatMap((combination) =>
        values.map((val) => ({
          ...combination,
          [key]: val,
        })),
      );
    },
    [{}] as Record<string, any>[],
  );

  // Clone workflow instance for each Cartesian matrix combination
  return combinations.map((combination, index) => {
    const clone: ParsedWorkflow = JSON.parse(JSON.stringify(workflow));
    delete clone.strategy;
    // Create matrix identity label: "node=20, os=ubuntu"
    const matrixLabel = Object.entries(combination)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    // Append matrix label to workflow name & generate unique workflow ID
    clone.name = `${workflow.name} (${matrixLabel})`;
    clone.matrixContext = combination;

    // Convert matrix values to environment variables (e.g., MATRIX_NODE_VERSION="20")
    const matrixEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(combination)) {
      const envKey = `MATRIX_${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
      matrixEnv[envKey] = String(v);
    }

    clone.env = {
      ...(clone.env || {}),
      ...matrixEnv,
    };

    return clone;
  });
}
