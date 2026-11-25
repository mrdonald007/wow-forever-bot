# Changelog

## v1.2.1 (2026-11-25)
- New **Refresh bot profile** workflow: logs the bot in for a few seconds so member lists show its current picture and name.

## v1.2 (2026-11-25)
- The bot is now auction house only: removed the faction lock checker, `/alerts`, `/rulesets` and the alert webhook (it never posted a real alert).

## v1.1 (2026-11-25)
- Works in multiple Discord servers: commands are registered globally.
- New `/alerts set #channel`, `/alerts off`, `/alerts status`: each server picks its own faction lock alert channel.
- `/sticky` is now per channel instead of one sticky for the whole bot.

## v1.0
- `/price` with autocomplete, hourly auction house scan for EU Normal and PvP.
- Faction lock alerts via webhook, `/rulesets`, `/sticky`.
