import { describe, expect, it } from "vitest";
import { ROLE_FOR_CONSTANT, roleAccount } from "./role-map.js";

const acc = (id: number, roles: string[]) => ({ id, cl_account_groups: roles }) as never;

describe("F7: roles instead of hard-coded account numbers", () => {
  it("maps all 16 constants in scope to roles (the 2 securities constants stay, their tools are off)", () => {
    expect(Object.keys(ROLE_FOR_CONSTANT)).toHaveLength(16);
    expect(ROLE_FOR_CONSTANT.DEFAULT_LIABILITY_ACCOUNT).toBe("PAYABLE");
    expect(ROLE_FOR_CONSTANT.DEFAULT_FX_LOSS_ACCOUNT).toBe("FX_LOSS");
  });
  it("resolves a role against the chart, or names the missing role", () => {
    const chart = [acc(22, ["PAYABLE"]), acc(120, ["RECEIVABLE"])];
    expect(roleAccount(chart, "PAYABLE")).toBe(22);
    expect(roleAccount(chart, "OWNER_PAYABLE")).toEqual({ missing: "OWNER_PAYABLE" });
  });
});
