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
});
