import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { FleetError } from "./types.js";

export interface StrictBoundary { version: 1; boundary: "linux-output-firewall"; proxyHost: string; proxyPort: number; uid: number; ipv6: "blocked"; dns: "blocked" }
/** Only a root-owned attestation installed by the firewall entrypoint can enable strict mode. */
export async function assertStrictEgress(policy?: string, proxyUrl?: string, attestationPath = "/run/steel/strict-egress.json"): Promise<StrictBoundary | undefined> {
  if (policy !== "strict") return undefined;
  if (!proxyUrl) throw new FleetError("strict_proxy_required", "Strict egress requires a configured proxy", 400);
  let endpoint: URL;
  try { endpoint = new URL(proxyUrl); } catch { throw new FleetError("strict_proxy_required", "Strict egress requires a valid proxy", 400); }
  let boundary: StrictBoundary;
  try {
    const info = await stat(attestationPath);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("untrusted boundary");
    boundary = JSON.parse(await readFile(attestationPath, "utf8"));
  } catch { throw new FleetError("strict_boundary_unavailable", "Strict egress requires a configured Linux firewall worker; this runtime has no verified network boundary", 503); }
  const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
  if (boundary.version !== 1 || boundary.boundary !== "linux-output-firewall" || boundary.ipv6 !== "blocked" || boundary.dns !== "blocked" || boundary.proxyHost !== endpoint.hostname || boundary.proxyPort !== port || !isIP(boundary.proxyHost) || process.getuid?.() !== boundary.uid || boundary.uid === 0) throw new FleetError("strict_boundary_mismatch", "Strict proxy does not match this worker's enforced network boundary", 503);
  return boundary;
}
