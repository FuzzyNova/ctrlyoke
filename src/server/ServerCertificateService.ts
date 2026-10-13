import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { NETWORK_INTERFACE_FAMILIES } from "../types/DashboardConstants";
import {
  isIpv4Literal,
  normalizePublicHostname,
} from "../utils/ServerPublicHostname";

export interface GeneratedServerCertificate {
  readonly certPath: string;
  readonly keyPath: string;
  readonly generatedAt: Date;
  readonly expiresAt: Date;
  readonly sans: readonly string[];
}

/** Generates the local CA certificate used to trust hosted ctrlyoke servers. */
export class ServerCertificateService {
  /**
   * `includeLanIps` is true for an all-interfaces server. Only then is
   * `publicHostname` (`server.publicHostname`) added: a localhost-only server
   * is never reached by name from another network.
   */
  async generate(
    certDir: string,
    includeLanIps: boolean,
    publicHostname?: string | null
  ): Promise<GeneratedServerCertificate> {
    await fs.mkdir(certDir, { recursive: true });
    const lanIps = includeLanIps
      ? Object.values(os.networkInterfaces())
          .flat()
          .filter(
            (iface): iface is os.NetworkInterfaceInfo =>
              !!iface &&
              iface.family === NETWORK_INTERFACE_FAMILIES.IPV4 &&
              !iface.internal
          )
          .map((iface) => iface.address)
      : [];
    const hostname = includeLanIps
      ? normalizePublicHostname(publicHostname)
      : null;
    const extraHosts = hostname && !lanIps.includes(hostname) ? [hostname] : [];
    const { generate } = await import("selfsigned");
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt);
    expiresAt.setDate(expiresAt.getDate() + 365);
    const pems = await generate(
      [{ name: "commonName", value: "ctrlyoke Local CA" }],
      {
        notBeforeDate: generatedAt,
        notAfterDate: expiresAt,
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
          { name: "basicConstraints", cA: true, critical: true },
          {
            name: "keyUsage",
            keyCertSign: true,
            digitalSignature: true,
            nonRepudiation: true,
            keyEncipherment: true,
            dataEncipherment: true,
            critical: true,
          },
          { name: "extKeyUsage", serverAuth: true },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
              ...lanIps.map((ip) => ({ type: 7 as const, ip })),
              ...extraHosts.map((host) =>
                isIpv4Literal(host)
                  ? { type: 7 as const, ip: host }
                  : { type: 2 as const, value: host }
              ),
            ],
          },
        ],
      }
    );
    const certPath = path.join(certDir, "cert.pem");
    const keyPath = path.join(certDir, "key.pem");
    await Promise.all([
      fs.writeFile(certPath, pems.cert, "utf8"),
      fs.writeFile(keyPath, pems.private, "utf8"),
    ]);
    return {
      certPath,
      keyPath,
      generatedAt,
      expiresAt,
      sans: ["localhost", "127.0.0.1", ...lanIps, ...extraHosts],
    };
  }
}
