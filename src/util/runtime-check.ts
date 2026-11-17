/**
 * The conversation store needs Node's built-in SQLite (`node:sqlite`, with the lock timeout option) and the
 * harness depends on a minimum Node release. An older Node would otherwise fail on the first store open with an
 * error that does not say what to do, possibly after Slack is already connected.
 */
export const MINIMUM_NODE = { major: 22, minor: 19 } as const;

export function nodeVersionProblem(version: string = process.versions.node): string | undefined {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor)) return undefined;
  return `Node ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer is required (this is ${version}). ` +
    "Upgrade Node, or rebuild the image: Dockerfile.harness pins a supported version.";
}

export function assertSupportedNode(version: string = process.versions.node): void {
  const problem = nodeVersionProblem(version);
  if (problem) throw new Error(problem);
}
