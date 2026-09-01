import * as net from "net";

/**
 * Finds an available TCP port on the loopback interface.
 *
 * The returned port is probed before it is handed to the caller, so another
 * process can claim it before the caller reuses it. Callers should invoke
 * this function again if that later bind reports EADDRINUSE.
 */
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => {
          reject(new Error("Loopback port probe did not return a TCP address"));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });

    server.listen(0, "127.0.0.1");
  });
}
