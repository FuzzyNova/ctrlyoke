import { describe, expect, it } from "vitest";
import { SERVER_BIND_ADDRESSES } from "@root/types/DashboardConstants";
import { getServerCertLanCoverage } from "@utils/serverCertCoverage";

const LOCALHOST_ONLY = ["localhost", "127.0.0.1"];
const WITH_LAN = [...LOCALHOST_ONLY, "192.168.55.25", "192.168.224.1"];

describe("getServerCertLanCoverage", () => {
  it("accepts a localhost-only cert while the server is bound to localhost", () => {
    expect(
      getServerCertLanCoverage(
        SERVER_BIND_ADDRESSES.LOCALHOST,
        LOCALHOST_ONLY,
        null
      )
    ).toEqual({ covered: true });
  });

  it("flags a localhost-only cert on an all-interfaces server that isn't running", () => {
    expect(
      getServerCertLanCoverage(
        SERVER_BIND_ADDRESSES.ALL_INTERFACES,
        LOCALHOST_ONLY,
        null
      )
    ).toEqual({ covered: false, address: null });
  });

  it("flags the connect address when the cert doesn't list it", () => {
    expect(
      getServerCertLanCoverage(
        SERVER_BIND_ADDRESSES.ALL_INTERFACES,
        WITH_LAN,
        "10.0.0.7"
      )
    ).toEqual({ covered: false, address: "10.0.0.7" });
  });

  it("accepts a cert that lists the connect address, or any LAN address when none is known", () => {
    expect(
      getServerCertLanCoverage(
        SERVER_BIND_ADDRESSES.ALL_INTERFACES,
        WITH_LAN,
        "192.168.55.25"
      )
    ).toEqual({ covered: true });
    expect(
      getServerCertLanCoverage(
        SERVER_BIND_ADDRESSES.ALL_INTERFACES,
        WITH_LAN,
        null
      )
    ).toEqual({ covered: true });
  });
});
