// ABOUTME: CLI argument parsing and host/network helpers for the runtime server.
// ABOUTME: Extracted from server.ts so these can be unit-tested without loading the full server.

export interface CliArgs {
  host: string;
  port: number;
  noOpen: boolean;
  help: boolean;
}

export function parseCliArgs(argv: string[] = process.argv): CliArgs {
  const args: CliArgs = {
    host: process.env.SEREN_HOST || "127.0.0.1",
    port: Number(process.env.SEREN_PORT) || 19420,
    noOpen: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--host" || arg === "-H") && argv[i + 1]) {
      args.host = argv[++i];
    } else if ((arg === "--port" || arg === "-p") && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else if (arg === "--no-open") {
      args.noOpen = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

/** True when the remote address is a loopback IP (IPv4 or IPv6). */
export function isLoopbackAddr(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** True when the configured HOST is a loopback or unset (default). */
export function isLocalhostHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
