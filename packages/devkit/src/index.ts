import { ChildProcess } from "child_process";

export function interpolate(template: string, context: any): string {
  const keys = Object.keys(context);
  const f = Function(
    "__",
    "const { " + keys.join(", ") + " } = __;return `" + template + "`;",
  );

  return String(f(context) || "");
}

export interface StepOutput {
  code: number;
  cmd: string;
  stdout: string;
  stderr: string;
}

export function getStepOutput(
  cmd: string,
  childProcess: ChildProcess,
): Promise<StepOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  childProcess.stdout!.on("data", (data: Buffer) => stdout.push(data));
  childProcess.stderr!.on("data", (data: Buffer) => stderr.push(data));

  return new Promise<StepOutput>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code: number | null) => {
      resolve({
        code: code ?? 0,
        cmd,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });

    childProcess.stdin?.write(cmd);
    childProcess.stdin?.end();
  });
}
