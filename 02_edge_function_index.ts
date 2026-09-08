// =========================================================
// KAVUP — Edge Function "api"
// Επικόλλησέ το ΟΛΟΚΛΗΡΟ στο: Supabase Dashboard → Edge Functions →
//   Create a new function → όνομα: "api" → επικόλλησε αντί για το δείγμα κώδικα → Deploy
//
// Αυτό είναι ΤΟ ΜΟΝΟ σημείο που μιλάει με τη βάση με πλήρη δικαιώματα
// (service_role). Ο browser ΔΕΝ έχει ποτέ αυτό το κλειδί — μόνο καλεί
// αυτή τη function με το δημόσιο (publishable) key.
// =========================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(supabaseUrl, serviceRoleKey);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
function fail(message: string, status = 400) {
  return json({ ok: false, error: message }, status);
}

// ---------- password hashing (PBKDF2, χωρίς εξωτερικά dependencies) ----------
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `pbkdf2$100000$${saltB64}$${hashB64}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  const computed = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const expected = parts[3];
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function randCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}
const VALID_CATEGORIES = new Set([
  "whisky", "vodka", "gin", "rum", "tequila", "liqueur", "wine", "beer",
  "champagne", "soda", "water", "energy", "juices", "other",
]);

function background(promise: Promise<unknown>) {
  // @ts-ignore - το EdgeRuntime.waitUntil υπάρχει στο Supabase runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(promise);
  } else {
    promise.catch(() => {});
  }
}

async function audit(shopId: string | null, role: string | null, action: string, detail: Record<string, unknown> = {}) {
  background(db.from("audit_log").insert({ shop_id: shopId, role, action, detail }));
}

// ---------- session helpers ----------
async function getSession(token: string | undefined) {
  if (!token) return null;
  const { data, error } = await db.from("sessions").select("*").eq("token", token).maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data as { token: string; shop_id: string; role: "admin" | "viewer"; staff_name: string | null };
}

// ---------- rate limiting ----------
async function isRateLimited(nameKeyValue: string): Promise<boolean> {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { count } = await db
    .from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("name_key", nameKeyValue)
    .eq("success", false)
    .gte("created_at", since);
  return (count ?? 0) >= 8;
}
async function logAttempt(nameKeyValue: string, success: boolean) {
  await db.from("login_attempts").insert({ name_key: nameKeyValue, success });
}

// ---------- photo storage ----------
async function uploadPhoto(shopId: string, productId: string, base64DataUri: string): Promise<string | null> {
  if (typeof base64DataUri !== "string" || base64DataUri.length > 8_000_000) return null; // ~6MB εικόνα, αρκετό για φωτο προϊόντος
  const match = base64DataUri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return null;
  const contentType = match[1];
  const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  const path = `${shopId}/${productId}.jpg`;
  const { error } = await db.storage.from("product-photos").upload(path, bytes, { contentType, upsert: true });
  if (error) return null;
  return path;
}
async function signedPhotoUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await db.storage.from("product-photos").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

// ---------- input validation helpers ----------
function isNonEmptyString(v: unknown, maxLen = 200): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}
function isNonNegInt(v: unknown, max = 1_000_000): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Λανθασμένο αίτημα");
  }
  const action = String(body.action || "");

  try {
    // ---------------- ping (heartbeat - διατηρεί το project ενεργό, καμία πρόσβαση δεδομένων) ----------------
    if (action === "ping") {
      return json({ ok: true, pong: true, time: new Date().toISOString() });
    }

    // ---------------- create_shop ----------------
    if (action === "create_shop") {
      const name = String(body.name || "").trim();
      const adminPassword = String(body.adminPassword || "");
      if (!isNonEmptyString(name, 80)) return fail("Γράψε ένα όνομα μαγαζιού");
      if (adminPassword.length < 6) return fail("Ο κωδικός θέλει τουλάχιστον 6 χαρακτήρες");

      const { data: existing } = await db.from("shops").select("id").eq("name_key", nameKey(name)).maybeSingle();
      if (existing) return fail("Το όνομα μαγαζιού χρησιμοποιείται ήδη");

      const viewerPassword = randCode();
      const adminHash = await hashPassword(adminPassword);
      const viewerHash = await hashPassword(viewerPassword);

      const { data: shop, error } = await db
        .from("shops")
        .insert({ name, admin_password_hash: adminHash, viewer_password_hash: viewerHash })
        .select("id, name")
        .single();
      if (error || !shop) return fail("Αποτυχία δημιουργίας μαγαζιού");

      const { data: session } = await db
        .from("sessions")
        .insert({ shop_id: shop.id, role: "admin" })
        .select("token")
        .single();

      await audit(shop.id, "admin", "create_shop", { name });
      return json({ ok: true, token: session?.token, role: "admin", shop, viewerPassword });
    }

    // ---------------- migrate_shop (μία φορά, διατηρεί υπάρχοντες κωδικούς) ----------------
    if (action === "migrate_shop") {
      const name = String(body.name || "").trim();
      const adminPassword = String(body.adminPassword || "");
      const viewerPassword = String(body.viewerPassword || "");
      const products = Array.isArray(body.products) ? body.products : [];
      const history = Array.isArray(body.history) ? body.history : [];
      if (!isNonEmptyString(name, 80) || !adminPassword || !viewerPassword) return fail("Λείπουν στοιχεία μεταφοράς");

      const { data: existing } = await db.from("shops").select("id").eq("name_key", nameKey(name)).maybeSingle();
      if (existing) return fail("Το όνομα μαγαζιού υπάρχει ήδη στον server — επικοινώνησε πριν ξαναδοκιμάσεις");

      const adminHash = await hashPassword(adminPassword);
      const viewerHash = await hashPassword(viewerPassword);
      const { data: shop, error } = await db
        .from("shops")
        .insert({ name, admin_password_hash: adminHash, viewer_password_hash: viewerHash })
        .select("id, name")
        .single();
      if (error || !shop) return fail("Αποτυχία δημιουργίας μαγαζιού");

      const idMap = new Map<string, string>();
      let migrateOrder = Date.now();
      for (const p of products) {
        const { data: newProd } = await db
          .from("products")
          .insert({
            shop_id: shop.id,
            name: String(p.name || "Άγνωστο"),
            category: String(p.category || "other"),
            qty: isNonNegInt(p.qty) ? p.qty : 0,
            par: isNonNegInt(p.par) ? p.par : 0,
            price: typeof p.price === "number" ? p.price : null,
            sort_order: migrateOrder++,
          })
          .select("id")
          .single();
        if (newProd) {
          idMap.set(String(p.id), newProd.id);
          if (typeof p.photo === "string" && p.photo.startsWith("data:image")) {
            const path = await uploadPhoto(shop.id, newProd.id, p.photo);
            if (path) await db.from("products").update({ photo_path: path }).eq("id", newProd.id);
          }
        }
      }
      for (const h of history) {
        await db.from("history").insert({
          shop_id: shop.id,
          product_id: idMap.get(String(h.productId)) || null,
          product_name: String(h.productName || ""),
          before: typeof h.before === "number" ? h.before : null,
          after: typeof h.after === "number" ? h.after : null,
          delta: typeof h.delta === "number" ? h.delta : null,
          created_at: h.ts ? new Date(h.ts).toISOString() : new Date().toISOString(),
        });
      }

      const { data: session } = await db.from("sessions").insert({ shop_id: shop.id, role: "admin" }).select("token").single();
      await audit(shop.id, "admin", "migrate_shop", { productCount: products.length, historyCount: history.length });
      return json({ ok: true, token: session?.token, role: "admin", shop });
    }

    // ---------------- login ----------------
    if (action === "login") {
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      const key = nameKey(name);
      if (!name || !password) return fail("Γράψε όνομα και κωδικό");

      if (await isRateLimited(key)) {
        return fail("Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε λίγα λεπτά.", 429);
      }

      const { data: shop } = await db
        .from("shops")
        .select("id, name, admin_password_hash, viewer_password_hash")
        .eq("name_key", key)
        .maybeSingle();

      if (!shop) {
        await logAttempt(key, false);
        return fail("Λάθος όνομα ή κωδικός");
      }

      const isAdmin = await verifyPassword(password, shop.admin_password_hash);
      const isViewer = !isAdmin && (await verifyPassword(password, shop.viewer_password_hash));

      if (!isAdmin && !isViewer) {
        await logAttempt(key, false);
        return fail("Λάθος όνομα ή κωδικός");
      }

      await logAttempt(key, true);
      const role = isAdmin ? "admin" : "viewer";
      const staffName = String(body.staffName || "").trim().slice(0, 60) || null;
      const { data: session } = await db.from("sessions").insert({ shop_id: shop.id, role, staff_name: staffName }).select("token").single();
      await audit(shop.id, role, "login");
      return json({ ok: true, token: session?.token, role, shop: { id: shop.id, name: shop.name } });
    }

    // ---------------- Όλα τα παρακάτω χρειάζονται έγκυρο session token ----------------
    const session = await getSession(String(body.token || ""));
    if (!session) return fail("Η σύνδεση έληξε, ξαναμπές", 401);
    const { shop_id: shopId, role } = session;
    const isAdmin = role === "admin";

    // ---------------- get_shop_data ----------------
    if (action === "get_shop_data") {
      const { data: shop } = await db.from("shops").select("id, name").eq("id", shopId).single();
      const { data: products } = await db.from("products").select("*").eq("shop_id", shopId).order("sort_order", { ascending: true });
      const { data: history } = await db
        .from("history")
        .select("*")
        .eq("shop_id", shopId)
        .order("created_at", { ascending: false })
        .limit(500);

      const productsWithUrls = await Promise.all(
        (products || []).map(async (p) => ({ ...p, photo_url: await signedPhotoUrl(p.photo_path) }))
      );
      return json({ ok: true, shop, products: productsWithUrls, history: history || [] });
    }

    // ---------------- adjust_quantity (admin + viewer) ----------------
    if (action === "adjust_quantity") {
      const productId = String(body.productId || "");
      const delta = Number(body.delta);
      if (!productId || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return fail("Λανθασμένα δεδομένα");

      const { data, error } = await db.rpc("adjust_product_qty", {
        p_product_id: productId, p_shop_id: shopId, p_delta: delta,
      });
      if (error) return fail("Αποτυχία αποθήκευσης — δοκίμασε ξανά", 500);
      if (!data || data.length === 0) return fail("Το προϊόν δεν βρέθηκε", 404);
      const row = data[0];

      background(db.from("history").insert({
        shop_id: shopId, product_id: productId, product_name: row.name,
        before: row.before_qty, after: row.after_qty, delta: row.after_qty - row.before_qty, role, staff_name: session.staff_name,
      }));
      await audit(shopId, role, "adjust_quantity", { productId, delta });
      return json({ ok: true, qty: row.after_qty });
    }

    // ---------------- set_quantity (admin + viewer) ----------------
    if (action === "set_quantity") {
      const productId = String(body.productId || "");
      const qty = Number(body.qty);
      if (!productId || !isNonNegInt(qty)) return fail("Λανθασμένη ποσότητα");

      const { data: product } = await db.from("products").select("*").eq("id", productId).eq("shop_id", shopId).maybeSingle();
      if (!product) return fail("Το προϊόν δεν βρέθηκε", 404);

      const { error } = await db.from("products").update({ qty, updated_at: new Date().toISOString() }).eq("id", productId);
      if (error) return fail("Αποτυχία αποθήκευσης — δοκίμασε ξανά", 500);

      background(db.from("history").insert({
        shop_id: shopId, product_id: productId, product_name: product.name,
        before: product.qty, after: qty, delta: qty - product.qty, role, staff_name: session.staff_name,
      }));
      await audit(shopId, role, "set_quantity", { productId, qty });
      return json({ ok: true, qty });
    }

    // ---------------- Τα παρακάτω: ΜΟΝΟ admin ----------------
    if (!isAdmin) return fail("Δεν επιτρέπεται για λογαριασμό προβολής", 403);

    if (action === "create_product") {
      const name = String(body.name || "").trim();
      const category = String(body.category || "other");
      const qty = Number(body.qty);
      const par = Number(body.par);
      const price = body.price === null || body.price === undefined ? null : Number(body.price);
      const crateSize = body.crateSize === null || body.crateSize === undefined || body.crateSize === ""
        ? null
        : Number(body.crateSize);
      if (!isNonEmptyString(name, 120)) return fail("Γράψε όνομα προϊόντος");
      if (!VALID_CATEGORIES.has(category)) return fail("Λανθασμένη κατηγορία");
      if (!isNonNegInt(qty) || !isNonNegInt(par)) return fail("Λανθασμένη ποσότητα/όριο");
      if (price !== null && (isNaN(price) || price < 0 || price > 1000000)) return fail("Λανθασμένη τιμή");
      if (crateSize !== null && (!Number.isInteger(crateSize) || crateSize <= 0 || crateSize > 10000)) return fail("Λανθασμένα τεμάχια ανά κιβώτιο");

      const { data: product, error } = await db
        .from("products")
        .insert({ shop_id: shopId, name, category, qty, par, price, crate_size: crateSize, sort_order: Date.now() })
        .select("*")
        .single();
      if (error || !product) return fail("Αποτυχία προσθήκης προϊόντος", 500);

      if (typeof body.photoBase64 === "string" && body.photoBase64.startsWith("data:image")) {
        const path = await uploadPhoto(shopId, product.id, body.photoBase64);
        if (path) await db.from("products").update({ photo_path: path }).eq("id", product.id);
      }
      await audit(shopId, role, "create_product", { name });
      return json({ ok: true, product });
    }

    if (action === "move_product") {
      const productId = String(body.productId || "");
      const direction = String(body.direction || "");
      if (!productId || (direction !== "up" && direction !== "down")) return fail("Λανθασμένα δεδομένα");
      const { error } = await db.rpc("move_product", {
        p_product_id: productId, p_shop_id: shopId, p_direction: direction,
      });
      if (error) return fail("Αποτυχία αλλαγής σειράς", 500);
      await audit(shopId, role, "move_product", { productId, direction });
      return json({ ok: true });
    }

    if (action === "move_to_edge") {
      const productId = String(body.productId || "");
      const edge = String(body.edge || "");
      if (!productId || (edge !== "top" && edge !== "bottom")) return fail("Λανθασμένα δεδομένα");

      const { data: ownProduct } = await db.from("products").select("id").eq("id", productId).eq("shop_id", shopId).maybeSingle();
      if (!ownProduct) return fail("Το προϊόν δεν βρέθηκε", 404);

      const { data: edgeRow } = await db
        .from("products")
        .select("sort_order")
        .eq("shop_id", shopId)
        .order("sort_order", { ascending: edge === "top" })
        .limit(1)
        .single();
      if (!edgeRow) return fail("Αποτυχία αλλαγής σειράς", 500);

      const newOrder = edge === "top" ? edgeRow.sort_order - 1 : edgeRow.sort_order + 1;
      const { error } = await db.from("products").update({ sort_order: newOrder }).eq("id", productId);
      if (error) return fail("Αποτυχία αλλαγής σειράς", 500);
      await audit(shopId, role, "move_to_edge", { productId, edge });
      return json({ ok: true });
    }

    if (action === "reorder_products") {
      const orderedIds = Array.isArray(body.orderedIds) ? (body.orderedIds as unknown[]).map(String) : [];
      if (orderedIds.length === 0) return fail("Λανθασμένα δεδομένα");
      if (orderedIds.length > 500) return fail("Πάρα πολλά προϊόντα για μία ενέργεια", 400);

      for (let i = 0; i < orderedIds.length; i++) {
        await db.from("products").update({ sort_order: i * 1000 }).eq("id", orderedIds[i]).eq("shop_id", shopId);
      }
      await audit(shopId, role, "reorder_products", { count: orderedIds.length });
      return json({ ok: true });
    }

    if (action === "update_product") {
      const productId = String(body.productId || "");
      const name = String(body.name || "").trim();
      const par = Number(body.par);
      const price = body.price === null || body.price === undefined ? null : Number(body.price);
      const crateSize = body.crateSize === null || body.crateSize === undefined || body.crateSize === ""
        ? null
        : Number(body.crateSize);
      const { data: product } = await db.from("products").select("id, name, par, price").eq("id", productId).eq("shop_id", shopId).maybeSingle();
      if (!product) return fail("Το προϊόν δεν βρέθηκε", 404);
      if (!isNonEmptyString(name, 120)) return fail("Γράψε όνομα προϊόντος");
      if (!isNonNegInt(par)) return fail("Λανθασμένο όριο");
      if (price !== null && (isNaN(price) || price < 0 || price > 1000000)) return fail("Λανθασμένη τιμή");
      if (crateSize !== null && (!Number.isInteger(crateSize) || crateSize <= 0 || crateSize > 10000)) return fail("Λανθασμένα τεμάχια ανά κιβώτιο");

      const { error } = await db.from("products").update({ name, par, price, crate_size: crateSize, updated_at: new Date().toISOString() }).eq("id", productId);
      if (error) return fail("Αποτυχία αποθήκευσης", 500);
      await audit(shopId, role, "update_product", {
        productId, productName: product.name,
        parBefore: product.par, parAfter: par,
        priceBefore: product.price, priceAfter: price,
      });
      return json({ ok: true });
    }

    if (action === "update_photo") {
      const productId = String(body.productId || "");
      const photoBase64 = String(body.photoBase64 || "");
      const { data: product } = await db.from("products").select("id").eq("id", productId).eq("shop_id", shopId).maybeSingle();
      if (!product) return fail("Το προϊόν δεν βρέθηκε", 404);
      const path = await uploadPhoto(shopId, productId, photoBase64);
      if (!path) return fail("Αποτυχία αποθήκευσης φωτογραφίας", 500);
      await db.from("products").update({ photo_path: path }).eq("id", productId);
      const url = await signedPhotoUrl(path);
      await audit(shopId, role, "update_photo", { productId });
      return json({ ok: true, photoUrl: url });
    }

    if (action === "delete_product") {
      const productId = String(body.productId || "");
      const { data: product } = await db.from("products").select("id, photo_path").eq("id", productId).eq("shop_id", shopId).maybeSingle();
      if (!product) return fail("Το προϊόν δεν βρέθηκε", 404);
      if (product.photo_path) await db.storage.from("product-photos").remove([product.photo_path]);
      const { error } = await db.from("products").delete().eq("id", productId);
      if (error) return fail("Αποτυχία διαγραφής", 500);
      await audit(shopId, role, "delete_product", { productId });
      return json({ ok: true });
    }

    if (action === "update_shop_name") {
      const name = String(body.name || "").trim();
      if (!isNonEmptyString(name, 80)) return fail("Γράψε ένα όνομα");
      const { data: existing } = await db.from("shops").select("id").eq("name_key", nameKey(name)).neq("id", shopId).maybeSingle();
      if (existing) return fail("Το όνομα χρησιμοποιείται ήδη");
      const { error } = await db.from("shops").update({ name }).eq("id", shopId);
      if (error) return fail("Αποτυχία αποθήκευσης", 500);
      await audit(shopId, role, "update_shop_name", { name });
      return json({ ok: true });
    }

    if (action === "regenerate_viewer_code") {
      const newCode = randCode();
      const hash = await hashPassword(newCode);
      await db.from("sessions").delete().eq("shop_id", shopId).eq("role", "viewer");
      const { error } = await db.from("shops").update({ viewer_password_hash: hash }).eq("id", shopId);
      if (error) return fail("Αποτυχία αποθήκευσης", 500);
      await audit(shopId, role, "regenerate_viewer_code");
      return json({ ok: true, viewerPassword: newCode });
    }

    if (action === "backup") {
      const { data: shop } = await db.from("shops").select("id, name, created_at").eq("id", shopId).single();
      const { data: products } = await db.from("products").select("*").eq("shop_id", shopId);
      const { data: history } = await db.from("history").select("*").eq("shop_id", shopId);
      await audit(shopId, role, "backup");
      return json({ ok: true, shop, products, history });
    }

    if (action === "list_backups") {
      const { data } = await db
        .from("backups")
        .select("id, created_at")
        .eq("shop_id", shopId)
        .order("created_at", { ascending: false })
        .limit(14);
      return json({ ok: true, backups: data || [] });
    }

    if (action === "restore_backup") {
      const backupId = Number(body.backupId);
      if (!backupId) return fail("Λανθασμένο αίτημα");
      const { data: backupRow } = await db
        .from("backups")
        .select("snapshot")
        .eq("id", backupId)
        .eq("shop_id", shopId)
        .maybeSingle();
      if (!backupRow) return fail("Το αντίγραφο δεν βρέθηκε", 404);

      const snapshot = backupRow.snapshot as { products?: any[]; history?: any[] };
      const oldProducts = snapshot.products || [];
      const oldHistory = snapshot.history || [];

      await db.from("history").delete().eq("shop_id", shopId);
      await db.from("products").delete().eq("shop_id", shopId);

      const idMap = new Map<string, string>();
      for (const p of oldProducts) {
        const { data: newProd } = await db
          .from("products")
          .insert({
            shop_id: shopId,
            name: p.name,
            category: p.category,
            qty: p.qty,
            par: p.par,
            price: p.price,
            photo_path: p.photo_path || null,
            sort_order: typeof p.sort_order === "number" ? p.sort_order : Date.now(),
          })
          .select("id")
          .single();
        if (newProd) idMap.set(String(p.id), newProd.id);
      }
      for (const h of oldHistory) {
        await db.from("history").insert({
          shop_id: shopId,
          product_id: idMap.get(String(h.product_id)) || null,
          product_name: h.product_name,
          before: h.before,
          after: h.after,
          delta: h.delta,
          role: h.role,
          created_at: h.created_at || new Date().toISOString(),
        });
      }
      await audit(shopId, role, "restore_backup", { backupId });
      return json({ ok: true });
    }

    if (action === "delete_shop") {
      const { data: shopRow } = await db.from("shops").select("admin_password_hash").eq("id", shopId).maybeSingle();
      if (!shopRow) return fail("Το μαγαζί δεν βρέθηκε", 404);
      const confirmPassword = String(body.password || "");
      const passwordOk = await verifyPassword(confirmPassword, shopRow.admin_password_hash);
      if (!passwordOk) return fail("Λανθασμένος κωδικός — η διαγραφή ακυρώθηκε", 403);

      const { data: products } = await db.from("products").select("photo_path").eq("shop_id", shopId);
      const paths = (products || []).map((p) => p.photo_path).filter(Boolean) as string[];
      if (paths.length) await db.storage.from("product-photos").remove(paths);
      await audit(shopId, role, "delete_shop");
      const { error } = await db.from("shops").delete().eq("id", shopId);
      if (error) return fail("Αποτυχία διαγραφής", 500);
      return json({ ok: true });
    }

    if (action === "logout") {
      await db.from("sessions").delete().eq("token", String(body.token || ""));
      return json({ ok: true });
    }

    return fail("Άγνωστη ενέργεια", 400);
  } catch (e) {
    console.error("KAVUP api error:", e);
    return fail("Κάτι πήγε στραβά, δοκίμασε ξανά", 500);
  }
});
