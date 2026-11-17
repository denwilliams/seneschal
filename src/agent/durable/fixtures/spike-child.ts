import { openRaw } from "./spike-job.ts";

/** Starts a job and runs it until the parent kills this process. */
const [dir, id] = process.argv.slice(2);
if (!dir || !id) throw new Error("dir and id required");
const { harness, start } = await openRaw(dir);
await start(id);
harness.resume();
setInterval(() => {}, 1000);
