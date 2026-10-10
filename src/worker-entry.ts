#!/usr/bin/env node

import { installTimestampedConsole } from "./logger.js";
import { loadFromArgs } from "./config.js";
import { startApiWorkers } from "./api-worker.js";

installTimestampedConsole();
const { config } = await loadFromArgs("start-workers");
if (!config) process.exitCode = 1;
else await startApiWorkers(config);
