/**
 * Realistic sample payloads. Used by "Send test webhook" and by the sandbox seed.
 * All people and emails are fictional (example.com).
 */

export const HOTMART_EVENTS = [
  "PURCHASE_APPROVED",
  "PURCHASE_COMPLETE",
  "PURCHASE_BILLET_PRINTED",
  "PURCHASE_CANCELED",
  "PURCHASE_REFUNDED",
  "PURCHASE_CHARGEBACK",
  "SUBSCRIPTION_CANCELLATION",
] as const;

export const ORDER_EVENTS = ["order.created", "order.paid", "order.refunded", "subscription.renewed", "checkout.abandoned"] as const;

const FIRST_NAMES = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Felipe", "Gabriela", "Henrique", "Isabela", "João", "Larissa", "Marcos"];
const LAST_NAMES = ["Souza", "Oliveira", "Lima", "Pereira", "Costa", "Almeida", "Ribeiro", "Carvalho", "Gomes", "Martins"];
const PRODUCTS = [
  { id: 3418920, ucode: "e1a7c2d4-5b3f-4a8e-9c61-2f0d8b7a9e13", name: "Curso Online de Finanças Pessoais", price: 197 },
  { id: 3420117, ucode: "7b9d0e2f-1c4a-4f6b-8d3e-5a2c9f1b0d47", name: "Mentoria em Grupo - Turma 4", price: 497 },
  { id: 3399054, ucode: "c3f5a8b1-9e2d-4c7a-b6f0-8d1e4a2c5b96", name: "Ebook Planejamento Semanal", price: 27 },
];

export type Rng = () => number;

/** Small deterministic PRNG (mulberry32) so the seed produces the same dataset every boot. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function hex(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += Math.floor(rng() * 16).toString(16);
  return out;
}

function uuidFrom(rng: Rng): string {
  const h = hex(rng, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function person(rng: Rng) {
  const first = pick(rng, FIRST_NAMES);
  const last = pick(rng, LAST_NAMES);
  const email = `${first}.${last}${Math.floor(rng() * 90 + 10)}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return { first, last, name: `${first} ${last}`, email: `${email}@example.com` };
}

const STATUS_BY_EVENT: Record<string, string> = {
  PURCHASE_APPROVED: "APPROVED",
  PURCHASE_COMPLETE: "COMPLETED",
  PURCHASE_BILLET_PRINTED: "BILLET_PRINTED",
  PURCHASE_CANCELED: "CANCELED",
  PURCHASE_REFUNDED: "REFUNDED",
  PURCHASE_CHARGEBACK: "CHARGEBACK",
  SUBSCRIPTION_CANCELLATION: "CANCELLED",
};

/** Hotmart webhook v2-style payload (shape follows the public docs; values are fictional). */
export function hotmartPayload(event: string, rng: Rng = Math.random, at: Date = new Date()) {
  const buyer = person(rng);
  const product = pick(rng, PRODUCTS);
  const ts = at.getTime();
  const card = event !== "PURCHASE_BILLET_PRINTED";
  return {
    id: uuidFrom(rng),
    creation_date: ts,
    event,
    version: "2.0.0",
    data: {
      product: { id: product.id, ucode: product.ucode, name: product.name, has_co_production: false },
      buyer: {
        email: buyer.email,
        name: buyer.name,
        first_name: buyer.first,
        last_name: buyer.last,
        checkout_phone: `+55119${Math.floor(rng() * 9e7 + 1e7)}`,
        address: { country: "Brasil", country_iso: "BR" },
      },
      producer: { name: "Escola Exemplo LTDA" },
      purchase: {
        transaction: `HP${Math.floor(rng() * 9e13 + 1e13)}`,
        order_date: ts - 60_000,
        approved_date: ts,
        status: STATUS_BY_EVENT[event] ?? "APPROVED",
        price: { value: product.price, currency_value: "BRL" },
        full_price: { value: product.price, currency_value: "BRL" },
        payment: card
          ? { type: "CREDIT_CARD", installments_number: pick(rng, [1, 1, 3, 6, 12]) }
          : { type: "BILLET", installments_number: 1, billet_barcode: hex(rng, 44) },
        offer: { code: hex(rng, 8) },
      },
      commissions: [{ value: Math.round(product.price * 0.9 * 100) / 100, source: "PRODUCER", currency_value: "BRL" }],
    },
  };
}

/** Generic order event, roughly what a Stripe-style checkout or CRM would send. */
export function orderPayload(event: string, rng: Rng = Math.random, at: Date = new Date()) {
  const customer = person(rng);
  const product = pick(rng, PRODUCTS);
  return {
    id: `evt_${hex(rng, 24)}`,
    event,
    created_at: at.toISOString(),
    data: {
      order_id: `ord_${hex(rng, 12)}`,
      amount_cents: product.price * 100,
      currency: "BRL",
      items: [{ sku: `SKU-${product.id}`, name: product.name, quantity: 1 }],
      customer: { name: customer.name, email: customer.email },
      utm: { source: pick(rng, ["facebook", "google", "email", "direct"]), campaign: "black-friday" },
    },
  };
}
