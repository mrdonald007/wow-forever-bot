// Registers the bot's slash commands with Discord. Run from the "Register Discord commands" workflow
// on GitHub (again whenever the commands change).
//
// Commands are registered GLOBALLY, so they work in every server the bot is invited to. If the
// DISCORD_GUILD_ID secret is set, the old server-only copies are cleared there so they don't show up twice.
//
// /price is for everyone. /sticky needs the "Manage Server" permission, so regular members
// don't even see them. Server admins can fine-tune this in Server Settings → Integrations → Auction House.

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) throw new Error("Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN secret");

const MANAGE_SERVER = "32";
const SERVERS_ONLY = { contexts: [0], integration_types: [0] }; // usable in servers, not in DMs

const commands = [
  {
    name: "price",
    description: "Auction house price for an item (WoW Forever EU)",
    ...SERVERS_ONLY,
    options: [
      { type: 3, name: "item", description: "Item name or ID", required: true, autocomplete: true },
      {
        type: 3,
        name: "faction",
        description: "Only show one faction's auction houses",
        required: false,
        choices: [
          { name: "Alliance", value: "alliance" },
          { name: "Horde", value: "horde" },
          { name: "Blackwater (neutral)", value: "blackwater" },
        ],
      },
    ],
  },
  {
    name: "sticky",
    description: "Manage the sticky message that always stays at the bottom of this channel",
    default_member_permissions: MANAGE_SERVER,
    ...SERVERS_ONLY,
    options: [
      { type: 1, name: "set", description: "Write or edit the sticky message for this channel" },
      { type: 1, name: "remove", description: "Turn the sticky message off in this channel" },
    ],
  },
];

async function put(url, body) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord said ${res.status}: ${await res.text()}`);
}

const base = `https://discord.com/api/v10/applications/${DISCORD_APP_ID}`;
await put(`${base}/commands`, commands);
console.log(`Registered ${commands.length} commands globally.`);

if (DISCORD_GUILD_ID) {
  await put(`${base}/guilds/${DISCORD_GUILD_ID}/commands`, []);
  console.log("Cleared the old server-only commands so they don't appear twice.");
}
