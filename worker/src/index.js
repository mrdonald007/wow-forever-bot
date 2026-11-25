// Auction House — WoW Forever EU auction house prices, running on a free Cloudflare Worker. Works in any number of servers.
//  - /price <item>  : latest auction house prices (data prepared hourly by GitHub Actions)   [everyone]
//  - /sticky set    : write the sticky message for this channel (opens a text box)          [admins]
//  - /sticky remove : turn this channel's sticky message off                                [admins]
//  - every minute   : keeps each channel's sticky message at the bottom
//
// Per-channel stickies live in KV: "stickies" = { channelId: { guildId, text } }.

import HOUSE_LABELS from "./house-labels.json";

const API = "https://eu.api.blizzard.com";
const SHARDS = 16; // must match scripts/build-prices.mjs

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("WoW Forever bot is running.");

    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const body = await request.text();
    if (!signature || !timestamp || !(await verifyDiscord(env.DISCORD_PUBLIC_KEY, signature, timestamp + body))) {
      return new Response("Bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);
    if (interaction.type === 1) return json({ type: 1 }); // Discord's PING

    if (interaction.type === 4) {
      try {
        return json(await handleAutocomplete(interaction, env));
      } catch {
        return json({ type: 8, data: { choices: [] } });
      }
    }

    if (interaction.type === 5) {
      try {
        return json(await handleModal(interaction, env, ctx));
      } catch (e) {
        return json(reply(`Something went wrong: ${e.message}`, true));
      }
    }

    if (interaction.type === 2) {
      try {
        return json(await handleCommand(interaction, env, ctx));
      } catch (e) {
        return json(reply(`Something went wrong: ${e.message}`, true));
      }
    }

    return new Response("Unknown interaction", { status: 400 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAllStickies(env).catch((e) => console.log(`Sticky: ${e.message}`)));
  },
};

// ---------- Discord plumbing ----------

const json = (obj) => new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });

function reply(content, ephemeral = false, embeds) {
  return { type: 4, data: { content, embeds, flags: ephemeral ? 64 : 0 } };
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function verifyDiscord(publicKey, signature, message) {
  const data = new TextEncoder().encode(message);
  const algorithms = [{ name: "Ed25519" }, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }];
  for (const alg of algorithms) {
    try {
      const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), alg, false, ["verify"]);
      return await crypto.subtle.verify(alg.name, key, hexToBytes(signature), data);
    } catch {
      // runtime doesn't know this algorithm name; try the next one
    }
  }
  return false;
}

async function handleCommand(interaction, env, ctx) {
  const options = Object.fromEntries((interaction.data.options || []).map((o) => [o.name, o.value]));
  switch (interaction.data.name) {
    case "price":
      return priceCommand(options, env);
    case "sticky":
      return stickyCommand(interaction, env, ctx);
    default:
      return reply("Unknown command.", true);
  }
}

// ---------- Item names / search ----------

async function loadNames(env) {
  return (await env.KV.get("names", { type: "json", cacheTtl: 300 })) || [];
}

function findItems(names, query, limit = 25) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = [], starts = [], wordStarts = [], contains = [];
  for (const entry of names) {
    const [id, name] = entry;
    const lower = name.toLowerCase();
    if (lower === q || String(id) === q) exact.push(entry);
    else if (lower.startsWith(q)) starts.push(entry);
    else if (lower.includes(` ${q}`)) wordStarts.push(entry);
    else if (lower.includes(q)) contains.push(entry);
  }
  return [...exact, ...starts, ...wordStarts, ...contains].slice(0, limit);
}

async function handleAutocomplete(interaction, env) {
  const focused = (interaction.data.options || []).find((o) => o.focused);
  const names = await loadNames(env);
  const choices = findItems(names, String(focused?.value ?? "")).map(([id, name]) => ({
    name: name.slice(0, 100),
    value: String(id),
  }));
  return { type: 8, data: { choices } };
}

// ---------- /price ----------

function gold(copper, coins) {
  const c = Math.round(copper);
  const g = Math.floor(c / 10000);
  const s = Math.floor((c % 10000) / 100);
  const cc = c % 100;
  const mark = { g: coins?.gold ?? "g", s: coins?.silver ?? "s", c: coins?.copper ?? "c" };
  const parts = [];
  if (g) parts.push(`${g.toLocaleString("en-GB")}${mark.g}`);
  if (s) parts.push(`${s}${mark.s}`);
  if (cc || parts.length === 0) parts.push(`${cc}${mark.c}`);
  return parts.join(" ");
}

async function priceCommand(options, env) {
  const input = String(options.item ?? "").trim();
  const names = await loadNames(env);

  let id, name;
  if (/^\d+$/.test(input)) {
    id = Number(input);
    name = names.find(([x]) => x === id)?.[1] ?? `Item ${id}`;
  } else {
    const match = findItems(names, input, 1)[0];
    if (!match) return reply(`Nothing listed right now matches **${input}**. Try the item ID instead.`, true);
    [id, name] = match;
  }

  const [shard, meta, coins] = await Promise.all([
    env.KV.get(`p:${id % SHARDS}`, { type: "json", cacheTtl: 300 }),
    env.KV.get("meta", { type: "json", cacheTtl: 300 }),
    env.KV.get("emojis", { type: "json", cacheTtl: 3600 }),
  ]);
  const money = (copper) => gold(copper, coins);
  if (!meta) return reply("No price data yet. Run the **Update auction prices** workflow on GitHub first.", true);

  const entry = shard?.[id];
  if (!entry) return reply(`**${name}** has no buyout listings in the latest scan.`);

  const labelled = Object.keys(HOUSE_LABELS).length > 0;
  const faction = options.faction;
  const rows = Object.entries(entry)
    .map(([houseId, [min, market, units, listings]]) => {
      const houseName = meta.houses?.[houseId] ?? "Auction House";
      const side = factionOf(houseName);
      return { houseId, side, label: HOUSE_LABELS[houseId] ?? `${capitalise(side)} #${houseId}`, min, market, units, listings };
    })
    .filter((r) => !labelled || HOUSE_LABELS[r.houseId])
    .filter((r) => !faction || r.side === faction)
    .sort((a, b) =>
      labelled
        ? a.label.localeCompare(b.label)
        : FACTION_ORDER.indexOf(a.side) - FACTION_ORDER.indexOf(b.side) || a.min - b.min
    );

  if (!rows.length) return reply(`**${name}** has no matching listings in the latest scan.`);

  const info = await withTimeout(itemInfo(env, id).catch(() => null), 1500);
  const cheapest = rows.reduce((best, r) => (r.min < best.min ? r : best));

  let fields;
  if (labelled) {
    // Your own houses, two per row, sorted by label.
    fields = [];
    rows.forEach((r, i) => {
      fields.push({
        name: `${FACTION_ICON[r.side]} ${r.label}`,
        value: `**${money(r.min)}**\navg price ${money(r.market)}\n${count(r.units)} listed`,
        inline: true,
      });
      if (i % 2 === 1) fields.push({ name: "​", value: "​", inline: true }); // spacer keeps 2 per row
    });
  } else {
    // Not labelled yet: one compact block per faction.
    const groups = {};
    for (const r of rows) (groups[r.side] ??= []).push(r);
    fields = Object.entries(groups).map(([side, list]) => ({
      name: `${FACTION_ICON[side]} ${capitalise(side)}`,
      value: list.map((r) => `\`#${r.houseId}\` **${money(r.min)}** · ${count(r.units)} listed`).join("\n").slice(0, 1024),
      inline: false,
    }));
  }

  return {
    type: 4,
    data: {
      embeds: [
        {
          author: { name, icon_url: info?.icon },
          color: QUALITY_COLORS[info?.quality] ?? 0xf2b84b,
          description: `Cheapest: **${money(cheapest.min)}** · ${cheapest.label}`,
          fields: fields.slice(0, 25),
          footer: { text: `Bold = lowest price · avg price = average of the cheapest 15% · item ${id} · scanned` },
          timestamp: new Date(meta.updated).toISOString(),
        },
      ],
    },
  };
}

const QUALITY_COLORS = {
  POOR: 0x9d9d9d, COMMON: 0xffffff, UNCOMMON: 0x1eff00, RARE: 0x0070dd,
  EPIC: 0xa335ee, LEGENDARY: 0xff8000, ARTIFACT: 0xe6cc80, HEIRLOOM: 0x00ccff,
};
const FACTION_ORDER = ["alliance", "horde", "blackwater", "other"];
const FACTION_ICON = { alliance: "🔵", horde: "🔴", blackwater: "🏴‍☠️", other: "🏛️" };

function factionOf(houseName) {
  const n = houseName.toLowerCase();
  return n.includes("alliance") ? "alliance" : n.includes("horde") ? "horde" : n.includes("blackwater") ? "blackwater" : "other";
}
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n) => n.toLocaleString("en-GB");
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);

// Item quality and icon from Blizzard (Forever data first, Classic Era as fallback).
async function itemInfo(env, id) {
  const token = await blizzardToken(env);
  const get = (path, ns) =>
    fetch(`${API}${path}?namespace=${ns}&locale=en_GB`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  for (const ns of ["static-forever-eu", "static-classic1x-eu"]) {
    const [item, media] = await Promise.all([get(`/data/wow/item/${id}`, ns), get(`/data/wow/media/item/${id}`, ns)]);
    if (!item && !media) continue;
    return { quality: item?.quality?.type, icon: media?.assets?.find((a) => a.key === "icon")?.value };
  }
  return null;
}

// ---------- Blizzard API ----------

async function blizzardToken(env) {
  const cached = await env.KV.get("token", { type: "json" });
  if (cached && cached.expires > Date.now() + 120_000) return cached.token;

  const res = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.BLIZZ_ID}:${env.BLIZZ_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Blizzard login failed (${res.status})`);
  const data = await res.json();
  await env.KV.put("token", JSON.stringify({ token: data.access_token, expires: Date.now() + data.expires_in * 1000 }), {
    expirationTtl: Math.max(60, data.expires_in),
  });
  return data.access_token;
}

// ---------- Sticky messages (one per channel, any number of servers) ----------
// KV "stickies" = { channelId: { guildId, text } }. Every minute the bot looks at each channel's latest messages;
// if its sticky isn't the newest one (or the text changed), it deletes the old copy and posts it again.

const DISCORD = "https://discord.com/api/v10";
const STICKY_COLOR = 0xf2b84b;
let botUserId; // cached per worker instance

function discordRaw(env, method, path, body) {
  return fetch(`${DISCORD}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/mrdonald007/wow-forever-bot, 1.1)",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function discord(env, method, path, body) {
  const res = await discordRaw(env, method, path, body);
  if (!res.ok && res.status !== 404) throw new Error(`Discord ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 404 ? null : res.json();
}

async function myId(env) {
  botUserId ??= (await discord(env, "GET", "/users/@me")).id;
  return botUserId;
}

// A sticky is a plain message from the bot itself (not a /price reply), in the sticky colour.
const isSticky = (m, me) =>
  m.author?.id === me && !m.webhook_id && !m.interaction_metadata && !m.interaction && !m.embeds?.[0]?.title &&
  m.embeds?.[0]?.color === STICKY_COLOR;

async function loadStickies(env, cacheTtl) {
  const stickies = await env.KV.get("stickies", { type: "json", cacheTtl });
  if (stickies) return stickies;

  // One-time move from the old single-sticky format.
  const old = await env.KV.get("sticky", { type: "json" });
  if (!old?.channelId) return {};
  const migrated = { [old.channelId]: { guildId: old.guildId ?? null, text: old.text } };
  await env.KV.put("stickies", JSON.stringify(migrated));
  await env.KV.delete("sticky");
  return migrated;
}

async function clearSticky(env, channelId) {
  const me = await myId(env);
  const messages = (await discord(env, "GET", `/channels/${channelId}/messages?limit=25`)) ?? [];
  for (const m of messages.filter((m) => isSticky(m, me))) {
    await discord(env, "DELETE", `/channels/${channelId}/messages/${m.id}`);
  }
}

async function refreshSticky(env, channelId, text, force = false) {
  const me = await myId(env);
  const messages = await discord(env, "GET", `/channels/${channelId}/messages?limit=25`);
  if (messages === null) return "gone"; // channel deleted or bot removed
  const mine = messages.filter((m) => isSticky(m, me));
  const newest = messages[0];
  const upToDate = newest && isSticky(newest, me) && mine.length === 1 && newest.embeds?.[0]?.description === text;
  if (upToDate && !force) return;

  for (const m of mine) await discord(env, "DELETE", `/channels/${channelId}/messages/${m.id}`);
  await discord(env, "POST", `/channels/${channelId}/messages`, {
    embeds: [{ description: text, color: STICKY_COLOR }],
    allowed_mentions: { parse: [] },
  });
}

async function refreshAllStickies(env) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const stickies = await loadStickies(env, 60);
  let changed = false;
  for (const [channelId, { text }] of Object.entries(stickies)) {
    try {
      if ((await refreshSticky(env, channelId, text)) === "gone") {
        delete stickies[channelId];
        changed = true;
      }
    } catch (e) {
      console.log(`Sticky ${channelId}: ${e.message}`); // e.g. missing permissions; keep trying next minute
    }
  }
  if (changed) await env.KV.put("stickies", JSON.stringify(stickies));
}

async function stickyCommand(interaction, env, ctx) {
  const sub = interaction.data.options?.[0]?.name;
  const channelId = interaction.channel_id;

  if (sub === "set") {
    const stickies = await loadStickies(env);
    return {
      type: 9, // open a text box (modal)
      data: {
        custom_id: "sticky_modal",
        title: "Sticky message for this channel",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "text",
                label: "Message (markdown works)",
                style: 2,
                max_length: 4000,
                required: true,
                value: stickies[channelId]?.text,
                placeholder: "How to use the bot: type /price and start typing an item name…",
              },
            ],
          },
        ],
      },
    };
  }

  if (sub === "remove") {
    const stickies = await loadStickies(env);
    if (!stickies[channelId]) return reply("This channel has no sticky message.", true);
    delete stickies[channelId];
    await env.KV.put("stickies", JSON.stringify(stickies));
    ctx.waitUntil(clearSticky(env, channelId).catch((e) => console.log(e.message)));
    return reply("Sticky message removed from this channel.", true);
  }

  return reply("Use `/sticky set` or `/sticky remove`.", true);
}

async function handleModal(interaction, env, ctx) {
  if (interaction.data.custom_id !== "sticky_modal") return reply("Unknown form.", true);
  const text = interaction.data.components?.[0]?.components?.[0]?.value?.trim();
  if (!text) return reply("The message was empty, nothing saved.", true);

  const channelId = interaction.channel_id;
  const stickies = await loadStickies(env);
  stickies[channelId] = { guildId: interaction.guild_id ?? null, text };
  await env.KV.put("stickies", JSON.stringify(stickies));

  ctx.waitUntil(refreshSticky(env, channelId, text, true).catch((e) => console.log(`Sticky: ${e.message}`)));
  return reply("📌 Sticky saved. It's posted now and will stay at the bottom of this channel.", true);
}
