#!/usr/bin/env node

const [, , ...args] = process.argv;

if (args.includes("--help") || args.includes("-h")) {
  console.log("on - CLI entry point for the on plugin ecosystem");
  console.log("\nUsage:");
  console.log("  on <command> [...args]");
  process.exit(0);
}

if (args.length === 0) {
  console.log("on: no command provided. Run 'on --help' for usage.");
  process.exit(0);
}

console.log(`on: command '${args[0]}' is not implemented yet.`);
