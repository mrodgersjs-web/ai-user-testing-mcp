#!/usr/bin/env node
/** rig-testlab binary entry — binds process globals to run(). */
import { run } from "./index.js";

process.exit(await run({ argv: process.argv.slice(2) }));
