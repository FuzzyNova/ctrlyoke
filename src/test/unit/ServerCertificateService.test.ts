import * as assert from "assert";
import { X509Certificate } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { ServerCertificateService } from "../../server/ServerCertificateService";

suite("ServerCertificateService", () => {
  test("writes the local CA cert and key under the supplied directory", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-server-cert-")
    );
    const certDir = path.join(tempRoot, ".ctrlyoke", "certs");
    try {
      const generated = await new ServerCertificateService().generate(
        certDir,
        false
      );
      assert.strictEqual(generated.certPath, path.join(certDir, "cert.pem"));
      assert.strictEqual(generated.keyPath, path.join(certDir, "key.pem"));
      const cert = new X509Certificate(await fs.readFile(generated.certPath));
      assert.strictEqual(cert.ca, true);
      assert.match(cert.subject, /CN=ctrlyoke Local CA/);
      assert.match(cert.subjectAltName ?? "", /DNS:localhost/);
      assert.match(cert.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
      assert.deepStrictEqual(generated.sans, ["localhost", "127.0.0.1"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("adds the public hostname as a DNS name for an all-interfaces server", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-server-cert-")
    );
    try {
      const generated = await new ServerCertificateService().generate(
        tempRoot,
        true,
        "  My-PC.Example.ts.net "
      );
      const cert = new X509Certificate(await fs.readFile(generated.certPath));
      assert.match(cert.subjectAltName ?? "", /DNS:my-pc\.example\.ts\.net/);
      assert.strictEqual(generated.sans.at(-1), "my-pc.example.ts.net");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("adds a public IPv4 hostname as an IP address", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-server-cert-")
    );
    try {
      const generated = await new ServerCertificateService().generate(
        tempRoot,
        true,
        "203.0.113.7"
      );
      const cert = new X509Certificate(await fs.readFile(generated.certPath));
      assert.match(cert.subjectAltName ?? "", /IP Address:203\.0\.113\.7/);
      assert.ok(!/DNS:203\.0\.113\.7/.test(cert.subjectAltName ?? ""));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("ignores the public hostname for a localhost-only server or an invalid value", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-server-cert-")
    );
    try {
      const service = new ServerCertificateService();
      const localOnly = await service.generate(
        path.join(tempRoot, "local"),
        false,
        "my-pc.example.ts.net"
      );
      assert.deepStrictEqual(localOnly.sans, ["localhost", "127.0.0.1"]);
      const invalid = await service.generate(
        path.join(tempRoot, "invalid"),
        true,
        "https://my-pc.example.ts.net:4747"
      );
      assert.ok(!invalid.sans.some((san) => san.includes("example")));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
