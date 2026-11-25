// Downloads every WoW Forever EU auction house, boils it down to one price row per item per house,
// and stores the result in Cloudflare KV for the Worker's /price command.
// Runs hourly in GitHub Actions (see .github/workflows/prices.yml).

const { BLIZZ_ID, BLIZZ_SECRET, CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_ID } = process.env;

const REGION = "eu";
const API = `https://${REGION}.api.blizzard.com`;
const LOCALE = "en_GB";
const DYNAMIC = `dynamic-forever-${REGION}`;
const STATIC = `static-forever-${REGION}`;
const STATIC_CLASSIC = `static-classic1x-${REGION}`; // fallback for item names Forever's API doesn't return
const SHARDS = 16; // must match worker/src/index.js
// Auctions are the same whichever ruleset you ask through (for now), so one index is enough.
const RULESET_FOR_INDEX = 2;
const KV = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_ID}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TOKEN;

async function login() {
  const res = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${BLIZZ_ID}:${BLIZZ_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Blizzard login failed: ${res.status} ${await res.text()}`);
  TOKEN = (await res.json()).access_token;
}

async function blizzard(path, namespace, { allow404 = false } = {}) {
  const url = `${API}${path}${path.includes("?") ? "&" : "?"}namespace=${namespace}&locale=${LOCALE}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.ok) return res.json();
    if (res.status === 404 && allow404) return null;
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * attempt);
      continue;
    }
    throw new Error(`${res.status} from ${url}`);
  }
  throw new Error(`Gave up after retries: ${url}`);
}

async function kvGet(key) {
  const res = await fetch(`${KV}/values/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read ${key} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function kvPutMany(pairs) {
  const res = await fetch(`${KV}/bulk`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(pairs.map(([key, value]) => ({ key, value: JSON.stringify(value) }))),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(`KV write failed: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
}

async function inParallel(items, workers, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

const textOf = (v) => (typeof v === "string" ? v : v?.[LOCALE] ?? v?.en_US ?? "");

// Lowest unit price, market price (average of the cheapest 15% of units), units listed, listings.
export function summarize(listings) {
  listings.sort((a, b) => a[0] - b[0]);
  const units = listings.reduce((sum, [, q]) => sum + q, 0);
  const target = Math.max(1, Math.ceil(units * 0.15));
  let taken = 0, cost = 0;
  for (const [unit, qty] of listings) {
    const take = Math.min(qty, target - taken);
    cost += unit * take;
    taken += take;
    if (taken >= target) break;
  }
  return [Math.round(listings[0][0]), Math.round(cost / taken), units, listings.length];
}

async function main() {
  for (const [k, v] of Object.entries({ BLIZZ_ID, BLIZZ_SECRET, CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_ID })) {
    if (!v) throw new Error(`Missing GitHub secret: ${k}`);
  }
  await login();

  const index = await blizzard(`/data/wow/ruleset/${RULESET_FOR_INDEX}/auctions/`, DYNAMIC);
  const houses = index.auctions ?? [];
  if (!houses.length) throw new Error("Blizzard returned no auction houses");

  const items = new Map(); // itemId -> Map(houseId -> [[unitPrice, qty], ...])
  const houseNames = {};
  const add = (itemId, houseId, unit, qty) => {
    if (!items.has(itemId)) items.set(itemId, new Map());
    const byHouse = items.get(itemId);
    if (!byHouse.has(houseId)) byHouse.set(houseId, []);
    byHouse.get(houseId).push([unit, qty]);
  };

  for (const house of houses) {
    houseNames[house.id] = textOf(house.name) || "Auction House";
    let count = 0;

    const data = await blizzard(`/data/wow/ruleset/${RULESET_FOR_INDEX}/auctions/${house.id}`, DYNAMIC, { allow404: true });
    for (const a of data?.auctions ?? []) {
      if (!a.buyout || !a.item?.id) continue; // skip bid-only auctions
      const qty = a.quantity || 1;
      add(a.item.id, house.id, a.buyout / qty, qty);
      count++;
    }

    const commodities = await blizzard(`/data/wow/ruleset/${RULESET_FOR_INDEX}/auctions/${house.id}/commodities`, DYNAMIC, {
      allow404: true,
    });
    for (const a of commodities?.auctions ?? []) {
      if (!a.unit_price || !a.item?.id) continue;
      add(a.item.id, house.id, a.unit_price, a.quantity || 1);
      count++;
    }

    console.log(`House ${house.id} (${houseNames[house.id]}): ${count} buyout listings`);
  }
  console.log(`${items.size} distinct items listed`);

  // Price shards
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (const [itemId, byHouse] of items) {
    const row = {};
    for (const [houseId, listings] of byHouse) row[houseId] = summarize(listings);
    shards[itemId % SHARDS][itemId] = row;
  }

  // Item names (cached in KV so we only look up new items)
  const nameCache = (await kvGet("namecache")) ?? {};
  const before = Object.keys(nameCache).length;
  const unknown = [...items.keys()].filter((id) => !nameCache[id]);
  await inParallel(unknown, 8, async (id) => {
    const item =
      (await blizzard(`/data/wow/item/${id}`, STATIC, { allow404: true }).catch(() => null)) ??
      (await blizzard(`/data/wow/item/${id}`, STATIC_CLASSIC, { allow404: true }).catch(() => null));
    const name = textOf(item?.name);
    if (name) nameCache[id] = name;
  });
  const added = Object.keys(nameCache).length - before;
  console.log(`Looked up ${unknown.length} new item names, found ${added}`);

  const names = [...items.keys()]
    .filter((id) => nameCache[id])
    .map((id) => [id, nameCache[id]])
    .sort((a, b) => a[1].localeCompare(b[1]));

  const writes = shards.map((shard, i) => [`p:${i}`, shard]);
  writes.push(["names", names], ["meta", { updated: Date.now(), houses: houseNames }]);
  if (added > 0) writes.push(["namecache", nameCache]);
  await kvPutMany(writes);
  console.log(`Saved ${writes.length} keys to Cloudflare KV`);
}

if (process.argv[1]?.endsWith("build-prices.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
