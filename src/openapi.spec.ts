import { describe, expect, it } from 'vitest';
import spec from '../openapi.json' with { type: 'json' };

describe('OpenAPI specification', () => {
  it('documents discovery and core API paths', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.paths['/api']).toHaveProperty('get');
    expect(spec.paths['/api/jobs']).toHaveProperty('get');
    expect(spec.paths['/api/workflows/{workflowId}']).toHaveProperty('put');
    expect(spec.paths['/api/runs/{jobId}/artifacts/{path}']).toHaveProperty('get');
    expect(spec.paths['/webhooks/{provider}']).toHaveProperty('post');
  });
});
