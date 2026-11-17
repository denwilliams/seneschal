export interface ConnectorAuthArgs {
  config?: string;
  result?: string;
  noWait: boolean;
  reset: boolean;
  positional: string[];
}

/** Parse without echoing arguments: --result contains a one-time credential. */
export function parseConnectorAuthArgs(argv: string[]): ConnectorAuthArgs {
  const out: ConnectorAuthArgs = { noWait: false, reset: false, positional: [] };
  const invalid = () => { throw new Error("Invalid connector-auth arguments"); };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--config" || arg === "--result") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) invalid();
      if (arg === "--config") out.config = value;
      else out.result = value;
    } else if (arg.startsWith("--config=")) out.config = arg.slice("--config=".length);
    else if (arg.startsWith("--result=")) out.result = arg.slice("--result=".length);
    else if (arg === "--no-wait") out.noWait = true;
    else if (arg === "--reset") out.reset = true;
    else if (arg.startsWith("-")) invalid();
    else out.positional.push(arg);
  }
  if (out.positional.length !== 2 || out.config === "" || out.result === "" ||
      (out.reset && (out.result !== undefined || out.noWait))) invalid();
  return out;
}
