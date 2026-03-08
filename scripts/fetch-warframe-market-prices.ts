import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "https://api.warframe.market/v2";
const REQUESTS_PER_SECOND = 3;
const REQUEST_INTERVAL_MS = Math.ceil(1000 / REQUESTS_PER_SECOND);
const OUTPUT_RELATIVE_PATH = path.join("data", "warframe-market-prices.json");

type JsonObject = Record<string, unknown>;

interface ApiResponse<T> {
  apiVersion?: string;
  data: T | null;
  error: JsonObject | null;
}

interface MarketOrder {
  id?: string;
  type?: "buy" | "sell" | string;
  platinum?: number;
  quantity?: number;
  perTrade?: number;
  rank?: number;
  charges?: number;
  subtype?: string;
  amberStars?: number;
  cyanStars?: number;
  vosfor?: number;
  visible?: boolean;
  createdAt?: string;
  updatedAt?: string;
  itemId?: string;
  user?: unknown;
}

type PersistedOrder = Omit<MarketOrder, "user" | "visible">;

interface MarketItem {
  id?: string;
  slug?: string;
  tags?: string[];
  vaulted?: boolean;
  maxRank?: number;
  subtypes?: string[];
  i18n?: {
    en?: {
      name?: string;
    };
  };
}

interface TopOrdersDataGrouped {
  buy?: MarketOrder[];
  sell?: MarketOrder[];
}

interface SnapshotItem {
  itemId: string | null;
  slug: string | null;
  itemName: string | null;
  tags?: string[];
  vaulted?: boolean | null;
  maxRank?: number | null;
  subtypes?: string[];
  topOrders?: {
    buy: PersistedOrder[];
    sell: PersistedOrder[];
  };
  error?: string;
}

interface Snapshot {
  generatedAt: string;
  source: {
    apiBase: string;
    apiVersion: string | null;
  };
  constraints: {
    maxRequestsPerSecond: number;
  };
  totals: {
    items: number;
    success: number;
    failed: number;
  };
  items: SnapshotItem[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(REPO_ROOT, OUTPUT_RELATIVE_PATH);

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const now = Date.now();
  const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (now - lastRequestAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const response = await fetch(url, options);
  lastRequestAt = Date.now();
  return response;
}

async function fetchApi<T>(endpoint: string, retries = 3): Promise<ApiResponse<T>> {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  let attempt = 0;

  while (attempt <= retries) {
    attempt += 1;

    const response = await rateLimitedFetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "wfmarket-prices-bot/1.0"
      }
    });

    if (response.status === 429 && attempt <= retries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2000 * attempt, 10000);
      await sleep(backoff);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Request failed (${response.status}) for ${url}: ${body.slice(0, 500)}`);
    }

    const payload = await response.json() as ApiResponse<T>;
    if (!payload || typeof payload !== "object" || !("data" in payload) || !("error" in payload)) {
      throw new Error(`Unexpected API response shape for ${url}`);
    }

    if (payload.error) {
      throw new Error(`API error for ${url}: ${JSON.stringify(payload.error)}`);
    }

    return payload;
  }

  throw new Error(`Failed request after retries for ${url}`);
}

function stripOrderFields(order: MarketOrder): PersistedOrder {
  const { user: _user, visible: _visible, ...persisted } = order;
  return persisted;
}

function topFiveOrders(orderData: TopOrdersDataGrouped | MarketOrder[] | null): { buy: PersistedOrder[]; sell: PersistedOrder[] } {
  // v2 may return either a flat order list or grouped buy/sell arrays.
  if (orderData && typeof orderData === "object" && !Array.isArray(orderData)) {
    const groupedBuy = Array.isArray(orderData.buy) ? orderData.buy.slice(0, 5).map(stripOrderFields) : null;
    const groupedSell = Array.isArray(orderData.sell) ? orderData.sell.slice(0, 5).map(stripOrderFields) : null;

    if (groupedBuy || groupedSell) {
      return {
        buy: groupedBuy ?? [],
        sell: groupedSell ?? []
      };
    }
  }

  const orders = Array.isArray(orderData) ? orderData : [];

  const buy = orders
    .filter((order) => order.type === "buy")
    .sort((a, b) => (b.platinum ?? 0) - (a.platinum ?? 0))
    .slice(0, 5)
    .map(stripOrderFields);

  const sell = orders
    .filter((order) => order.type === "sell")
    .sort((a, b) => (a.platinum ?? Number.MAX_SAFE_INTEGER) - (b.platinum ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 5)
    .map(stripOrderFields);

  return { buy, sell };
}

async function readPreviousData(filePath: string): Promise<Snapshot | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as Snapshot;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("Fetching item list...");
  const itemsPayload = await fetchApi<MarketItem[]>("/items");
  const items = Array.isArray(itemsPayload.data) ? itemsPayload.data : [];
  console.log(`Fetched ${items.length} items.`);

  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    source: {
      apiBase: API_BASE,
      apiVersion: itemsPayload.apiVersion ?? null
    },
    constraints: {
      maxRequestsPerSecond: REQUESTS_PER_SECOND
    },
    totals: {
      items: items.length,
      success: 0,
      failed: 0
    },
    items: []
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const slug = item?.slug;

    if (!slug) {
      snapshot.totals.failed += 1;
      snapshot.items.push({
        itemId: item?.id ?? null,
        slug: null,
        itemName: item?.i18n?.en?.name ?? null,
        error: "Missing slug"
      });
      continue;
    }

    try {
      const topOrdersPayload = await fetchApi<TopOrdersDataGrouped | MarketOrder[]>(`/orders/item/${slug}/top`);
      const { buy, sell } = topFiveOrders(topOrdersPayload.data);

      snapshot.totals.success += 1;
      snapshot.items.push({
        itemId: item.id ?? null,
        slug,
        itemName: item?.i18n?.en?.name ?? null,
        tags: Array.isArray(item?.tags) ? item.tags : [],
        vaulted: item?.vaulted ?? null,
        maxRank: item?.maxRank ?? null,
        subtypes: Array.isArray(item?.subtypes) ? item.subtypes : [],
        topOrders: { buy, sell }
      });
    } catch (error) {
      snapshot.totals.failed += 1;
      snapshot.items.push({
        itemId: item.id ?? null,
        slug,
        itemName: item?.i18n?.en?.name ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if ((index + 1) % 50 === 0 || index + 1 === items.length) {
      console.log(`Processed ${index + 1}/${items.length} items...`);
    }
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

  const previous = await readPreviousData(OUTPUT_PATH);
  const nextJson = `${JSON.stringify(snapshot, null, 2)}\n`;

  await writeFile(OUTPUT_PATH, nextJson, "utf8");

  const changed = JSON.stringify(previous) !== JSON.stringify(snapshot);
  console.log(`Saved snapshot to ${OUTPUT_RELATIVE_PATH}`);
  console.log(`Successful: ${snapshot.totals.success}, Failed: ${snapshot.totals.failed}`);
  console.log(`Data changed: ${changed}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
