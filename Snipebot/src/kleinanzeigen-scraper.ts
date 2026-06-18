import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./lib/logger.js";

export interface KleinanzeigenItem {
  id: string;
  title: string;
  price: number;
  currency: string;
  brand: string;
  size: string;
  condition: string;
  imageUrl: string;
  url: string;
  seller: string;
  location: string;
  platform: "kleinanzeigen";
}

export interface SearchOptions {
  maxPrice?: number;
  category?: string;
}

const KLEINANZEIGEN_BASE = "https://www.kleinanzeigen.de";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

const CATEGORY_MAPPING: Record<string, string> = {
  shirts: "87",      // Herrenkleidung
  pants: "87",       // Herrenkleidung
  shoes: "158",      // Herrenschuhe
  accessories: "87", // Herrenkleidung (for general items)
};

function getCategoryId(categoryKey: string): string {
  return CATEGORY_MAPPING[categoryKey] || "87";
}

function parsePrice(priceText: string): number {
  // Handle formats: "50 €", "50€", "VB", "Zu verschenken"
  const cleaned = priceText.replace(/\s+/g, "").toLowerCase();
  
  if (cleaned.includes("verschenken") || cleaned === "vb") {
    return 0;
  }
  
  const match = cleaned.match(/(\d+(?:[.,]\d+)?)/);
  return match ? parseFloat(match[1].replace(",", ".")) : 0;
}

function extractBrand(title: string, searchQuery: string): string {
  const brands = ["Nike", "Adidas", "Lacoste", "Ralph Lauren", "Carhartt", "Puma", "Tommy Hilfiger"];
  const titleLower = title.toLowerCase();
  
  for (const brand of brands) {
    if (titleLower.includes(brand.toLowerCase())) {
      return brand;
    }
  }
  
  // Fallback to first word of search query
  return searchQuery.split(" ")[0] || "—";
}

export async function searchKleinanzeigen(
  searchText: string,
  options: SearchOptions = {},
): Promise<KleinanzeigenItem[]> {
  try {
    const categoryId = options.category ? getCategoryId(options.category) : "87";
    
    // Build search URL
    const params = new URLSearchParams({
      keywords: searchText,
      sortingField: "SORTING_DATE", // Newest first
    });
    
    if (options.maxPrice && options.maxPrice > 0) {
      params.append("maxPrice", options.maxPrice.toString());
    }
    
    // Use men's clothing section for all searches
    const searchUrl = `${KLEINANZEIGEN_BASE}/s-herrenbekleidung/c87?${params.toString()}`;
    
    logger.info(`🔍 Kleinanzeigen Suche: ${searchText}`);

    const headers = {
      "User-Agent": randomUA(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    };

    const response = await axios.get(searchUrl, {
      headers,
      timeout: 12000,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      logger.warn(`⚠️ Kleinanzeigen Status ${response.status}`);
      return [];
    }

    const $ = cheerio.load(response.data);
    const items: KleinanzeigenItem[] = [];

    // Kleinanzeigen uses article.aditem for listings
    $("article.aditem").each((_, element) => {
      try {
        const $item = $(element);
        
        const id = $item.attr("data-adid") || "";
        if (!id) return;
        
        const title = $item.find(".ellipsis").first().text().trim();
        if (!title) return;
        
        const priceText = $item.find(".aditem-main--middle--price-shipping--price").text().trim();
        const price = parsePrice(priceText);
        
        const relativeUrl = $item.find("a.ellipsis").attr("href") || "";
        const url = relativeUrl.startsWith("http") ? relativeUrl : `${KLEINANZEIGEN_BASE}${relativeUrl}`;
        
        const imageUrl = $item.find("img.galleryimage-element").attr("src") || "";
        const location = $item.find(".aditem-main--top--left").text().trim();
        
        const brand = extractBrand(title, searchText);
        
        items.push({
          id,
          title,
          price,
          currency: "EUR",
          brand,
          size: "—",
          condition: "—",
          imageUrl,
          url,
          seller: "—",
          location: location || "—",
          platform: "kleinanzeigen",
        });
      } catch (err) {
        logger.warn("Fehler beim Parsen eines Kleinanzeigen-Items:", err);
      }
    });

    const validItems = items.filter(item => item.price > 0);
    logger.info(`✅ Kleinanzeigen: ${validItems.length} Items gefunden`);
    return validItems;

  } catch (error) {
    logger.error(`❌ Kleinanzeigen Fehler: ${String(error)}`);
    return [];
  }
}
