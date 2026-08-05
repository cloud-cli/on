import { ExecutionDriver } from '../types.js';
import { SystemdDriver } from './systemd.driver.js';
import { StandardProcessDriver } from './standard-process.driver.js';

export async function resolveDriver(): Promise<ExecutionDriver> {
  const systemd = new SystemdDriver();

  if (await systemd.isSupported()) {
    console.log('⚡ Selected Execution Driver: Systemd (cgroups enabled)');
    return systemd;
  }

  console.log('📦 Selected Execution Driver: Standard Process (Fallback)');
  return new StandardProcessDriver();
}
