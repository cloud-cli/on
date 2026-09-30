import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
const [html, css, javascript] = await Promise.all([read("index.html"), read("style.css"), read("app.js")]);
const output = html
  .replace('<link rel="stylesheet" href="./style.css" />', () => `<style>${css}</style>`)
  .replace('<script src="./app.js" defer></script>', "")
  .replace("</body>", () => `<script>${javascript}</script></body>`);

await writeFile(process.argv[2] || "/tmp/opencode/flow-concept.html", output);
