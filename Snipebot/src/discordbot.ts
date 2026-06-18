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
import {
  searchVinted,
  findCheaperAlternatives as findCheaperVinted,
  type VintedItem,
} from "./vinted-scraper.js";
import {
  searchKleinanzeigen,
  type KleinanzeigenItem,
} from "./kleinanzeigen-scraper.js";
import { logger } from "./lib/logger.js";

// Unified item type for both platforms
type DealItem = VintedItem | KleinanzeigenItem;

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

interface CategoryDef {
  label: string;
  keyword: string;
  channelName: string;
  kleinanzeigenCategory: string;
}

const CATEGORIES: Record<string, CategoryDef> = {
  shirts: { label: "Shirts & Tops", keyword: "shirt", channelName: "men_shirts", kleinanzeigenCategory: "87" },
  pants: { label: "Hosen & Jeans", keyword: "hose", channelName: "men_pants", kleinanzeigenCategory: "87" },
  shoes: { label: "Schuhe", keyword: "schuhe", channelName: "men_shoes", kleinanzeigenCategory: "158" },
  accessories: { label: "Accessoires", keyword: "", channelName: "deals", kleinanzeigenCategory: "87" },
};

const ALL_CATEGORY_KEYS = Object.keys(CATEGORIES);

const CATEGORY_CHOICES = [
  { name: "Shirts & Tops", value: "shirts" },
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

function buildSearchText(brand: string, categoryKey: string): string {
  const cat = CATEGORIES[categoryKey];
  if (!cat || !cat.keyword) return brand;
  return `${brand} ${cat.keyword}`;
}

async function findChannelInSection(client: Client, channelName: string, sectionName: string): Promise<TextChannel | null> {
  for (const [, guild] of client.guilds.cache) {
    const category = guild.channels.cache.find((c) => c.name.toLowerCase() === sectionName.toLowerCase() && c.type === 4);
    if (!category) continue;
    const ch = guild.channels.cache.find((c) => c.name === channelName && c instanceof TextChannel && c.parentId === category.id) as TextChannel | undefined;
    if (ch) return ch;
  }
  return null;
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

interface GenderTarget {
  section: string;
  catalogIdsFn: (categoryKey: string) => number[];
}

async function postDealsForGenderTarget(client: Client, categoryKeys: string[], target: GenderTarget) {
  for (const categoryKey of categoryKeys) {
    const cat = CATEGORIES[categoryKey];
    if (!cat) continue;
    logger.info(`🔍 Suche in Kategorie: ${cat.label}`);
    await new Promise((r) => setTimeout(r, 500));

    const channel = (await findChannelByName(client, cat.channelName)) ?? (await getFallbackChannel(client));

    if (!channel) {
      logger.warn(`Kanal #${cat.channelName} nicht gefunden.`);
      continue;
    }

    for (const brand of watchConfig.brands) {
      try {
        // Build search text with category keyword
        const searchText = cat.keyword ? `${brand} ${cat.keyword}` : brand;
        logger.info(`🔎 Suche: "${searchText}" in #${cat.channelName} (Max: ${watchConfig.maxPrice || 'unbegrenzt'}€)`);
        
        // Search both platforms in parallel
        const [vintedItems, kleinanzeigenItems] = await Promise.all([
          searchVinted(searchText, {
            maxPrice: watchConfig.maxPrice,
          }),
          searchKleinanzeigen(searchText, {
            maxPrice: watchConfig.maxPrice,
            category: categoryKey,
          }),
        ]);
        
        // Reset counter if we got any results
        if (vintedItems.length > 0 || kleinanzeigenItems.length > 0) {
          consecutiveRateLimits = 0;
        }
        
        // Merge and sort by price (cheapest first)
        const allItems = [...vintedItems, ...kleinanzeigenItems].sort((a, b) => a.price - b.price);
        
        logger.info(`✅ ${allItems.length} Items gefunden (${vintedItems.length} Vinted, ${kleinanzeigenItems.length} Kleinanzeigen)`);
        const newItems = allItems.filter((i) => !seenItemIds.has(i.id));
        logger.info(`📌 ${newItems.length} neue Items (${allItems.length - newItems.length} bereits gesehen)`);

        // Post top 3 best deals (cheapest)
        for (const item of newItems.slice(0, 3)) {
          seenItemIds.add(item.id);
          cacheItem(item);
          const embed = buildDealEmbed(item);
          const rows = buildDealButtons(item);
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
}

let lastBlockedNotify = 0;

async function notifyBlocked(client: Client) {
  if (Date.now() - lastBlockedNotify < 60 * 60 * 1000) return;
  lastBlockedNotify = Date.now();

  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle("⚠️ Vinted-Token abgelaufen")
    .setDescription(
      "Der Bot kann nicht mehr auf Vinted zugreifen.\n\n" +
      "**So erneuerst du den Token (2 Minuten):**\n" +
      "1️⃣ Öffne **vinted.de** im Browser und logge dich ein\n" +
      "2️⃣ Drücke **F12** → Tab **Application** → **Cookies** → `www.vinted.de`\n" +
      "3️⃣ Suche `access_token_web` → Wert **kopieren**\n" +
      "4️⃣ Schick mir den kopierten Wert einfach **per DM** — oder nutze `/deals token`\n\n" +
      "✅ Token gilt dann ca. **12 Stunden**",
    )
    .setFooter({ text: "Snipebot • Token-Erneuerung" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("🔗 Vinted öffnen")
      .setStyle(ButtonStyle.Link)
      .setURL("https://www.vinted.de"),
  );

  if (botOwnerId) {
    try {
      const owner = await client.users.fetch(botOwnerId);
      const dm = await owner.createDM();
      await dm.send({ embeds: [embed], components: [row] });
      logger.info("Ablauf-Benachrichtigung an Bot-Owner via DM gesendet");
    } catch (err) {
      logger.warn("Konnte keine DM an den Bot-Owner senden: " + String(err));
    }
  }

  try {
    const ch = await getFallbackChannel(client);
    if (ch) await ch.send({ embeds: [embed], components: [row] });
  } catch { /* ignorieren */ }
}

async function postDeals(client: Client) {
  if (!watchConfig.active) return;

  // Check if we're rate limited
  if (Date.now() < rateLimitedUntil) {
    const waitMinutes = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
    logger.warn(`⏸️ Rate-Limit aktiv - warte noch ${waitMinutes} Minuten`);
    return;
  }

  logger.info("🚀 Starte Deal-Suche auf Kleinanzeigen");

  // Search all categories
  const categoryKeys = ALL_CATEGORY_KEYS;
  const target: GenderTarget = { section: "men", catalogIdsFn: () => [] };

  await postDealsForGenderTarget(client, categoryKeys, target);
  
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
    .addSubcommand((sub) =>
      sub.setName("geschlecht").setDescription("Nach Herren / Damen / Beide filtern")
        .addStringOption((o) =>
          o.setName("typ").setDescription("Geschlecht auswählen").setRequired(true)
            .addChoices({ name: "Herren", value: "herren" }, { name: "Damen", value: "damen" }, { name: "Beide", value: "beide" }),
        ),
    )
    .addSubcommand((sub) => sub.setName("suche").setDescription("Jetzt sofort nach Deals suchen"))
    .addSubcommand((sub) => sub.setName("reset").setDescription("Cache zurücksetzen (zeigt alte Deals erneut)"))
    .addSubcommand((sub) =>
      sub.setName("token").setDescription("Vinted access_token_web Cookie manuell setzen")
        .addStringOption((o) => o.setName("wert").setDescription("access_token_web Cookie-Wert aus Browser DevTools").setRequired(true)),
    ),

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
    partials: [2, 3], // Channel + Message Partials für DMs
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

      if (customId.startsWith("interested_")) {
        try {
          await interaction.message.react("👍");
          await interaction.reply({ content: "👍 Als interessant markiert!", ephemeral: true });
        } catch {
          await interaction.reply({ content: "❌ Fehler beim Reagieren.", ephemeral: true });
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

        // Only Vinted items support findCheaperAlternatives for now
        const alternatives = item.platform === "vinted" 
          ? await findCheaperVinted(item as VintedItem)
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

      if (customId.startsWith("save_")) {
        await interaction.deferReply({ ephemeral: true });
        const itemId = customId.replace("save_", "");
        const item = itemCache.get(itemId);

        if (!item) {
          await interaction.editReply("❌ Item nicht mehr im Cache (zu alt). Bitte nutze einen neueren Deal.");
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
          await interaction.editReply("✅ Deal wurde dir per DM gemerkt!");
        } catch {
          await interaction.editReply({
            content: "⚠️ Deine DMs sind deaktiviert. Aktiviere DMs, um Deals zu speichern.",
          });
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
            `• Geschlecht: **${genderLabel(watchConfig.gender)}**\n` +
            `• Max. Preis: ${watchConfig.maxPrice ? `${watchConfig.maxPrice} EUR` : "kein Limit"}\n` +
            `• Items im Cache: ${seenItemIds.size} (${itemCache.size} im Speicher)\n` +
            `• Kanal: #deals`,
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
          if (typ !== "alle" && !CATEGORIES[typ]) { await cmd.reply("❌ Unbekannte Kategorie."); return; }
          watchConfig.categoryKey = typ;
          seenItemIds.clear();
          const label = typ === "alle"
            ? "Alle Kategorien (jede in eigenem Kanal)"
            : `**${CATEGORIES[typ]!.label}** → #${CATEGORIES[typ]!.channelName}`;
          await cmd.reply(`✅ Kategorie gesetzt: ${label}`);

        } else if (sub === "geschlecht") {
          const typ = cmd.options.getString("typ", true) as Gender;
          watchConfig.gender = typ;
          seenItemIds.clear();
          await cmd.reply(`✅ Geschlecht gesetzt: **${genderLabel(typ)}**`);

        } else if (sub === "suche") {
          await cmd.deferReply();
          await postDeals(client);
          await cmd.editReply("✅ Suche abgeschlossen!");

        } else if (sub === "reset") {
          seenItemIds.clear();
          itemCache.clear();
          await cmd.reply("🗑️ Cache geleert. Bei nächster Suche werden alle Items wieder als 'neu' behandelt.");

        } else if (sub === "token") {
          await cmd.reply({ content: "ℹ️ Token-Management wurde entfernt. Der Bot nutzt jetzt tokenlose API-Anfragen.", ephemeral: true });
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