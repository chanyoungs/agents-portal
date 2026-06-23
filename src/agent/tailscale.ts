// Enumerate tailnet machines via the local Tailscale CLI, for auto-discovery.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Peer {
  hostName: string;
  /** MagicDNS name without the trailing dot, e.g. "workstationA.tailnet.ts.net". */
  dnsName: string;
  online: boolean;
  self: boolean;
}

const clean = (dns: string): string => dns.replace(/\.$/, '');

/** All tailnet machines (self + peers). Empty if Tailscale isn't running. */
export async function listPeers(): Promise<Peer[]> {
  try {
    const { stdout } = await exec('tailscale', ['status', '--json']);
    const status = JSON.parse(stdout);
    const peers: Peer[] = [];
    if (status.Self?.DNSName) {
      peers.push({
        hostName: status.Self.HostName,
        dnsName: clean(status.Self.DNSName),
        online: true,
        self: true,
      });
    }
    for (const p of Object.values<any>(status.Peer ?? {})) {
      if (!p.DNSName) continue;
      peers.push({ hostName: p.HostName, dnsName: clean(p.DNSName), online: !!p.Online, self: false });
    }
    return peers;
  } catch {
    return [];
  }
}

/** The login the request came from, per Tailscale Serve's injected header. */
export function identityLogin(headers: Record<string, unknown>): string | null {
  const v = headers['tailscale-user-login'];
  return typeof v === 'string' ? v : null;
}
