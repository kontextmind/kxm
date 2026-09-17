#!/usr/bin/env node
// KXM Runtime supervisor entry point. Detached child of `kxm runtime start`.
import { startKxmRuntimeSupervisor } from "../plugins/kxm/dist/runtime-supervisor.js";

const supervisor = await startKxmRuntimeSupervisor({});
process.stdout.write(`kxm-runtime-supervisor ready runtimeId=${supervisor.runtimeId} port=${supervisor.port}\n`);

