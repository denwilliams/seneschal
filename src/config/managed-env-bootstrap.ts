// This side-effect import must run before libraries that may capture provider credentials at import time.
import { loadManagedEnvironment } from "./managed-env.ts";
loadManagedEnvironment(process.env.HARNESS_MANAGED_ENV_FILE);
