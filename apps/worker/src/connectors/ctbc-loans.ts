import type { SyncResult } from "@taiwan-fin-hub/core";
import {
  CtbcConnectionError,
  CtbcVerificationRequiredError,
  type CtbcConfig,
} from "@taiwan-fin-hub/connectors";
import { launchBrowserWithRetry } from "./browser";

const LOGIN_URL = "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010";
export type CtbcLoanRow = { account: string; principal: string };

/** Only the observed installment-loan balance column; never the payment column. */
export async function parseCtbcLoanRows(
  rows: CtbcLoanRow[],
  now = new Date(),
): Promise<SyncResult<never>> {
  if (!rows.length)
    throw new CtbcConnectionError(
      "中信信貸頁未提供貸款餘額；保留上次資料，不視為零負債。",
    );
  const result: SyncResult<never> = {
    records: [],
    bankAccounts: [],
    bankBalanceSnapshots: [],
  };
  const seen = new Set<string>();
  for (const row of rows) {
    const account = row.account.replace(/[\s-]/g, "");
    const amount = row.principal.trim();
    if (
      !/^(?:\d{12}|\d{16})$/.test(account) ||
      !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)
    ) {
      throw new CtbcConnectionError("中信信貸餘額格式無法辨識；保留上次資料。");
    }
    const principal = Number(amount.replace(/,/g, ""));
    if (!Number.isFinite(principal) || principal > Number.MAX_SAFE_INTEGER)
      throw new CtbcConnectionError("中信信貸餘額格式無法辨識。");
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`ctbc:loan:${account}`),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const sourceId = `ctbc:loan:${hash}`;
    if (seen.has(sourceId))
      throw new CtbcConnectionError("中信信貸頁出現重複帳戶；保留上次資料。");
    seen.add(sourceId);
    result.bankAccounts!.push({
      sourceId,
      institutionName: "中國信託商業銀行",
      accountName: `中信信貸（末四碼 ${account.slice(-4)}）`,
      accountType: "loan",
      currency: "TWD",
      raw: { balanceBasis: "outstanding_principal", source: "ctbc_web" },
    });
    result.bankBalanceSnapshots!.push({
      accountId: sourceId,
      sourceId: `${sourceId}:${now.toISOString()}`,
      balance: -principal,
      currency: "TWD",
      asOfAt: now.toISOString(),
      raw: { balanceBasis: "outstanding_principal" },
    });
  }
  result.cursor = JSON.stringify({ syncedAt: now.toISOString() });
  return result;
}

export async function syncCtbcLoans(
  browserBinding: Fetcher | undefined,
  config: CtbcConfig,
): Promise<SyncResult<never>> {
  if (!browserBinding)
    throw new CtbcConnectionError("中信信貸同步需要瀏覽器服務。");
  if (!config.userId || !config.account || !config.password)
    throw new CtbcVerificationRequiredError("請先儲存中信網銀登入資料。");
  const browser = await launchBrowserWithRetry(browserBinding);
  const page = await browser.newPage();
  // Fixed labels only: never include browser errors, URLs or bank responses.
  let phase = "瀏覽器初始化";
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = new URL(request.url());
      // Query and login only. No payment, transfer, application or settings actions.
      if (/(?:\/twrbc-pay\/|\/tx\d+\/)/i.test(url.pathname))
        void request.abort().catch(() => {});
      else void request.continue().catch(() => {});
    });
    phase = "載入網銀頁面";
    const loginResponse = await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    phase = "尋找登入欄位";
    try {
      await page.waitForSelector('input[formcontrolname="custIxd"]', {
        visible: true,
        timeout: 30_000,
      });
    } catch {
      const diagnostics = await page
        .evaluate(() => ({
          inputs: document.querySelectorAll("input").length,
          passwords: document.querySelectorAll('input[type="password"]').length,
          bankLoginLabels: (document.body?.innerText ?? "").includes(
            "使用者代號",
          ),
          denied:
            /Access Denied|Request Rejected|Forbidden|Sorry, you have been blocked|拒絕存取/i.test(
              document.body?.innerText ?? "",
            ),
        }))
        .catch(() => null);
      throw new CtbcConnectionError(
        `中信網銀尚未取得登入表單（HTTP ${loginResponse?.status() ?? 0}；欄位 ${diagnostics?.inputs ?? 0}；密碼欄位 ${diagnostics?.passwords ?? 0}；登入標籤 ${diagnostics?.bankLoginLabels === true}；拒絕存取 ${diagnostics?.denied === true}）；未提交帳密。`,
      );
    }
    if (new URL(page.url()).origin !== "https://www.ctbcbank.com") {
      throw new CtbcConnectionError("中信網銀登入頁來源不符，已停止同步。");
    }
    phase = "填入登入欄位";
    await page.type('input[formcontrolname="custIxd"]', config.userId);
    await page.type('input[formcontrolname="userIxd"]', config.account);
    await page.type('input[formcontrolname="pxd"]', config.password);
    phase = "提交登入";
    await page.evaluate(() => {
      const form = document
        .querySelector('input[formcontrolname="custIxd"]')
        ?.closest("form");
      const button = Array.from(
        form?.querySelectorAll<HTMLElement>('a[role="button"],button') ?? [],
      ).find(
        (element) =>
          element.textContent?.trim() === "登入" &&
          element.getClientRects().length,
      );
      if (!button) throw new Error("Login control unavailable");
      button.click();
    });
    try {
      await page.waitForFunction(
        () =>
          location.origin === "https://www.ctbcbank.com" &&
          location.pathname.includes("/twrbc-home/qu000/010") &&
          Array.from(document.querySelectorAll("a,button")).some(
            (element) =>
              element.getClientRects().length &&
              element.textContent?.trim() === "登出",
          ),
        { timeout: 30_000 },
      );
    } catch {
      throw new CtbcVerificationRequiredError(
        "中信網銀信貸登入未完成，或銀行要求額外驗證；未自動重試，也未更新貸款餘額。",
      );
    }
    // Follow the observed read-only home -> loan summary -> detail navigation.
    for (const label of ["信用貸款", "看信用貸款明細"]) {
      phase = label === "信用貸款" ? "開啟貸款概要" : "開啟貸款明細";
      await page.waitForFunction(
        (text) =>
          Array.from(document.querySelectorAll("a")).some(
            (element) =>
              element.getClientRects().length &&
              element.textContent?.trim() === text,
          ),
        { timeout: 15_000 },
        label,
      );
      await page.evaluate((text) => {
        if (location.origin !== "https://www.ctbcbank.com")
          throw new Error("Unexpected origin");
        const link = Array.from(document.querySelectorAll("a")).find(
          (element) =>
            element.getClientRects().length &&
            element.textContent?.trim() === text,
        );
        if (!link) throw new Error("Query link unavailable");
        link.click();
      }, label);
    }
    await page.waitForFunction(
      () =>
        location.pathname.includes("/twrbc-invest/qu029/010") &&
        Array.from(document.querySelectorAll("table")).some(
          (table) =>
            table.getClientRects().length &&
            table.textContent?.includes("貸款餘額"),
        ),
      { timeout: 15_000 },
    );
    phase = "選取信用貸款分頁";
    const selected = await page.evaluate(() => {
      const tab = Array.from(
        document.querySelectorAll<HTMLAnchorElement>(".nav-tabs a.nav-link"),
      ).find(
        (element) =>
          element.textContent?.trim() === "信用貸款" &&
          element.getClientRects().length,
      );
      if (!tab) return false;
      tab.click();
      return true;
    });
    if (!selected)
      throw new CtbcConnectionError(
        "中信網銀未提供信用貸款分頁；保留上次資料。",
      );
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll(".nav-tabs a.nav-link.active"),
        ).some((element) => element.textContent?.trim() === "信用貸款"),
      { timeout: 5_000 },
    );
    phase = "讀取信貸餘額欄位";
    const rows = await page.evaluate(() => {
      if (location.origin !== "https://www.ctbcbank.com")
        throw new Error("Unexpected origin");
      const table = Array.from(document.querySelectorAll("table")).find(
        (table) =>
          table.getClientRects().length &&
          Array.from(table.querySelectorAll("th"))
            .map((th) => th.textContent?.trim())
            .join("|") ===
            "產品別|貸款帳號|貸款餘額|貸款日|到期日|還款日|應繳金額|",
      );
      return Array.from(table?.querySelectorAll("tbody tr") ?? []).map(
        (row) => {
          const cells = row.querySelectorAll("td");
          return {
            account: cells[1]?.textContent?.trim() ?? "",
            principal: cells[2]?.textContent?.trim() ?? "",
          };
        },
      );
    });
    return await parseCtbcLoanRows(rows);
  } catch (error) {
    if (
      error instanceof CtbcVerificationRequiredError ||
      error instanceof CtbcConnectionError
    )
      throw error;
    throw new CtbcConnectionError(
      `中信網銀信貸查詢未完成（${phase}）；保留上次貸款餘額。`,
    );
  } finally {
    await page
      .evaluate(() => {
        const logout = Array.from(
          document.querySelectorAll<HTMLElement>("a,button"),
        ).find(
          (element) =>
            element.textContent?.trim() === "登出" &&
            element.getClientRects().length,
        );
        logout?.click();
      })
      .catch(() => {});
    await browser.close().catch(() => {});
  }
}
