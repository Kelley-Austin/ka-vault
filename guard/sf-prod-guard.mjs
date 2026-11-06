#!/usr/bin/env node
// ka-vault production guard: entry point. block-sf-prod-deploy.sh runs this file.
// main() always ends the process with exit 0 (allow) or exit 2 (block).
// If main() returns or throws, this file blocks (fail closed).
import { main, deny } from './guard-lib.mjs';

main().then(
  () => deny(['The guard ended without a decision.']),
  (e) => deny([`The guard stopped with an internal error: ${e?.message ?? e}`]),
);
