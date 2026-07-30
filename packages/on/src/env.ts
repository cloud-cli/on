import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEBUG = !!process.env.DEBUG || !!process.env.VITEST;
export const reportsPath = join(process.env.WORKFLOW_REPORTS_PATH || tmpdir(), 'workflow-reports');
