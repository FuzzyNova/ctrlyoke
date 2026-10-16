import { TRUST_DECISIONS } from "../types/DashboardConstants";
import type { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import type { CliTrustIo } from "./CliTrustGate";

export interface TrustExternalRootsOptions {
  cwd?: string;
  yes?: boolean;
}

/** Review and record one decision for a list of pending external roots. */
export async function trustExternalRootsCommand(
  scopeIdentity: string,
  roots: readonly string[],
  heading: string,
  emptyMessage: string,
  options: TrustExternalRootsOptions,
  io: CliTrustIo,
  trustStore: Pick<ExternalRootsTrustStore, "setDecisions">
): Promise<number> {
  if (roots.length === 0) {
    io.writeOut(emptyMessage);
    return 0;
  }

  io.writeErr(heading);
  roots.forEach((root) => io.writeErr(`  - ${root}`));

  if (!options.yes && !io.isInteractive) {
    io.writeErr(
      "Error: no terminal to ask in. Rerun in a terminal, or pass --yes to allow every listed root."
    );
    return 2;
  }

  const approved =
    options.yes ||
    (await io.confirm(`Trust all ${roots.length} listed folder(s)? [y/N] `));
  await trustStore.setDecisions(
    scopeIdentity,
    roots,
    approved ? TRUST_DECISIONS.ALLOW : TRUST_DECISIONS.DENY
  );

  if (!approved) {
    io.writeOut(
      "No roots were approved. They remain blocked — change this in Settings if needed."
    );
    return 0;
  }

  io.writeOut(`✓ Approved ${roots.length} external file root(s).`);
  return 0;
}
