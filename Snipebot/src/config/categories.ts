export interface CategoryConfig {
  label: string;
  keyword: string;
  channelName: string;
  kleinanzeigenCategory: string;
  brands: string[];
}

const ALL_BRANDS = [
  "Nike",
  "Adidas",
  "Carhartt",
  "Lacoste",
  "Ralph Lauren",
  "Tommy Hilfiger",
  "Fred Perry",
  "Hugo Boss",
  "Burberry",
  "Hermes",
  "Louis Vuitton",
  "Loro Piana",
  "Brooks Brothers",
  "Stussy",
  "Supreme",
  "Palace",
  "Dickies",
];

export const CATEGORIES: Record<string, CategoryConfig> = {
  shirts: {
    label: "Shirts & Polos",
    keyword: "polo shirt",
    channelName: "men_shirts",
    kleinanzeigenCategory: "c153",
    brands: ALL_BRANDS,
  },
  pants: {
    label: "Hosen & Jeans",
    keyword: "hose jeans",
    channelName: "men_pants",
    kleinanzeigenCategory: "c153",
    brands: ALL_BRANDS,
  },
  shoes: {
    label: "Schuhe",
    keyword: "schuhe sneaker",
    channelName: "men_shoes",
    kleinanzeigenCategory: "c153",
    brands: ALL_BRANDS,
  },
  accessories: {
    label: "Accessoires",
    keyword: "",
    channelName: "deals",
    kleinanzeigenCategory: "c153",
    brands: ALL_BRANDS,
  },
};

export const ALL_CATEGORY_KEYS = Object.keys(CATEGORIES);