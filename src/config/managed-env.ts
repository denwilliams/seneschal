import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FILE = 1024 * 1024;
const MAX_VALUE = 16 * 1024;
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const PROTECTED = new Set(["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "IFS", "CDPATH", "PWD", "OLDPWD", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "TZ", "LANG", "LANGUAGE", "LOG_LEVEL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]);
export function protectedEnvName(name: string): boolean {
  return PROTECTED.has(name) || /^(HARNESS_|NODE_|LD_|DYLD_|BASH_|GIT_|NPM_|npm_|LC_|PYTHON)/.test(name);
}
export class SecretAdminError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const unavailable = () => new SecretAdminError(503, "Managed environment storage is unavailable. Check its private directory, file permissions and format on the host.");

/** Operator-controlled absolute path; refuse symlinks, public storage and shared/hard-linked files. */
function checkDirectory(file: string): void {
  if (!isAbsolute(file) || resolve(file) !== file) throw unavailable();
  let current = parse(file).root;
  for (const part of relative(current, dirname(file)).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
  const parent = lstatSync(dirname(file));
  if ((parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())) throw unavailable();
}
function readValues(file: string): Record<string, string> {
  try {
    checkDirectory(file);
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, string>; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw unavailable();
      const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
      const values: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [name, value] of Object.entries(parsed)) {
        if (!NAME.test(name) || protectedEnvName(name) || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > MAX_VALUE) throw unavailable();
        values[name] = value;
      }
      return values;
    } finally { closeSync(fd); }
  } catch { throw unavailable(); }
}

/** Run before YAML expansion and provider/Slack initialization. Managed values override inherited values. */
export function loadManagedEnvironment(file: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!file) return;
  Object.assign(env, readValues(file));
}

export interface SecretSnapshot {
  enabled: boolean;
  instance: string;
  variables: { name: string; set: boolean; source: "managed" | "inherited"; pendingRestart: boolean; protected: boolean }[];
  restart: { available: boolean; pending: boolean };
}

/** The service never returns values or places writes in task/audit records. No live mutation of process.env. */
export class SecretAdmin {
  readonly instance = randomUUID();
  private readonly inherited: NodeJS.ProcessEnv;
  private restarting = false;
  private readonly file?: string;
  private readonly restart?: () => void;
  constructor(file?: string, restart?: () => void, env: NodeJS.ProcessEnv = process.env) {
    this.file = file;
    this.restart = restart;
    this.inherited = { ...env };
  }
  /** Keep the private store out of channel workspaces, shared state and normal data backups. */
  assertOutsideData(dataDir: string): void {
    if (!this.file) return;
    // Resolve existing ancestors too: dataDir may be a symlink, or not yet exist.
    let existing = resolve(dataDir);
    const missing: string[] = [];
    while (!existsSync(existing)) {
      missing.unshift(parse(existing).base);
      existing = dirname(existing);
    }
    const root = resolve(realpathSync(existing), ...missing);
    const location = relative(root, this.file);
    if (!location || (location !== ".." && !location.startsWith("../") && !isAbsolute(location))) throw unavailable();
  }
  snapshot(): SecretSnapshot {
    const values = this.file ? readValues(this.file) : {};
    const names = [...new Set([...Object.keys(this.inherited), ...Object.keys(values)])].filter((name) => NAME.test(name)).sort();
    return {
      enabled: Boolean(this.file), instance: this.instance,
      variables: names.map((name) => ({ name, set: Object.hasOwn(values, name) || this.inherited[name] !== undefined, source: Object.hasOwn(values, name) ? "managed" : "inherited", pendingRestart: Object.hasOwn(values, name) && values[name] !== this.inherited[name], protected: protectedEnvName(name) })),
      restart: { available: Boolean(this.restart), pending: this.restarting },
    };
  }
  save(name: string, value: string, overwrite: boolean): void {
    if (!this.file) throw new SecretAdminError(503, "Managed environment storage is not enabled by the operator.");
    if (this.restarting) throw new SecretAdminError(409, "Restart already requested; wait for the harness to return.");
    if (!NAME.test(name) || protectedEnvName(name)) throw new SecretAdminError(422, "Use an uppercase environment name that is not a protected runtime/control variable.");
    if (!value || value.includes("\0") || Buffer.byteLength(value) > MAX_VALUE) throw new SecretAdminError(422, "Supply a non-empty secret value of at most 16 KiB without NUL characters.");
    const values = readValues(this.file);
    if ((Object.hasOwn(values, name) || this.inherited[name] !== undefined) && !overwrite) throw new SecretAdminError(409, "That name is already set. Explicitly confirm replacement.");
    values[name] = value;
    const text = JSON.stringify(values) + "\n";
    if (Buffer.byteLength(text) > MAX_FILE) throw new SecretAdminError(413, "Managed environment storage is full.");
    const temporary = join(dirname(this.file), `.managed-env-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      const directory = openSync(dirname(this.file), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { throw unavailable(); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  /** Reserve once, but do not shut down until the HTTP acknowledgement has finished. */
  prepareRestart(): () => void {
    if (!this.restart) throw new SecretAdminError(503, "Restart is unavailable. The operator must enable supervised restart on the host.");
    if (this.restarting) throw new SecretAdminError(409, "Restart already requested.");
    this.restarting = true;
    let started = false;
    return () => {
      if (started) return;
      started = true;
      try { this.restart!(); }
      catch { this.restarting = false; }
    };
  }
}
