// The production maintenance health check (QA gate 7, G7-1-I2): exits 0 while
// the worker's heartbeat file is fresh and 1 when it is stale or missing. An
// optional path argument exists for the test; Compose passes none.
import {
  heartbeatFileIsFresh,
  maintenanceHeartbeatFile,
} from './heartbeat-file.ts';

const path = process.argv[2] ?? maintenanceHeartbeatFile;
process.exitCode = (await heartbeatFileIsFresh(path, new Date())) ? 0 : 1;
