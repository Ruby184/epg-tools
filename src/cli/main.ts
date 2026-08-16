#!/usr/bin/env node
/**
 * The `epg` bin: the only place that turns an exit code into process state.
 * Everything it does is in `run.ts`, where it can be tested — import that, not
 * this, which runs a command line the moment it is loaded.
 */

import { runCli } from './run.js';

process.exitCode = await runCli(process.argv.slice(2));
