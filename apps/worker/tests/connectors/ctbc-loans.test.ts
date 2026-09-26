import { describe, expect, it, vi, afterEach } from "vitest";
import {
  parseCtbcLoanRows,
  syncCtbcLoans,
} from "../../src/connectors/ctbc-loans";
import { launchBrowserWithRetry } from "../../src/connectors/browser";

vi.mock("../../src/connectors/browser", () => ({
  launchBrowserWithRetry: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

describe("CTBC installment loan balances", () => {
  it("diagnoses a missing public login form without submitting credentials or exposing page contents", async () => {
    const page = {
      setViewport: vi.fn(),
      setRequestInterception: vi.fn(),
      on: vi.fn(),
      goto: vi.fn().mockResolvedValue({ status: () => 403 }),
      waitForSelector: vi
        .fn()
        .mockRejectedValue(new Error("synthetic-sensitive-browser-error")),
      evaluate: vi.fn().mockResolvedValue({
        inputs: 0,
        passwords: 0,
        bankLoginLabels: false,
        denied: true,
      }),
      type: vi.fn(),
    };
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(launchBrowserWithRetry).mockResolvedValue({
      newPage: async () => page,
      close,
    } as never);
    await expect(
      syncCtbcLoans({} as Fetcher, {
        userId: "synthetic-id",
        account: "synthetic-user",
        password: "synthetic-password",
      }),
    ).rejects.toThrow(
      /^中信網銀尚未取得登入表單（HTTP 403；欄位 0；密碼欄位 0；登入標籤 false；拒絕存取 true）；未提交帳密。$/,
    );
    expect(page.type).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  });
  it("reports only a fixed failure phase and never exposes raw browser errors", async () => {
    const page = {
      setViewport: vi.fn(),
      setRequestInterception: vi.fn(),
      on: vi.fn(),
      goto: vi
        .fn()
        .mockRejectedValue(new Error("synthetic-sensitive-response")),
      evaluate: vi.fn().mockResolvedValue(undefined),
      type: vi.fn(),
    };
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(launchBrowserWithRetry).mockResolvedValue({
      newPage: async () => page,
      close,
    } as never);
    await expect(
      syncCtbcLoans({} as Fetcher, {
        userId: "synthetic-id",
        account: "synthetic-user",
        password: "synthetic-password",
      }),
    ).rejects.toThrow(
      /^中信網銀信貸查詢未完成（載入網銀頁面）；保留上次貸款餘額。$/,
    );
    expect(page.type).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("reads the personal-loan tab, closes the browser and blocks payment navigation", async () => {
    const page = {
      setViewport: vi.fn(),
      setRequestInterception: vi.fn(),
      on: vi.fn(),
      goto: vi.fn(),
      waitForSelector: vi.fn(),
      url: () => "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010",
      type: vi.fn(),
      waitForFunction: vi.fn(),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce([
          { account: "001234567890", principal: "300,000" },
        ])
        .mockResolvedValueOnce(undefined),
    };
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(launchBrowserWithRetry).mockResolvedValue({
      newPage: async () => page,
      close,
    } as never);
    const result = await syncCtbcLoans({} as Fetcher, {
      userId: "synthetic-id",
      account: "synthetic-user",
      password: "synthetic-password",
    });
    expect(result.bankBalanceSnapshots?.[0]?.balance).toBe(-300000);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010",
      expect.any(Object),
    );
    expect(page.evaluate.mock.calls[1]?.[1]).toBe("信用貸款");
    expect(page.evaluate.mock.calls[2]?.[1]).toBe("看信用貸款明細");
    expect(close).toHaveBeenCalledOnce();
    const handleRequest = page.on.mock.calls[0]![1];
    const abort = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn().mockResolvedValue(undefined);
    handleRequest({
      url: () => "https://www.ctbcbank.com/twrbc/twrbc-pay/tx001/010",
      abort,
      continue: resume,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });
  it.each(["001234567890", "0000123456787890"])(
    "uses negative principal and masked stable IDs for %s",
    async (account) => {
      const rows = [{ account, principal: "123,456.78" }];
      const first = await parseCtbcLoanRows(
        rows,
        new Date("2026-09-26T00:00:00Z"),
      );
      const next = await parseCtbcLoanRows(
        [{ ...rows[0]!, principal: "120,000" }],
        new Date("2026-09-27T00:00:00Z"),
      );
      expect(first.bankAccounts?.[0]?.accountType).toBe("loan");
      expect(first.bankBalanceSnapshots?.[0]?.balance).toBe(-123456.78);
      expect(next.bankAccounts?.[0]?.sourceId).toBe(
        first.bankAccounts?.[0]?.sourceId,
      );
      expect(next.bankBalanceSnapshots?.[0]?.balance).toBe(-120000);
      expect(JSON.stringify(first)).not.toContain(rows[0]!.account);
      expect(first.bankAccounts?.[0]?.accountName).toContain("7890");
      expect(JSON.parse(first.cursor!)).toEqual({
        syncedAt: "2026-09-26T00:00:00.000Z",
      });
    },
  );
  it.each(["", "—", "NaN", "-1", "12,34", "100 元", "Infinity"])(
    "rejects missing or ambiguous principal %s",
    async (principal) => {
      await expect(
        parseCtbcLoanRows([{ account: "001234567890", principal }]),
      ).rejects.toThrow("格式");
    },
  );
  it("does not interpret an empty list as cleared debt", async () => {
    await expect(parseCtbcLoanRows([])).rejects.toThrow("不視為零負債");
  });
  it("accepts an explicit zero but rejects duplicate accounts and masked IDs", async () => {
    const row = { account: "001234567890", principal: "0" };
    expect(
      (await parseCtbcLoanRows([row])).bankBalanceSnapshots?.[0]?.balance,
    ).toBe(-0);
    await expect(parseCtbcLoanRows([row, row])).rejects.toThrow("重複");
    await expect(
      parseCtbcLoanRows([{ ...row, account: "********7890" }]),
    ).rejects.toThrow("格式");
  });
  it("stops on a verification challenge, never retries login, and closes the browser", async () => {
    const page = {
      setViewport: vi.fn(),
      setRequestInterception: vi.fn(),
      on: vi.fn(),
      goto: vi.fn(),
      waitForSelector: vi.fn(),
      url: () => "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010",
      type: vi.fn(),
      evaluate: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockRejectedValue(new Error("challenge")),
    };
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(launchBrowserWithRetry).mockResolvedValue({
      newPage: async () => page,
      close,
    } as never);
    await expect(
      syncCtbcLoans({} as Fetcher, {
        userId: "synthetic-id",
        account: "synthetic-user",
        password: "synthetic-password",
      }),
    ).rejects.toMatchObject({ name: "CtbcVerificationRequiredError" });
    expect(page.type).toHaveBeenCalledTimes(3);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  });
});
