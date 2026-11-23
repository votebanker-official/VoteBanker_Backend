const RANGES = new Set(["day", "week", "month", "year"]);
const SENSITIVE_KEY = /password|token|secret|otp|cvv|card|authorization/i;

function parseRange(value) {
  const range = String(value || "month").toLowerCase();
  return RANGES.has(range) ? range : "month";
}

function parsePage(query) {
  const source = query && typeof query === "object" ? query : {};
  const page = Math.max(1, Math.trunc(Number(source.page)) || 1);
  const pageSize = Math.min(50, Math.max(1, Math.trunc(Number(source.pageSize)) || 20));
  return { page, pageSize };
}

function safeSearch(value) {
  return String(value || "")
    .replace(/[%_,*()"/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function rangeStart(range, now = new Date()) {
  const start = new Date(now);
  if (range === "day") {
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (range === "week") {
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (range === "year") {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

function inRange(value, start, end) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  if (start && time < start.getTime()) return false;
  if (end && time > end.getTime()) return false;
  return true;
}

function paymentState(status, verified) {
  if (verified === true) return "successful";
  const value = String(status || "").toLowerCase();
  if (["paid", "successful", "success", "completed", "ready_to_publish", "published"].includes(value) && verified === true) {
    return "successful";
  }
  if (["refunded", "refund"].includes(value)) return "refunded";
  if (["failed", "cancelled", "canceled", "rejected"].includes(value)) return "failed";
  return "pending";
}

function websitePaymentState(website) {
  if (!website) return null;
  if (website.payment_verified === true) return "successful";
  if (website.status === "pending_payment") return "pending";
  return null;
}

function orderAmount(order) {
  const paise = Number(order && order.line_total_paise);
  if (Number.isFinite(paise) && paise > 0) return paise / 100;
  const amount = Number(order && (order.amount ?? order.final_amount));
  return Number.isFinite(amount) ? amount : 0;
}

function unitPrice(order) {
  const paise = Number(order && order.unit_price_paise);
  return Number.isFinite(paise) && paise > 0 ? paise / 100 : 0;
}

function slicePage(rows, page, pageSize) {
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total: rows.length,
    rows: rows.slice(start, start + pageSize),
  };
}

function bucketLabel(date, range) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  if (range === "day") return `${String(value.getHours()).padStart(2, "0")}:00`;
  if (range === "year") return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
  return value.toISOString().slice(0, 10);
}

function fillBuckets(range, now, totals) {
  const buckets = [];
  if (range === "day") {
    for (let hour = 0; hour < 24; hour += 1) {
      const label = `${String(hour).padStart(2, "0")}:00`;
      buckets.push({ label, value: totals.get(label) || 0 });
    }
    return buckets;
  }
  if (range === "year") {
    for (let month = 0; month < 12; month += 1) {
      const label = `${now.getFullYear()}-${String(month + 1).padStart(2, "0")}`;
      buckets.push({ label, value: totals.get(label) || 0 });
    }
    return buckets;
  }
  const start = rangeStart(range, now);
  const cursor = new Date(start);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    const label = cursor.toISOString().slice(0, 10);
    buckets.push({ label, value: totals.get(label) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

function series(rows, range, now, valueFor) {
  const totals = new Map();
  for (const row of rows) {
    const label = bucketLabel(row.created_at || row.createdAt, range);
    if (!label) continue;
    totals.set(label, (totals.get(label) || 0) + valueFor(row));
  }
  return fillBuckets(range, now, totals);
}

function isClient(profile) {
  return profile && profile.app_role !== "admin";
}

function matchesText(profile, term) {
  if (!term) return true;
  const haystack = [
    profile.full_name,
    profile.phone,
    profile.public_contact,
    profile.contact_email,
    profile.id,
    profile.designation,
    profile.assembly_constituency,
    profile.organization,
    profile.state_region,
    profile.constituency,
    profile.booth_name,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(term.toLowerCase());
}

function publicProfile(profile) {
  const source = profile && typeof profile === "object" ? profile : {};
  const additional = {};
  const extra = source.additional_profile;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (SENSITIVE_KEY.test(key)) continue;
      if (typeof value === "string") additional[key] = value.slice(0, 240);
      else if (typeof value === "number" || typeof value === "boolean") additional[key] = value;
    }
  }
  return {
    id: source.id,
    fullName: source.full_name || "",
    phone: source.phone || "",
    email: source.contact_email || "",
    publicContact: source.public_contact || "",
    designation: source.designation || "",
    assemblyConstituency: source.assembly_constituency || "",
    organization: source.organization || "",
    country: source.country || "",
    state: source.state_region || "",
    constituency: source.constituency || "",
    language: source.language || "",
    domain: source.selected_domain || "",
    boothNumber: source.booth_number || "",
    boothName: source.booth_name || "",
    role: source.app_role === "admin" ? "admin" : "client",
    status: source.account_status === "inactive" ? "inactive" : "active",
    createdAt: source.created_at || null,
    updatedAt: source.updated_at || null,
    lastLoginAt: source.last_login_at || null,
    additional,
  };
}

function roleChangeAllowed(target, nextRole, nextStatus, activeAdminCount) {
  const role = nextRole === "admin" ? "admin" : "client";
  const status = nextStatus === "inactive" ? "inactive" : "active";
  if (!target) return { error: "not_found", status: 404 };
  const wasActiveAdmin = target.app_role === "admin" && target.account_status !== "inactive";
  const staysActiveAdmin = role === "admin" && status === "active";
  if (wasActiveAdmin && !staysActiveAdmin && activeAdminCount <= 1) {
    return { error: "last_admin", status: 409 };
  }
  return { role, status };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  return lines.join("\r\n");
}

function compareText(left, right, direction) {
  const result = String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

function nameFor(profiles, id) {
  const profile = (profiles || []).find((item) => item.id === id);
  return profile ? profile.full_name || "" : "";
}

function profileById(profiles, id) {
  return (profiles || []).find((item) => item.id === id) || null;
}

function activityFeed(sources, query, now = new Date()) {
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || !item.createdAt) return;
    const key = item.dedupeKey || item.id;
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  const profiles = sources.profiles || [];

  for (const event of sources.events || []) {
    add({
      id: event.id,
      clientId: event.profile_id,
      clientName: nameFor(profiles, event.profile_id),
      type: event.event_type,
      description: event.description,
      createdAt: event.created_at,
      resourceType: event.resource_type || "",
      resourceId: event.resource_id || "",
      status: event.status || "recorded",
      dedupeKey: event.dedupe_key || event.id,
    });
  }
  for (const profile of profiles) {
    if (!isClient(profile)) continue;
    add({
      id: `registration:${profile.id}`,
      clientId: profile.id,
      clientName: profile.full_name || "",
      type: "registration",
      description: "Registered an account",
      createdAt: profile.created_at,
      resourceType: "profile",
      resourceId: profile.id,
      status: "recorded",
      dedupeKey: `registration:${profile.id}`,
    });
  }
  for (const order of sources.orders || []) {
    add({
      id: `purchase:${order.id}`,
      clientId: order.profile_id,
      clientName: nameFor(profiles, order.profile_id) || order.contact_name || "",
      type: "purchase",
      description: `Requested ${order.product_name || "merchandise"}`,
      createdAt: order.created_at,
      resourceType: "merchandise_order",
      resourceId: order.id,
      status: order.status || "requested",
      dedupeKey: `purchase:${order.id}`,
    });
  }
  for (const site of sources.websites || []) {
    add({
      id: `website:${site.id}`,
      clientId: site.user_id,
      clientName: nameFor(profiles, site.user_id),
      type: "campaign",
      description: `Website ${site.website_name || site.status || "draft"}`,
      createdAt: site.updated_at || site.created_at,
      resourceType: "website",
      resourceId: site.id,
      status: site.status || "draft",
      dedupeKey: `website:${site.id}:${site.updated_at || site.created_at}`,
    });
  }
  for (const row of sources.volunteerActivity || []) {
    add({
      id: `volunteer:${row.id}`,
      clientId: row.owner_user_id,
      clientName: nameFor(profiles, row.owner_user_id),
      type: "volunteers",
      description: row.detail ? `${row.action}: ${row.detail}` : row.action,
      createdAt: row.created_at,
      resourceType: "volunteer",
      resourceId: row.volunteer_id || row.id,
      status: "recorded",
      dedupeKey: `volunteer:${row.id}`,
    });
  }
  for (const member of sources.teamMembers || []) {
    add({
      id: `team:${member.id}`,
      clientId: member.owner_user_id,
      clientName: nameFor(profiles, member.owner_user_id),
      type: "team",
      description: `Team member ${member.full_name || "added"} (${member.role || "member"})`,
      createdAt: member.created_at,
      resourceType: "team_member",
      resourceId: member.id,
      status: member.status || "recorded",
      dedupeKey: `team:${member.id}`,
    });
  }

  const term = safeSearch(query && query.q).toLowerCase();
  const type = String((query && query.type) || "").trim().toLowerCase();
  const clientId = String((query && query.clientId) || "").trim();
  const start = query && query.from ? new Date(query.from) : null;
  const end = query && query.to ? new Date(query.to) : null;
  const filtered = items.filter((item) => {
    if (clientId && item.clientId !== clientId) return false;
    if (type && item.type !== type) return false;
    if (start && !inRange(item.createdAt, start, null)) return false;
    if (end && !inRange(item.createdAt, null, end)) return false;
    if (!term) return true;
    return `${item.clientName} ${item.type} ${item.description} ${item.status}`.toLowerCase().includes(term);
  });
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const page = parsePage(query);
  return { ...slicePage(filtered, page.page, page.pageSize), generatedAt: now.toISOString() };
}

function purchaseRecords(sources) {
  const profiles = sources.profiles || [];
  const rows = [];
  for (const order of sources.orders || []) {
    const profile = profileById(profiles, order.profile_id);
    const state = paymentState(order.status, false);
    const amount = orderAmount(order);
    rows.push({
      id: order.id,
      clientId: order.profile_id || "",
      clientName: order.contact_name || (profile && profile.full_name) || "",
      clientEmail: order.contact_email || (profile && profile.contact_email) || "",
      clientPhone: order.contact_phone || (profile && (profile.public_contact || profile.phone)) || "",
      product: order.product_name || "",
      productId: order.product_slug || "",
      purchasedAt: order.created_at,
      quantity: order.quantity || 1,
      unitPrice: unitPrice(order),
      amount,
      tax: Number(order.tax) || 0,
      discount: Number(order.discount) || 0,
      finalAmount: amount,
      paymentMethod: order.payment_method || "",
      paymentStatus: state,
      orderStatus: order.status || "requested",
      reference: order.id,
      source: "merchandise",
      currency: "INR",
    });
  }
  for (const site of sources.websites || []) {
    const state = websitePaymentState(site);
    if (!state) continue;
    const profile = profileById(profiles, site.user_id);
    rows.push({
      id: site.id,
      clientId: site.user_id || "",
      clientName: (profile && profile.full_name) || "",
      clientEmail: (profile && profile.contact_email) || "",
      clientPhone: (profile && (profile.public_contact || profile.phone)) || "",
      product: "Leader website",
      purchasedAt: site.updated_at || site.created_at,
      quantity: 1,
      amount: 0,
      tax: 0,
      discount: 0,
      finalAmount: 0,
      paymentMethod: "",
      paymentStatus: state,
      orderStatus: site.status || "",
      reference: site.id,
      source: "website",
      currency: "INR",
    });
  }
  return rows;
}

function filterPurchases(rows, query) {
  const term = safeSearch(query && query.q).toLowerCase();
  const clientId = String((query && query.clientId) || "").trim();
  const product = safeSearch(query && query.product).toLowerCase();
  const paymentStatus = String((query && query.paymentStatus) || "").trim().toLowerCase();
  const start = query && query.from ? new Date(query.from) : null;
  const end = query && query.to ? new Date(query.to) : null;
  return rows.filter((row) => {
    if (clientId && row.clientId !== clientId) return false;
    if (product && !String(row.product).toLowerCase().includes(product)) return false;
    if (paymentStatus && row.paymentStatus !== paymentStatus) return false;
    if (start && !inRange(row.purchasedAt, start, null)) return false;
    if (end && !inRange(row.purchasedAt, null, end)) return false;
    if (!term) return true;
    return `${row.clientName} ${row.clientEmail} ${row.clientPhone || ""} ${row.product} ${row.reference} ${row.orderStatus}`
      .toLowerCase()
      .includes(term);
  });
}

function campaignRecords(sources) {
  const profiles = sources.profiles || [];
  const rows = [];
  for (const site of sources.websites || []) {
    rows.push({
      id: site.id,
      ownerId: site.user_id || "",
      ownerName: nameFor(profiles, site.user_id),
      name: site.website_name || "Leader website",
      kind: "website",
      status: site.status || "draft",
      createdAt: site.created_at,
      updatedAt: site.updated_at || site.created_at,
      publishedAt: site.published_at || null,
      paymentVerified: site.payment_verified === true,
    });
  }
  for (const order of sources.orders || []) {
    rows.push({
      id: order.id,
      ownerId: order.profile_id || "",
      ownerName: nameFor(profiles, order.profile_id) || order.contact_name || "",
      name: order.campaign_line || order.product_name || "Merchandise",
      kind: "merchandise",
      status: order.status || "requested",
      createdAt: order.created_at,
      updatedAt: order.created_at,
      publishedAt: null,
      paymentVerified: false,
    });
  }
  return rows;
}

function summarize(snapshot, range, now = new Date()) {
  const selected = parseRange(range);
  const start = rangeStart(selected, now);
  const profiles = snapshot.profiles || [];
  const clients = profiles.filter(isClient);
  const orders = (snapshot.orders || []).filter((order) => inRange(order.created_at, start, now));
  const sites = snapshot.websites || [];
  const periodSites = sites.filter((site) => inRange(site.created_at || site.updated_at, start, now));
  const purchases = filterPurchases(purchaseRecords({ profiles, orders, websites: periodSites }), {});
  const payments = {
    successful: purchases.filter((row) => row.paymentStatus === "successful").length,
    pending: purchases.filter((row) => row.paymentStatus === "pending").length,
    failed: purchases.filter((row) => row.paymentStatus === "failed").length,
    refunded: purchases.filter((row) => row.paymentStatus === "refunded").length,
  };
  const revenue = purchases.reduce((sum, row) => sum + (Number(row.finalAmount) || 0), 0);
  const registrations = clients.filter((profile) => inRange(profile.created_at, start, now));
  const activeCampaigns = periodSites.filter((site) =>
    ["published", "ready_to_publish"].includes(site.status),
  ).length;
  const recentActivity = activityFeed(snapshot, { page: 1, pageSize: 8 }, now).rows;
  const recentPurchases = filterPurchases(purchaseRecords(snapshot), {})
    .sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt))
    .slice(0, 8);
  return {
    range: selected,
    from: start.toISOString(),
    to: now.toISOString(),
    currency: "INR",
    revenueNote:
      "Revenue is the sum of amounts stored on purchase records. Merchandise and website rows do not store card data or a verified charge amount, so this total stays at 0 until a payment record includes an amount.",
    cards: {
      totalClients: clients.length,
      activeClients: clients.filter((profile) => profile.account_status !== "inactive").length,
      inactiveClients: clients.filter((profile) => profile.account_status === "inactive").length,
      newRegistrations: registrations.length,
      totalPurchases: purchases.length,
      totalRevenue: revenue,
      pendingPayments: payments.pending,
      successfulPayments: payments.successful,
      failedPayments: payments.failed,
      refundedPayments: payments.refunded,
      activeCampaigns,
    },
    registrationSeries: series(registrations, selected, now, () => 1),
    revenueSeries: series(
      purchases.map((row) => ({ created_at: row.purchasedAt, amount: row.finalAmount })),
      selected,
      now,
      (row) => Number(row.amount) || 0,
    ),
    recentRegistrations: [...registrations]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 8)
      .map(publicProfile),
    recentPurchases,
    recentTransactions: recentPurchases,
    recentActivities: recentActivity,
  };
}

module.exports = {
  parseRange,
  parsePage,
  safeSearch,
  rangeStart,
  inRange,
  paymentState,
  websitePaymentState,
  orderAmount,
  slicePage,
  series,
  isClient,
  matchesText,
  publicProfile,
  roleChangeAllowed,
  toCsv,
  compareText,
  activityFeed,
  purchaseRecords,
  filterPurchases,
  campaignRecords,
  summarize,
};
