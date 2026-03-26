import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepOutput } from "./types.js";

const tmpDir = await mkdtemp(join(tmpdir(), "workflow-reports"));

export async function createReport(
  ids: { id: string; parentId?: string; children?: string[] },
  outputs: StepOutput[],
): Promise<void> {
  try {
    const reportPath = join(tmpDir, `${ids.id}.json`);
    await writeFile(
      reportPath,
      JSON.stringify({ ...ids, outputs }, null, 2),
      "utf8",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error writing report:", message);
  }
}

export async function getReport(
  id: string,
): Promise<{
  id: string;
  parentId?: string;
  children?: string[];
  outputs: StepOutput[];
} | null> {
  try {
    const reportPath = join(tmpDir, `${id}.json`);
    const content = await import(reportPath);
    return content as {
      id: string;
      parentId?: string;
      children?: string[];
      outputs: StepOutput[];
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error reading report:", message);
    return null;
  }
}
