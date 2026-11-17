import { artifactChannelUrl } from "../artifacts/server.ts";

/** Links are built from the configured base URL so a reverse-proxy prefix keeps working. */
export class ConsoleLinks {
  readonly baseUrl: string;
  private readonly prefix: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl; this.prefix = new URL(baseUrl).pathname.replace(/\/$/, ""); }
  root(): string { return `${this.prefix}/console2/`; }
  channel(id: string, view?: "timeline" | "factory", tab?: "files"): string {
    const query = [tab ? `tab=${tab}` : "", view ? `view=${view}` : ""].filter(Boolean).join("&");
    return `${this.prefix}/console2/#/c/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
  }
  connectorConnect(id: string, connector: string): string { return `${this.prefix}/oauth/connect?channel=${encodeURIComponent(id)}&connector=${encodeURIComponent(connector)}`; }
  artifactFile(id: string, path: string): string { return `${artifactChannelUrl(this.baseUrl, id)}${path.split("/").map(encodeURIComponent).join("/")}`; }
}
