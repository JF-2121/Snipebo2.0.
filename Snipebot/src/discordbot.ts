import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  TextChannel,
  Events,
  ActivityType,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from "discord.js";
import cron from "node-cron";
import axios from "axios";
import { searchAllPlatforms } from "./scrapers/registry.js";
import { ScrapedItem } from "./scrapers/types.js";
import { CATEGORIES, ALL_CATEGORY_KEYS } from "./config/categories.js";
import { logger } from "./lib/logger.js";
import {
  findCheaperAlternatives as findCheaperVinted,
  type VintedItem,
} from "./vinted-scraper.js";

interface DealItem extends ScrapedItem {
  currency: string;
  condition: string;
  seller: string;
  location: string;
  url: string;
}

const FALLBACK_CHANNEL_ID = "1483482170583678976";
const DEFAULT_BRANDS = ["Nike", "Adidas", "Lacoste", "Ralph Lauren", "Carhartt"];

const itemCache = new Map<string, DealItem>();
const MAX_CACHE_SIZE = 2000;

function cacheItem(item: DealItem) {
  itemCache.set(item.id, item);
  if (itemCache.size > MAX_CACHE_SIZE) {
    const firstKey = itemCache.keys().next().value;
    if (firstKey) itemCache.delete(firstKey);
  }
}

const WHOP_API_KEY = process.env["WHOP_API_KEY"];
const WHOP_PRODUCT_ID = process.env["WHOP_PRODUCT_ID"];
const licenseCache = new Map<string, { valid: boolean; expiry: number }>();

async function isGuildLicensed(guildId: string): Promise<boolean> {
  if (!WHOP_API_KEY || !WHOP_PRODUCT_ID) return true;
  const cached = licenseCache.get(guildId);
  if (cached && Date.now() < cached.expiry) return cached.valid;
  try {
    const res = await axios.get("https://api.whop.com/api/v2/memberships", {
      headers: { Authorization: `Bearer ${WHOP_API_KEY}` },
      params: { product_id: WHOP_PRODUCT_ID, metadata_discord_guild_id: guildId, valid: true },
      timeout: 8000,
    });
    const valid = (res.data?.data?.length ?? 0) > 0;
    licenseCache.set(guildId, { valid, expiry: Date.now() + 10 * 60 * 1000 });
    return valid;
  } catch (err) {
    logger.error("Whop Lizenz-Check fehlgeschlagen für Guild " + guildId + ": " + String(err));
    return false;
  }
}

type Gender = "herren" | "damen" | "beide";

const CATEGORY_CHOICES = [
  { name: "Shirts & Polos", value: "shirts" },
  { name: "Hosen & Jeans", value: "pants" },
  { name: "Schuhe", value: "shoes" },
  { name: "Accessoires", value: "accessories" },
];

interface WatchConfig {
  brands: string[];
  maxPrice: number | undefined;
  active: boolean;
  categoryKey: string;
  gender: Gender;
}

const watchConfig: WatchConfig = {
  brands: [...DEFAULT_BRANDS],
  maxPrice: undefined,
  active: true,
  categoryKey: "accessories",
  gender: "beide",
};

const seenItemIds = new Set<string>();
let rateLimitedUntil = 0;
let consecutiveRateLimits = 0;

function genderLabel(g: Gender): string {
  if (g === "herren") return "Herren";
  if (g === "damen") return "Damen";
  return "Herren & Damen";
}

async function findChannelByName(client: Client, channelName: string): Promise<TextChannel | null> {
  for (const [, guild] of client.guilds.cache) {
    const ch = guild.channels.cache.find((c) => c.name === channelName && c instanceof TextChannel) as TextChannel | undefined;
    if (ch) return ch;
  }
  return null;
}

async function getFallbackChannel(client: Client): Promise<TextChannel | null> {
  try {
    const ch = await client.channels.fetch(FALLBACK_CHANNEL_ID);
    if (ch instanceof TextChannel) return ch;
  } catch { /* ignorieren */ }
  return null;
}

function runFakeCheck(item: DealItem): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const warnings: string[] = [];
  const positives: string[] = [];
  let riskScore = 0;

  const knownExpensiveBrands = ["ralph lauren", "lacoste", "carhartt"];
  const isExpensiveBrand = knownExpensiveBrands.some((b) => item.brand.toLowerCase().includes(b));

  if (item.price < 3) { warnings.push("💸 Preis extrem niedrig (unter 3€)"); riskScore += 35; }
  else if (item.price < 8 && isExpensiveBrand) { warnings.push("💸 Preis sehr niedrig für diese Marke"); riskScore += 20; }
  else if (item.price < 5) { warnings.push("💸 Preis sehr niedrig"); riskScore += 15; }
  else { positives.push("💰 Preis im normalen Bereich"); }

  if (!item.condition || item.condition === "—") { warnings.push("❓ Kein Zustand angegeben"); riskScore += 10; }
  else if (item.condition.toLowerCase().includes("neu")) { positives.push("✨ Als 'Neu' eingestuft"); }
  else { positives.push(`✨ Zustand: ${item.condition}`); }

  if (!item.size || item.size === "—") { warnings.push("📐 Keine Größenangabe"); riskScore += 10; }
  else { positives.push(`📐 Größe angegeben: ${item.size}`); }

  if (item.brand && !item.title.toLowerCase().includes(item.brand.toLowerCase())) {
    warnings.push("🏷️ Markenname nicht im Titel"); riskScore += 15;
  } else if (item.brand) {
    positives.push("🏷️ Markenname im Titel bestätigt");
  }

  if (!item.seller || item.seller === "—") { warnings.push("👤 Kein Verkäufername"); riskScore += 10; }
  else { positives.push(`👤 Verkäufer: ${item.seller}`); }

  let verdict: string;
  let color: number;
  if (riskScore >= 45) { verdict = "🔴 HOHES RISIKO — Vorsicht!"; color = 0xff0000; }
  else if (riskScore >= 20) { verdict = "🟡 MITTLERES RISIKO — Genau prüfen"; color = 0xffa500; }
  else { verdict = "🟢 NIEDRIGES RISIKO — Wirkt legitim"; color = 0x00cc66; }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔍 Fake-Check: ${item.brand || "—"} | ${item.title}`.slice(0, 250))
    .setURL(item.url)
    .setDescription(`**${verdict}**\nRisiko-Score: **${riskScore}/100**`)
    .addFields(
      { name: "💰 Preis", value: `${item.price.toFixed(2)} ${item.currency}`, inline: true },
      { name: "🏷️ Marke", value: item.brand || "—", inline: true },
      { name: "📐 Größe", value: item.size || "—", inline: true },
      { name: "✨ Zustand", value: item.condition || "—", inline: true },
      { name: "👤 Verkäufer", value: item.seller || "—", inline: true },
    )
    .setFooter({ text: "Fake-Check • Snipebot" })
    .setTimestamp();

  if (warnings.length > 0) embed.addFields({ name: "⚠️ Warnzeichen", value: warnings.join("\n") });
  if (positives.length > 0) embed.addFields({ name: "✅ Positive Zeichen", value: positives.join("\n") });
  if (item.imageUrl) embed.setThumbnail(item.imageUrl);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("🔗 Inserat öffnen").setStyle(ButtonStyle.Link).setURL(item.url),
  );

  return { embed, row };
}

function buildDealEmbed(item: DealItem): EmbedBuilder {
  const priceStr = `${item.price.toFixed(2)} ${item.currency}`;
  const platformName = item.platform === "vinted" ? "Vinted" : "Kleinanzeigen";
  
  const embed = new EmbedBuilder()
    .setColor(0x6EB6FF)
    .setTitle(`${item.title}`.slice(0, 250))
    .setURL(item.url)
    .addFields(
      { name: "💰 Preis", value: priceStr, inline: true },
      { name: "🏷️ Marke", value: item.brand || "—", inline: true },
      { name: "📐 Größe", value: item.size || "—", inline: true },
    )
    .setFooter({ text: `${platformName} • Snipebot` })
    .setTimestamp();
  if (item.imageUrl) embed.setImage(item.imageUrl);
  return embed;
}

function buildDealButtons(item: DealItem): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`save_${item.id}`).setLabel("❤️ Merken").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`interested_${item.id}`).setLabel("👍 Interessiert").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`fakecheck_${item.id}`).setLabel("🔍 Fake-Check").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pricecheck_${item.id}`).setLabel("💰 Pricecheck").setStyle(ButtonStyle.Success),
  );
  return [row];
}

async function postDealsForCategory(client: Client, categoryKey: string) {
  const cat = CATEGORIES[categoryKey];
  if (!cat) return;
  
  logger.info(`🔍 Suche in Kategorie: ${cat.label}`);
  await new Promise((r) => setTimeout(r, 500));

  const channel = (await findChannelByName(client, cat.channelName)) ?? (await getFallbackChannel(client));

  if (!channel) {
    logger.warn(`Kanal #${cat.channelName} nicht gefunden.`);
    return;
  }

  for (const brand of watchConfig.brands) {
    try {
      const searchText = cat.keyword ? `${brand} ${cat.keyword}` : brand;
      logger.info(`🔎 Suche: "${searchText}" in #${cat.channelName} (Max: ${watchConfig.maxPrice || 'unbegrenzt'}€)`);
      
      const allItems = await searchAllPlatforms(searchText, {
        maxPrice: watchConfig.maxPrice,
        category: categoryKey,
      });
      
      if (allItems.length > 0) {
        consecutiveRateLimits = 0;
      }
      
      allItems.sort((a, b) => a.price - b.price);
      
      logger.info(`✅ ${allItems.length} items found`);
      const newItems = allItems.filter((i) => !seenItemIds.has(i.id));
      logger.info(`📌 ${newItems.length} neue Items (${allItems.length - newItems.length} bereits gesehen)`);

      for (const item of newItems.slice(0, 3)) {
        seenItemIds.add(item.id);
        const dealItem: DealItem = {
          ...item,
          currency: "EUR",
          condition: "—",
          seller: "—",
          location: "—",
          url: item.link,
        };
        cacheItem(dealItem);
        const embed = buildDealEmbed(dealItem);
        const rows = buildDealButtons(dealItem);
        await channel.send({ embeds: [embed], components: rows });
        logger.info(`📤 Deal gepostet: ${item.platform.toUpperCase()} - ${item.brand} - ${item.price}€`);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      logger.error(`❌ Fehler bei der Dealsuche für Marke ${brand} in ${categoryKey}: ` + String(err));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function postDeals(client: Client) {
  if (!watchConfig.active) return;

  if (Date.now() < rateLimitedUntil) {
    const waitMinutes = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
    logger.warn(`⏸️ Rate-Limit aktiv - warte noch ${waitMinutes} Minuten`);
    return;
  }

  logger.info("🚀 Starte Deal-Suche auf Kleinanzeigen");

  for (const categoryKey of ALL_CATEGORY_KEYS) {
    await postDealsForCategory(client, categoryKey);
  }
  
  logger.info("✅ Deal-Suche abgeschlossen");
}

const commands = [
  new SlashCommandBuilder()
    .setName("deals")
    .setDescription("Deal-Bot Steuerung")
    .addSubcommand((sub) => sub.setName("start").setDescription("Deal-Suche starten"))
    .addSubcommand((sub) => sub.setName("stop").setDescription("Deal-Suche stoppen"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Aktuellen Status anzeigen"))
    .addSubcommand((sub) =>
      sub.setName("marken").setDescription("Marken einstellen (kommagetrennt)")
        .addStringOption((o) => o.setName("liste").setDescription("z.B. Nike,Adidas,Lacoste").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("maxpreis").setDescription("Maximalen Preis in EUR einstellen")
        .addIntegerOption((o) => o.setName("preis").setDescription("z.B. 50 für max. 50 EUR (0 = kein Limit)").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("kategorie").setDescription("Nur eine bestimmte Kategorie suchen")
        .addStringOption((o) => o.setName("typ").setDescription("Kategorie auswählen").setRequired(true).addChoices(...CATEGORY_CHOICES)),
    )
    .addSubcommand((sub) => sub.setName("suche").setDescription("Jetzt sofort nach Deals suchen"))
    .addSubcommand((sub) => sub.setName("reset").setDescription("Cache zurücksetzen (zeigt alte Deals erneut)")),

  new SlashCommandBuilder()
    .setName("lizenz")
    .setDescription("Zeigt den Lizenzstatus dieses Servers"),
];

let botOwnerId: string | null = null;

export async function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) { logger.error("DISCORD_BOT_TOKEN ist nicht gesetzt."); return; }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [2, 3],
  });

  client.once(Events.ClientReady, async (c) => {
    logger.info(`Discord Bot eingeloggt als ${c.user.tag}`);
    c.user.setActivity("🔍 Deal-Suche läuft...", { type: ActivityType.Watching });

    try {
      const app = await c.application.fetch();
      botOwnerId = app.owner && "id" in app.owner ? app.owner.id : null;
      if (botOwnerId) logger.info(`Bot-Owner erkannt: ${botOwnerId}`);
    } catch (err) {
      logger.warn("Konnte Bot-Owner ID nicht abrufen: " + String(err));
    }

    const rest = new REST({ version: "10" }).setToken(token);
    try {
      const guilds = await c.guilds.fetch();
      for (const [guildId] of guilds) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands.map((cmd) => cmd.toJSON()),
        });
      }
      logger.info("Slash-Commands registriert");
    } catch (err) {
      logger.error("Registrierung der Slash-Commands fehlgeschlagen: " + String(err));
    }

    cron.schedule("*/5 * * * *", () => {
      logger.info("🔄 Starte automatische Deal-Suche (alle 5 Minuten)");
      postDeals(client).catch((err) => logger.error("Cron Dealcheck fehlgeschlagen: " + String(err)));
    });

    await postDeals(client);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      const { customId, user } = interaction;

      if (customId.startsWith("save_")) {
        await interaction.deferUpdate();
        const itemId = customId.replace("save_", "");
        const item = itemCache.get(itemId);

        if (!item) {
          await interaction.followUp({ content: "❌ Item nicht mehr im Cache (zu alt). Bitte nutze einen neueren Deal.", ephemeral: true });
          return;
        }

        const savedEmbed = new EmbedBuilder()
          .setColor(0xe91e63)
          .setTitle(`❤️ Gemerkter Deal: ${item.brand || ""} | ${item.title}`.slice(0, 250))
          .setURL(item.url)
          .addFields(
            { name: "💰 Preis", value: `**${item.price.toFixed(2)} ${item.currency}**`, inline: true },
            { name: "📐 Größe", value: item.size || "—", inline: true },
            { name: "✨ Zustand", value: item.condition || "—", inline: true },
            { name: "👤 Verkäufer", value: item.seller || "—", inline: true },
          )
          .setFooter({ text: "Deine gemerkten Deals • Snipebot" })
          .setTimestamp();
        if (item.imageUrl) savedEmbed.setImage(item.imageUrl);

        const platformName = item.platform === "vinted" ? "Vinted" : "Kleinanzeigen";
        const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel(`🛒 Auf ${platformName} ansehen`).setStyle(ButtonStyle.Link).setURL(item.url),
        );

        try {
          const dm = await user.createDM();
          await dm.send({
            content: `❤️ **Du hast dir einen Deal gemerkt!**`,
            embeds: [savedEmbed],
            components: [linkRow],
          });
          await interaction.followUp({ content: "✅ Deal wurde dir per DM gemerkt!", ephemeral: true });
        } catch {
          await interaction.followUp({
            content: "⚠️ Deine DMs sind deaktiviert. Aktiviere DMs, um Deals zu speichern.",
            ephemeral: true,
          });
        }
        return;
      }

      if (customId.startsWith("interested_")) {
        await interaction.deferUpdate();
        try {
          await interaction.message.react("👍");
          await interaction.followUp({ content: "👍 Als interessant markiert!", ephemeral: true });
        } catch {
          await interaction.followUp({ content: "❌ Fehler beim Reagieren.", ephemeral: true });
        }
        return;
      }

      if (customId.startsWith("fakecheck_")) {
        await interaction.deferReply({ ephemeral: true });
        const itemId = customId.replace("fakecheck_", "");
        const item = itemCache.get(itemId);

        if (!item) {
          await interaction.editReply("❌ Item nicht mehr im Cache (zu alt). Bitte nutze einen neueren Deal.");
          return;
        }

        const { embed, row } = runFakeCheck(item);

        try {
          const dm = await user.createDM();
          await dm.send({
            content: `🔍 **Dein Fake-Check für einen Deal aus dem Server:**`,
            embeds: [embed],
            components: [row],
          });
          await interaction.editReply("✅ Fake-Check wurde dir per DM geschickt!");
        } catch {
          const fakeChannel = await findChannelByName(client, "fake-check");
          if (fakeChannel) {
            await fakeChannel.send({ content: `Fake-Check angefragt von <@${user.id}>:`, embeds: [embed], components: [row] });
            await interaction.editReply(`✅ Fake-Check in ${fakeChannel} gepostet (DMs sind deaktiviert).`);
          } else {
            await interaction.editReply({ embeds: [embed], components: [row] });
          }
        }
        return;
      }

      if (customId.startsWith("pricecheck_")) {
        await interaction.deferReply({ ephemeral: true });
        const itemId = customId.replace("pricecheck_", "");
        const item = itemCache.get(itemId);

        if (!item) {
          await interaction.editReply("❌ Item nicht mehr im Cache (zu alt). Bitte nutze einen neueren Deal.");
          return;
        }

        const alternatives = item.platform === "vinted" 
          ? await findCheaperVinted(item as any)
          : [];

        const mainEmbed = new EmbedBuilder()
          .setColor(0x09b1ba)
          .setTitle(`💰 Pricecheck: ${item.brand || ""} | ${item.title}`.slice(0, 250))
          .setURL(item.url)
          .setDescription(`**Dein Inserat:** ${item.price.toFixed(2)} ${item.currency} • ${item.size || "—"} • ${item.condition || "—"}`)
          .setFooter({ text: "Pricecheck • Snipebot" })
          .setTimestamp();
        if (item.imageUrl) mainEmbed.setThumbnail(item.imageUrl);

        const allEmbeds = [mainEmbed];
        const allRows: ActionRowBuilder<ButtonBuilder>[] = [];

        if (alternatives.length === 0) {
          mainEmbed.addFields({ name: "🔍 Ergebnis", value: "✅ Kein günstigeres Angebot gefunden — das ist schon ein guter Preis!" });
        } else {
          mainEmbed.addFields({ name: `🔍 ${alternatives.length} günstigere Alternative(n) gefunden`, value: "Die besten Alternativen siehst du unten:" });

          for (const [i, alt] of alternatives.slice(0, 3).entries()) {
            const savings = item.price - alt.price;
            allEmbeds.push(
              new EmbedBuilder()
                .setColor(0x00cc66)
                .setTitle(`#${i + 1} ${alt.brand || "—"} | ${alt.title}`.slice(0, 250))
                .setURL(alt.url)
                .addFields(
                  { name: "💰 Preis", value: `**${alt.price.toFixed(2)} ${alt.currency}**`, inline: true },
                  { name: "💸 Ersparnis", value: `**-${savings.toFixed(2)} EUR**`, inline: true },
                  { name: "📐 Größe", value: alt.size || "—", inline: true },
                  { name: "✨ Zustand", value: alt.condition || "—", inline: true },
                  { name: "👤 Verkäufer", value: alt.seller || "—", inline: true },
                )
                .setThumbnail(alt.imageUrl),
            );
            allRows.push(
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setLabel(`#${i + 1} Ansehen`).setStyle(ButtonStyle.Link).setURL(alt.url),
              ),
            );
          }
        }

        try {
          const dm = await user.createDM();
          await dm.send({ content: `💰 **Dein Pricecheck aus dem Server:**`, embeds: allEmbeds, components: allRows });
          await interaction.editReply("✅ Pricecheck wurde dir per DM geschickt!");
        } catch {
          const priceChannel = await findChannelByName(client, "pricecheck");
          if (priceChannel) {
            await priceChannel.send({ content: `Pricecheck angefragt von <@${user.id}>:`, embeds: allEmbeds, components: allRows });
            await interaction.editReply(`✅ Pricecheck in ${priceChannel} gepostet (DMs sind deaktiviert).`);
          } else {
            await interaction.editReply({ embeds: allEmbeds, components: allRows });
          }
        }
        return;
      }

      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;

    const guildId = cmd.guildId;
    if (guildId && WHOP_API_KEY && WHOP_PRODUCT_ID) {
      const licensed = await isGuildLicensed(guildId);
      if (!licensed) {
        await cmd.reply({
          content: "❌ **Kein aktives Abonnement!**\nDieser Bot ist nur für Premium-Mitglieder.\n👉 Kaufe eine Lizenz: https://whop.com",
          ephemeral: true,
        });
        return;
      }
    }

    try {
      if (cmd.commandName === "deals") {
        const sub = cmd.options.getSubcommand();

        if (sub === "start") {
          await cmd.deferReply();
          watchConfig.active = true;
          await cmd.editReply("✅ Deal-Suche gestartet! Suche jetzt...");
          await postDeals(client);
          await cmd.followUp("✅ Erste Suche abgeschlossen!");

        } else if (sub === "stop") {
          watchConfig.active = false;
          await cmd.reply("⏹️ Deal-Suche gestoppt.");

        } else if (sub === "status") {
          await cmd.reply(
            `📊 **Status**\n` +
            `• Aktiv: ${watchConfig.active ? "✅ Ja" : "❌ Nein"}\n` +
            `• Marken: ${watchConfig.brands.join(", ")}\n` +
            `• Max. Preis: ${watchConfig.maxPrice ? `${watchConfig.maxPrice} EUR` : "kein Limit"}\n` +
            `• Items im Cache: ${seenItemIds.size} (${itemCache.size} im Speicher)`,
          );

        } else if (sub === "marken") {
          const liste = cmd.options.getString("liste", true);
          watchConfig.brands = liste.split(",").map((b) => b.trim()).filter(Boolean);
          seenItemIds.clear();
          await cmd.reply(`✅ Marken aktualisiert: **${watchConfig.brands.join(", ")}**`);

        } else if (sub === "maxpreis") {
          const preis = cmd.options.getInteger("preis", true);
          watchConfig.maxPrice = preis > 0 ? preis : undefined;
          seenItemIds.clear();
          await cmd.reply(`✅ Max. Preis: ${preis > 0 ? `**${preis} EUR**` : "**kein Limit**"}`);

        } else if (sub === "kategorie") {
          const typ = cmd.options.getString("typ", true);
          if (!CATEGORIES[typ]) { await cmd.reply("❌ Unbekannte Kategorie."); return; }
          watchConfig.categoryKey = typ;
          seenItemIds.clear();
          await cmd.reply(`✅ Kategorie gesetzt: **${CATEGORIES[typ]!.label}** → #${CATEGORIES[typ]!.channelName}`);

        } else if (sub === "suche") {
          await cmd.deferReply();
          await postDeals(client);
          await cmd.editReply("✅ Suche abgeschlossen!");

        } else if (sub === "reset") {
          seenItemIds.clear();
          itemCache.clear();
          await cmd.reply("🗑️ Cache geleert. Bei nächster Suche werden alle Items wieder als 'neu' behandelt.");
        }

      } else if (cmd.commandName === "lizenz") {
        if (!WHOP_API_KEY || !WHOP_PRODUCT_ID) {
          await cmd.reply({ content: "ℹ️ Whop ist noch nicht konfiguriert — Bot läuft im freien Modus.", ephemeral: true });
          return;
        }
        const licensed = guildId ? await isGuildLicensed(guildId) : false;
        await cmd.reply({
          content: licensed
            ? "✅ **Lizenz aktiv!** Dieser Server hat ein gültiges Premium-Abonnement."
            : "❌ **Keine Lizenz!** Kaufe eine Lizenz unter: https://whop.com",
          ephemeral: true,
        });
      }

    } catch (err) {
      logger.error("Fehler beim Verarbeiten eines Slash-Commands: " + String(err));
      try {
        const msg = { content: "❌ Fehler beim Verarbeiten des Befehls.", ephemeral: true };
        if (cmd.deferred || cmd.replied) await cmd.followUp(msg);
        else await cmd.reply(msg);
      } catch { /* ignorieren */ }
    }
  });

  client.on(Events.Error, (err) => { logger.error("Discord Client Fehler: " + String(err)); });
  client.on(Events.ShardDisconnect, (event, shardId) => { logger.warn(`Shard ${shardId} getrennt (Code: ${event.code})`); });
  client.on(Events.ShardReconnecting, (shardId) => { logger.info(`Shard ${shardId} verbindet neu...`); });
  client.on(Events.ShardResume, (shardId) => { logger.info(`Shard ${shardId} erfolgreich fortgesetzt`); });

  await client.login(token);
}
