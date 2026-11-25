// Logs the bot in to Discord's gateway for a few seconds, then disconnects.
// The bot normally never "logs in" (it only answers commands), so Discord can keep showing an old
// name or picture in member lists. Logging in once makes Discord refresh the bot's profile everywhere.
// Run from the "Refresh bot profile" workflow on GitHub after changing the bot's picture or name.

const { DISCORD_BOT_TOKEN } = process.env;
if (!DISCORD_BOT_TOKEN) throw new Error("Missing DISCORD_BOT_TOKEN secret");

const STAY_ONLINE_MS = 10_000;

const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
let heartbeat, seq = null, done = false;

const finish = (code, message) => {
  if (done) return;
  done = true;
  clearInterval(heartbeat);
  console.log(message);
  try { ws.close(1000); } catch {}
  setTimeout(() => process.exit(code), 500);
};

setTimeout(() => finish(1, "Timed out waiting for Discord."), 30_000);

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.s != null) seq = msg.s;

  if (msg.op === 10) {
    // Hello: start heartbeats, then identify (no intents needed).
    heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), msg.d.heartbeat_interval);
    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: DISCORD_BOT_TOKEN,
        intents: 0,
        properties: { os: "linux", browser: "wow-forever-bot", device: "wow-forever-bot" },
      },
    }));
  } else if (msg.op === 0 && msg.t === "READY") {
    const u = msg.d.user;
    console.log(`Logged in as ${u.username} (avatar ${u.avatar}) in ${msg.d.guilds.length} server(s).`);
    setTimeout(() => finish(0, "Done. Discord now has the bot's current profile."), STAY_ONLINE_MS);
  } else if (msg.op === 9) {
    finish(1, "Discord rejected the login (invalid session).");
  }
});

ws.addEventListener("close", (event) => {
  if (!done) finish(1, `Discord closed the connection: ${event.code} ${event.reason}`);
});
