#!/usr/bin/env node
// KXM vNext Runtime supervisor entry point. Detached child of `kxm runtime start`.
import { startVnextRuntimeSupervisor } from "../plugins/kxm/dist/vnext-runtime-supervisor.js";

const supervisor = await startVnextRuntimeSupervisor({});
process.stdout.write(`kxm-runtime-supervisor ready runtimeId=${supervisor.runtimeId} port=${supervisor.port}\n`);

