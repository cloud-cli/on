import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepOutput } from "./types.js";
import { AnsiUp } from "ansi_up";

const ansiUp = new AnsiUp();
const tmpDir = join(tmpdir(), "workflow-reports");

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

export type Report = {
  id: string;
  parentId?: string;
  children?: string[];
  outputs: StepOutput[];
};

export async function getReport(id: string): Promise<{
  id: string;
  parentId?: string;
  children?: string[];
  outputs: StepOutput[];
} | null> {
  try {
    const reportPath = join(tmpDir, `${id}.json`);
    const content = await import(reportPath, { with: { type: "json" } });
    return content as Report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error reading report:", message);
    return null;
  }
}

export const notFound = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Workflow Report</title>
<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 p-4">
<div class="max-w-4xl mx-auto bg-white shadow-md rounded-lg p-6">
<h1 class="text-2xl font-bold mb-4">Workflow Report</h1>
<p class="text-red-500">Report not found.</p>
</div>
</body>
</html>`;

export async function formatReportAsHTML(
  report: Report | null,
): Promise<string> {
  if (!report) {
    return notFound;
  }

  // Use ANSI Up to convert ANSI escape codes in stdout/stderr to HTML
  // Use Tailwind for styling
  // Include links to parent and child reports if available
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Workflow Report - ${report.id}</title>
<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 p-4">
<div class="max-w-4xl mx-auto bg-white shadow-md rounded-lg p-6">
<h1 class="text-2xl font-bold mb-4">Workflow Report - ${report.id}</h1>
${report.outputs
  .map(
    (output, index) => `
  <div class="mb-6">
    <h2 class="text-xl font-semibold mb-2">Step ${index + 1}: ${output.cmd} (${output.code})</h2>
    <div class="bg-gray-800 text-green-400 p-4 rounded mb-2 overflow-x-auto">
      <pre>${ansiUp.ansi_to_html(output.stdout)}</pre>
    </div>
    <div class="bg-gray-800 text-red-400 p-4 rounded overflow-x-auto">
      <pre>${ansiUp.ansi_to_html(output.stderr)}</pre>
    </div>
  </div>
`,
  )
  .join("")}
<div class="mt-4">
${report.parentId ? `<a href="/reports/${report.parentId}" class="text-blue-500 hover:underline">View Parent Report</a>` : ""}
${
  report.children && report.children.length > 0
    ? `<div class="mt-2">Child Reports:<ul>${report.children
        .map(
          (childId) =>
            `<li><a href="/reports/${childId}" class="text-blue-500 hover:underline">${childId}</a></li>`,
        )
        .join("")}</ul></div>`
    : ""
}

</div>
</body>
</html>`;

  return html;
}
