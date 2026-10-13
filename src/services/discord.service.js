import "dotenv/config";

let missingWebhookWarningShown = false;

export function formatDiscordMessage(message, now = Date.now()) {
  const lines = String(message).split(/\r?\n/);
  const title = (lines.shift() || "Algo update").replace(/^\*\*(.*)\*\*$/, "$1").trim();
  const details = lines
    .flatMap(line => line.split(/\s+\|\s+/))
    .map(line => line.trim())
    .filter(Boolean);
  const detailText = details.length
    ? details.map(line => `• ${line}`).join("\n")
    : "• No additional details.";
  const localTime = `<t:${Math.floor(now / 1000)}:t>`;

  return `**${title}**\n━━━━━━━━━━━━━━━━━━\n${detailText}\n\n_${localTime}_`;
}

export async function sendDiscord(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    if (!missingWebhookWarningShown) {
      console.warn("[discord] Notifications disabled; configure DISCORD_WEBHOOK_URL to enable them.");
      missingWebhookWarningShown = true;
    }
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: formatDiscordMessage(message).slice(0, 2000) })
    });
    if (!response.ok) {
      console.error(`[discord] Webhook request failed with HTTP ${response.status}.`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[discord] Could not deliver notification:", error.message);
    return false;
  }
}