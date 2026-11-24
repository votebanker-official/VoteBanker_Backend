const { getSupabaseAdmin } = require("../lib/clients");
const { emailFromUser, isListedAdmin, isUuid, phoneFromUser } = require("./access");
const {
  parseRange,
  parsePage,
  safeSearch,
  rangeStart,
  publicProfile,
  roleChangeAllowed,
  toCsv,
  activityFeed,
  purchaseRecords,
  filterPurchases,
  campaignRecords,
  summarize,
  compareText,
  slicePage,
  series,
} = require("./logic");

const PROFILE_FIELDS =
  "id, full_name, phone, contact_email, public_contact, designation, assembly_constituency, organization, country, state_region, constituency, language, selected_domain, booth_number, booth_name, app_role, account_status, created_at, updated_at, last_login_at, additional_profile";

function schemaError(error) {
  const code = error && error.code;
  const message = (error && error.message) || "";
  if (code === "42P01" || code === "42703" || code === "PGRST205" || /does not exist|schema cache/i.test(message)) {
    const err = new Error("admin_not_ready");
    err.code = "admin_not_ready";
    return err;
  }
  return error;
}

function db() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    const err = new Error("admin_not_ready");
    err.code = "admin_not_ready";
    throw err;
  }
  return getSupabaseAdmin();
}

async function readRows(builder) {
  const { data, error, count } = await builder;
  if (error) throw schemaError(error);
  return { rows: data || [], count: count || 0 };
}

function createMemoryRepository(seed = {}) {
  const state = {
    profiles: [...(seed.profiles || [])],
    orders: [...(seed.orders || [])],
    websites: [...(seed.websites || [])],
    events: [...(seed.events || [])],
    audits: [...(seed.audits || [])],
    volunteerActivity: [...(seed.volunteerActivity || [])],
    teamMembers: [...(seed.teamMembers || [])],
    volunteers: [...(seed.volunteers || [])],
    voters: [...(seed.voters || [])],
  };

  function snapshot() {
    return state;
  }

  return {
    async accessFor(user) {
      const profile = state.profiles.find((item) => item.id === user.id) || null;
      if (isListedAdmin(user) && profile && profile.app_role !== "admin") {
        profile.app_role = "admin";
        profile.account_status = profile.account_status || "active";
        const email = emailFromUser(user);
        if (email) profile.contact_email = email;
      }
      const admin =
        isListedAdmin(user) ||
        Boolean(profile && profile.app_role === "admin" && profile.account_status !== "inactive");
      return { admin, profile };
    },
    async overview(range) {
      return summarize(snapshot(), range);
    },
    async listClients(query) {
      return listPeople(state.profiles.filter((profile) => profile.app_role !== "admin"), query);
    },
    async listLeaderProfiles(query) {
      const listed = listPeople(state.profiles, query);
      return {
        page: listed.page,
        pageSize: listed.pageSize,
        total: listed.total,
        profiles: listed.clients,
      };
    },
    async getClient(id) {
      const profile = state.profiles.find((item) => item.id === id);
      if (!profile || profile.app_role === "admin") return null;
      const owned = (rows, key) => rows.filter((row) => row[key] === id);
      const activity = activityFeed(snapshot(), { clientId: id, page: 1, pageSize: 50 });
      return {
        profile: publicProfile(profile),
        engagement: {
          purchases: state.orders.filter((row) => row.profile_id === id).length,
          campaigns: state.websites.filter((row) => row.user_id === id).length,
          teamMembers: owned(state.teamMembers, "owner_user_id").length,
          volunteers: owned(state.volunteers, "owner_user_id").length,
          voterRecords: owned(state.voters, "owner_user_id").length,
          activities: activity.total,
        },
        activity: activity.rows,
        purchases: filterPurchases(purchaseRecords(snapshot()), { clientId: id }),
        campaigns: campaignRecords(snapshot()).filter((row) => row.ownerId === id),
      };
    },
    async listActivity(query) {
      return activityFeed(snapshot(), query);
    },
    async listPurchases(query) {
      const page = parsePage(query);
      const rows = filterPurchases(purchaseRecords(snapshot()), query).sort(
        (a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt),
      );
      return { ...slicePage(rows, page.page, page.pageSize), summary: paymentSummary(rows) };
    },
    async listPayments(query) {
      return this.listPurchases(query);
    },
    async listCampaigns(query) {
      const page = parsePage(query);
      const term = safeSearch(query && query.q).toLowerCase();
      const status = String((query && query.status) || "").trim().toLowerCase();
      let rows = campaignRecords(snapshot());
      if (status) rows = rows.filter((row) => String(row.status).toLowerCase() === status);
      if (term) {
        rows = rows.filter((row) => `${row.name} ${row.ownerName} ${row.kind}`.toLowerCase().includes(term));
      }
      rows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return slicePage(rows, page.page, page.pageSize);
    },
    async listUsers(query) {
      return listPeople(state.profiles, query);
    },
    async updateUser(actor, id, patch) {
      const target = state.profiles.find((item) => item.id === id);
      const activeAdmins = state.profiles.filter(
        (item) => item.app_role === "admin" && item.account_status !== "inactive",
      ).length;
      const next = roleChangeAllowed(
        target,
        patch.app_role || (target && target.app_role),
        patch.account_status || (target && target.account_status),
        activeAdmins,
      );
      if (next.error) {
        state.audits.unshift(auditRow(actor, "update_user", id, "rejected", next.error));
        const err = new Error(next.error);
        err.code = next.error;
        err.status = next.status;
        throw err;
      }
      target.app_role = next.role;
      target.account_status = next.status;
      state.audits.unshift(auditRow(actor, "update_user", id, "recorded", `${next.role}/${next.status}`));
      return publicProfile(target);
    },
    async listAudit(query) {
      const page = parsePage(query);
      const rows = state.audits.map(publicAudit);
      return slicePage(rows, page.page, page.pageSize);
    },
    async report(kind, query) {
      const overview = summarize(snapshot(), query && query.range);
      if (kind === "clients") return { kind, columns: clientCsvColumns(), rows: clientCsvRows(state.profiles) };
      if (kind === "profiles") return { kind, columns: profileCsvColumns(), rows: state.profiles.map(publicProfile) };
      if (kind === "purchases" || kind === "revenue") {
        return { kind, columns: purchaseCsvColumns(), rows: filterPurchases(purchaseRecords(snapshot()), query) };
      }
      if (kind === "campaigns") return { kind, columns: ["id", "ownerName", "name", "kind", "status", "createdAt", "updatedAt"], rows: campaignRecords(snapshot()) };
      if (kind === "engagement") {
        return { kind, columns: ["type", "description", "clientName", "createdAt", "status"], rows: activityFeed(snapshot(), { page: 1, pageSize: 500 }).rows };
      }
      return { kind: "overview", columns: ["metric", "value"], rows: metricRows(overview.cards), overview };
    },
  };
}

function listPeople(profiles, query) {
  const page = parsePage(query);
  const term = safeSearch(query && query.q).toLowerCase();
  const status = query && (query.status === "active" || query.status === "inactive") ? query.status : "";
  const role = query && (query.role === "admin" || query.role === "client") ? query.role : "";
  const sort = ["full_name", "created_at", "last_login_at", "account_status"].includes(query && query.sort)
    ? query.sort
    : "created_at";
  const direction = query && query.direction === "asc" ? "asc" : "desc";
  let rows = profiles.filter((profile) => {
    if (status && (profile.account_status === "inactive" ? "inactive" : "active") !== status) return false;
    if (role && (profile.app_role === "admin" ? "admin" : "client") !== role) return false;
    if (query && query.from && new Date(profile.created_at) < new Date(query.from)) return false;
    if (query && query.to && new Date(profile.created_at) > new Date(query.to)) return false;
    if (!term) return true;
    return `${profile.full_name} ${profile.phone} ${profile.public_contact} ${profile.contact_email} ${profile.organization} ${profile.designation} ${profile.assembly_constituency} ${profile.state_region} ${profile.constituency} ${profile.booth_name} ${profile.id}`
      .toLowerCase()
      .includes(term);
  });
  rows.sort((a, b) => compareText(a[sort], b[sort], direction));
  if (sort === "created_at" || sort === "last_login_at") {
    rows.sort((a, b) => {
      const delta = new Date(a[sort] || 0) - new Date(b[sort] || 0);
      return direction === "asc" ? delta : -delta;
    });
  }
  const paged = slicePage(rows, page.page, page.pageSize);
  return { ...paged, clients: paged.rows.map(publicProfile), users: paged.rows.map(publicProfile) };
}

function auditRow(actor, action, targetId, outcome, detail) {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    admin_id: actor && actor.id,
    action,
    target_type: "profile",
    target_id: targetId,
    outcome,
    detail,
    created_at: new Date().toISOString(),
  };
}

function publicAudit(row) {
  return {
    id: row.id,
    adminId: row.admin_id || "",
    action: row.action,
    targetType: row.target_type || "",
    targetId: row.target_id || "",
    outcome: row.outcome,
    detail: row.detail || "",
    createdAt: row.created_at,
  };
}

function clientCsvColumns() {
  return ["id", "fullName", "phone", "email", "status", "role", "createdAt", "lastLoginAt"];
}

function profileCsvColumns() {
  return [
    "id",
    "fullName",
    "phone",
    "email",
    "publicContact",
    "organization",
    "designation",
    "assemblyConstituency",
    "country",
    "state",
    "constituency",
    "boothNumber",
    "boothName",
    "updatedAt",
  ];
}

function clientCsvRows(profiles) {
  return profiles.map(publicProfile);
}

function purchaseCsvColumns() {
  return ["id", "clientName", "clientEmail", "clientPhone", "product", "purchasedAt", "quantity", "unitPrice", "amount", "tax", "discount", "finalAmount", "paymentMethod", "paymentStatus", "orderStatus", "reference", "currency"];
}

function paymentSummary(rows) {
  return {
    successful: rows.filter((row) => row.paymentStatus === "successful").length,
    pending: rows.filter((row) => row.paymentStatus === "pending").length,
    failed: rows.filter((row) => row.paymentStatus === "failed").length,
    refunded: rows.filter((row) => row.paymentStatus === "refunded").length,
    revenue: rows.reduce((sum, row) => sum + (Number(row.finalAmount) || 0), 0),
    currency: "INR",
  };
}

function metricRows(cards) {
  return Object.entries(cards).map(([metric, value]) => ({ metric, value }));
}

function createSupabaseRepository() {
  return {
    async accessFor(user) {
      const bootstrap = isListedAdmin(user);
      const phone = phoneFromUser(user);
      if (!isUuid(user.id)) {
        if (process.env.OTP_PROVIDER === "demo") {
          const demo = await loadDemoProfile(phone);
          const role = demo && demo.app_role === "admin" ? "admin" : "client";
          if (bootstrap && demo) {
            demo.app_role = "admin";
            await saveDemoRole(phone, "admin");
          }
          return { admin: role === "admin" || Boolean(bootstrap && demo), profile: demo };
        }
        return { admin: false, profile: null };
      }
      let profile;
      try {
        profile = await loadAccessProfile(user.id);
      } catch (err) {
        if (bootstrap) {
          console.error(`allow-listed admin profile lookup failed: ${err.message || err}`);
          return { admin: true, degraded: true, profile: null };
        }
        if (err.code === "admin_not_ready") {
          const forbidden = new Error("forbidden");
          forbidden.code = "forbidden";
          throw forbidden;
        }
        throw err;
      }
      if (bootstrap && profile && profile.app_role !== "admin") {
        const email = emailFromUser(user);
        const patch = { app_role: "admin", account_status: "active" };
        if (email) patch.contact_email = email;
        const { error } = await db().from("profiles").update(patch).eq("id", user.id);
        if (!error) {
          profile.app_role = "admin";
          profile.account_status = "active";
          if (email) profile.contact_email = email;
        } else {
          console.error(`allow-listed admin promotion failed: ${error.message || error}`);
        }
      }
      const admin =
        bootstrap ||
        Boolean(profile && profile.app_role === "admin" && profile.account_status !== "inactive");
      return { admin, profile };
    },
    async overview(range) {
      const selected = parseRange(range);
      const since = rangeStart(selected).toISOString();
      const [totalClients, activeClients, inactiveClients, newRegistrations, registrationTimes, orders, websites, recentProfiles, recentOrders, recentEvents] =
        await Promise.all([
          countWhere("profiles", (q) => q.eq("app_role", "client")),
          countWhere("profiles", (q) => q.eq("app_role", "client").eq("account_status", "active")),
          countWhere("profiles", (q) => q.eq("app_role", "client").eq("account_status", "inactive")),
          countWhere("profiles", (q) => q.eq("app_role", "client").gte("created_at", since)),
          selectLimited("profiles", "created_at", (q) => q.eq("app_role", "client").gte("created_at", since)),
          selectLimited(
            "merchandise_orders",
            "id, profile_id, product_slug, product_name, quantity, status, created_at, contact_name, contact_phone, contact_email, unit_price_paise, line_total_paise, campaign_line",
            (q) => q.gte("created_at", since),
          ),
          selectLimited(
            "websites",
            "id, user_id, website_name, status, payment_verified, created_at, updated_at, published_at",
            (q) => q.gte("created_at", since),
          ),
          selectLimited("profiles", PROFILE_FIELDS, (q) => q.eq("app_role", "client").order("created_at", { ascending: false }), 8),
          selectLimited(
            "merchandise_orders",
            "id, profile_id, product_slug, product_name, quantity, status, created_at, contact_name, contact_phone, contact_email, unit_price_paise, line_total_paise, campaign_line",
            (q) => q.order("created_at", { ascending: false }),
            8,
          ),
          selectLimited(
            "activity_events",
            "id, profile_id, event_type, description, resource_type, resource_id, status, dedupe_key, created_at",
            (q) => q.order("created_at", { ascending: false }),
            8,
          ),
        ]);
      const names = await profilesByIds([
        ...orders.rows.map((row) => row.profile_id),
        ...websites.rows.map((row) => row.user_id),
        ...recentOrders.rows.map((row) => row.profile_id),
        ...recentEvents.rows.map((row) => row.profile_id),
      ]);
      const purchases = filterPurchases(
        purchaseRecords({ profiles: names, orders: orders.rows, websites: websites.rows }),
        {},
      );
      const revenue = purchases.reduce((sum, row) => sum + (Number(row.finalAmount) || 0), 0);
      const recentPurchaseRows = filterPurchases(
        purchaseRecords({ profiles: names, orders: recentOrders.rows, websites: [] }),
        {},
      );
      return {
        range: selected,
        from: since,
        to: new Date().toISOString(),
        currency: "INR",
        truncated: orders.truncated || websites.truncated || registrationTimes.truncated,
        revenueNote:
          "Revenue is the sum of amounts stored on purchase records. Merchandise and website rows do not store card data or a verified charge amount, so this total stays at 0 until a payment record includes an amount.",
        cards: {
          totalClients,
          activeClients,
          inactiveClients,
          newRegistrations,
          totalPurchases: purchases.length,
          totalRevenue: revenue,
          pendingPayments: purchases.filter((row) => row.paymentStatus === "pending").length,
          successfulPayments: purchases.filter((row) => row.paymentStatus === "successful").length,
          failedPayments: purchases.filter((row) => row.paymentStatus === "failed").length,
          refundedPayments: purchases.filter((row) => row.paymentStatus === "refunded").length,
          activeCampaigns: websites.rows.filter((site) => ["published", "ready_to_publish"].includes(site.status)).length,
        },
        registrationSeries: series(registrationTimes.rows, selected, new Date(), () => 1),
        revenueSeries: series(
          purchases.map((row) => ({ created_at: row.purchasedAt, amount: row.finalAmount })),
          selected,
          new Date(),
          (row) => Number(row.amount) || 0,
        ),
        recentRegistrations: recentProfiles.rows.map(publicProfile),
        recentPurchases: recentPurchaseRows,
        recentTransactions: recentPurchaseRows,
        recentActivities: activityFeed(
          {
            profiles: [...names, ...recentProfiles.rows],
            events: recentEvents.rows,
            orders: recentOrders.rows,
            websites: [],
            volunteerActivity: [],
            teamMembers: [],
          },
          { page: 1, pageSize: 8 },
        ).rows,
      };
    },
    async listClients(query) {
      return listProfiles(query, true);
    },
    async listLeaderProfiles(query) {
      const listed = await listProfiles(query, false);
      return {
        page: listed.page,
        pageSize: listed.pageSize,
        total: listed.total,
        profiles: listed.clients,
      };
    },
    async getClient(id) {
      if (!isUuid(id)) return null;
      const profile = await loadProfile(id);
      if (!profile || profile.app_role === "admin") return null;
      const [orders, websites, team, volunteers, voters, events, volunteerActivity] = await Promise.all([
        selectLimited("merchandise_orders", "id, profile_id, product_slug, product_name, quantity, status, created_at, contact_name, contact_phone, contact_email, unit_price_paise, line_total_paise, campaign_line", (q) => q.eq("profile_id", id), 200),
        selectLimited("websites", "id, user_id, website_name, status, payment_verified, created_at, updated_at, published_at", (q) => q.eq("user_id", id), 20),
        countWhere("team_members", (q) => q.eq("owner_user_id", id)),
        countWhere("volunteers", (q) => q.eq("owner_user_id", id)),
        countWhere("vrm_voter_records", (q) => q.eq("owner_user_id", id)),
        selectLimited("activity_events", "id, profile_id, event_type, description, resource_type, resource_id, status, dedupe_key, created_at", (q) => q.eq("profile_id", id), 200),
        selectLimited("volunteer_activity", "id, owner_user_id, volunteer_id, action, detail, created_at", (q) => q.eq("owner_user_id", id), 200),
      ]);
      const teamRows = await selectLimited("team_members", "id, owner_user_id, full_name, role, status, created_at", (q) => q.eq("owner_user_id", id), 200);
      const feed = activityFeed(
        {
          profiles: [profile],
          events: events.rows,
          orders: orders.rows,
          websites: websites.rows,
          volunteerActivity: volunteerActivity.rows,
          teamMembers: teamRows.rows,
        },
        { clientId: id, page: 1, pageSize: 50 },
      );
      const snapshot = { profiles: [profile], orders: orders.rows, websites: websites.rows };
      return {
        profile: publicProfile(profile),
        engagement: {
          purchases: orders.count || orders.rows.length,
          campaigns: websites.rows.length,
          teamMembers: team,
          volunteers,
          voterRecords: voters,
          activities: feed.total,
        },
        activity: feed.rows,
        purchases: filterPurchases(purchaseRecords(snapshot), { clientId: id }),
        campaigns: campaignRecords(snapshot).filter((row) => row.ownerId === id),
      };
    },
    async listActivity(query) {
      const [profiles, events, orders, websites, volunteerActivity, teamMembers] = await Promise.all([
        selectLimited("profiles", "id, full_name, app_role, created_at", (q) => q.order("created_at", { ascending: false }), 300),
        selectLimited("activity_events", "id, profile_id, event_type, description, resource_type, resource_id, status, dedupe_key, created_at", (q) => q.order("created_at", { ascending: false }), 300),
        selectLimited("merchandise_orders", "id, profile_id, product_name, status, created_at, contact_name", (q) => q.order("created_at", { ascending: false }), 300),
        selectLimited("websites", "id, user_id, website_name, status, created_at, updated_at", (q) => q.order("updated_at", { ascending: false }), 300),
        selectLimited("volunteer_activity", "id, owner_user_id, volunteer_id, action, detail, created_at", (q) => q.order("created_at", { ascending: false }), 300),
        selectLimited("team_members", "id, owner_user_id, full_name, role, status, created_at", (q) => q.order("created_at", { ascending: false }), 300),
      ]);
      const feed = activityFeed(
        { profiles: profiles.rows, events: events.rows, orders: orders.rows, websites: websites.rows, volunteerActivity: volunteerActivity.rows, teamMembers: teamMembers.rows },
        query,
      );
      feed.truncated = [profiles, events, orders, websites, volunteerActivity, teamMembers].some((item) => item.truncated);
      return feed;
    },
    async listPurchases(query) {
      const loaded = await loadCommerce();
      const page = parsePage(query);
      const rows = filterPurchases(purchaseRecords(loaded), query).sort(
        (a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt),
      );
      return { ...slicePage(rows, page.page, page.pageSize), truncated: loaded.truncated, summary: paymentSummary(rows) };
    },
    async listPayments(query) {
      return this.listPurchases(query);
    },
    async listCampaigns(query) {
      const loaded = await loadCommerce();
      const page = parsePage(query);
      const term = safeSearch(query && query.q).toLowerCase();
      const status = String((query && query.status) || "").trim().toLowerCase();
      let rows = campaignRecords(loaded);
      if (status) rows = rows.filter((row) => String(row.status).toLowerCase() === status);
      if (term) rows = rows.filter((row) => `${row.name} ${row.ownerName} ${row.kind}`.toLowerCase().includes(term));
      rows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return { ...slicePage(rows, page.page, page.pageSize), truncated: loaded.truncated };
    },
    async listUsers(query) {
      return listProfiles(query, false);
    },
    async updateUser(actor, id, patch) {
      if (!isUuid(id)) {
        const err = new Error("not_found");
        err.code = "not_found";
        err.status = 404;
        throw err;
      }
      const target = await loadProfile(id);
      const activeAdmins = await countWhere("profiles", (q) => q.eq("app_role", "admin").eq("account_status", "active"));
      const next = roleChangeAllowed(
        target,
        patch.app_role || (target && target.app_role),
        patch.account_status || (target && target.account_status),
        activeAdmins,
      );
      if (next.error) {
        await writeAudit(actor, id, "rejected", next.error);
        const err = new Error(next.error);
        err.code = next.error;
        err.status = next.status;
        throw err;
      }
      const { data, error } = await db()
        .from("profiles")
        .update({ app_role: next.role, account_status: next.status })
        .eq("id", id)
        .select(PROFILE_FIELDS)
        .single();
      if (error) throw schemaError(error);
      await writeAudit(actor, id, "recorded", `${next.role}/${next.status}`);
      return publicProfile(data);
    },
    async listAudit(query) {
      const page = parsePage(query);
      const from = (page.page - 1) * page.pageSize;
      const { rows, count } = await readRows(
        db()
          .from("admin_audit_logs")
          .select("id, admin_id, action, target_type, target_id, outcome, detail, created_at", { count: "exact" })
          .order("created_at", { ascending: false })
          .range(from, from + page.pageSize - 1),
      );
      return { page: page.page, pageSize: page.pageSize, total: count, rows: rows.map(publicAudit) };
    },
    async report(kind, query) {
      if (kind === "clients") {
        const people = await selectLimited("profiles", PROFILE_FIELDS, (q) => q.order("created_at", { ascending: false }), 1000);
        return { kind, columns: clientCsvColumns(), rows: people.rows.map(publicProfile), truncated: people.truncated };
      }
      if (kind === "profiles") {
        const people = await selectLimited("profiles", PROFILE_FIELDS, (q) => q.order("updated_at", { ascending: false }), 1000);
        return { kind, columns: profileCsvColumns(), rows: people.rows.map(publicProfile), truncated: people.truncated };
      }
      if (kind === "purchases" || kind === "revenue") {
        const loaded = await loadCommerce();
        return { kind, columns: purchaseCsvColumns(), rows: filterPurchases(purchaseRecords(loaded), query), truncated: loaded.truncated };
      }
      if (kind === "campaigns") {
        const loaded = await loadCommerce();
        return {
          kind,
          columns: ["id", "ownerName", "name", "kind", "status", "createdAt", "updatedAt"],
          rows: campaignRecords(loaded),
          truncated: loaded.truncated,
        };
      }
      if (kind === "engagement") {
        const feed = await this.listActivity({ ...(query || {}), page: 1, pageSize: 500 });
        return {
          kind,
          columns: ["type", "description", "clientName", "createdAt", "status"],
          rows: feed.rows,
          truncated: feed.truncated,
        };
      }
      const overview = await this.overview(query && query.range);
      return { kind: "overview", columns: ["metric", "value"], rows: metricRows(overview.cards), overview };
    },
  };
}

async function listProfiles(query, clientsOnly) {
  const page = parsePage(query);
  const term = safeSearch(query && query.q);
  const status = query && (query.status === "active" || query.status === "inactive") ? query.status : "";
  const role = query && (query.role === "admin" || query.role === "client") ? query.role : "";
  const sort = ["full_name", "created_at", "last_login_at", "account_status"].includes(query && query.sort)
    ? query.sort
    : "created_at";
  const ascending = query && query.direction === "asc";
  let request = db().from("profiles").select(PROFILE_FIELDS, { count: "exact" });
  if (clientsOnly) request = request.eq("app_role", "client");
  if (!clientsOnly && role) request = request.eq("app_role", role);
  if (status) request = request.eq("account_status", status);
  if (query && query.from) request = request.gte("created_at", query.from);
  if (query && query.to) request = request.lte("created_at", query.to);
  if (term) {
    const pattern = `"%${term}%"`;
    request = request.or(
      `full_name.ilike.${pattern},phone.ilike.${pattern},public_contact.ilike.${pattern},contact_email.ilike.${pattern},organization.ilike.${pattern},designation.ilike.${pattern},assembly_constituency.ilike.${pattern},state_region.ilike.${pattern},constituency.ilike.${pattern},booth_name.ilike.${pattern}`,
    );
  }
  const from = (page.page - 1) * page.pageSize;
  const { rows, count } = await readRows(
    request.order(sort, { ascending }).range(from, from + page.pageSize - 1),
  );
  const people = rows.map(publicProfile);
  return { page: page.page, pageSize: page.pageSize, total: count, rows: people, clients: people, users: people };
}

async function loadAccessProfile(id) {
  const { data, error } = await db()
    .from("profiles")
    .select("id, full_name, app_role, account_status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw schemaError(error);
  return data;
}

async function loadProfile(id) {
  const { data, error } = await db().from("profiles").select(PROFILE_FIELDS).eq("id", id).maybeSingle();
  if (error) throw schemaError(error);
  return data;
}

async function loadDemoProfile(phone) {
  if (!phone || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return null;
  const { data, error } = await db().from("demo_accounts").select("phone, profile, created_at").eq("phone", phone).maybeSingle();
  if (error) return null;
  if (!data) return null;
  const profile = data.profile && typeof data.profile === "object" ? data.profile : {};
  return {
    id: phone,
    full_name: profile.full_name || "",
    phone,
    app_role: profile.app_role === "admin" ? "admin" : "client",
    account_status: profile.account_status === "inactive" ? "inactive" : "active",
    created_at: data.created_at,
  };
}

async function saveDemoRole(phone, role) {
  const current = await loadDemoProfile(phone);
  if (!current) return;
  const { data } = await db().from("demo_accounts").select("profile").eq("phone", phone).maybeSingle();
  const profile = data && data.profile && typeof data.profile === "object" ? { ...data.profile } : {};
  profile.app_role = role;
  await db().from("demo_accounts").update({ profile }).eq("phone", phone);
}

async function countWhere(table, apply) {
  let request = db().from(table).select("id", { count: "exact", head: true });
  request = apply(request);
  const { count, error } = await request;
  if (error) throw schemaError(error);
  return count || 0;
}

async function selectLimited(table, fields, apply, limit = 1000) {
  let request = db().from(table).select(fields);
  request = apply(request);
  const { data, error } = await request.limit(limit);
  if (error) throw schemaError(error);
  const rows = data || [];
  return { rows, truncated: rows.length >= limit, count: rows.length };
}

async function profilesByIds(ids) {
  const unique = [...new Set(ids.filter(isUuid))];
  if (unique.length === 0) return [];
  const { data, error } = await db().from("profiles").select("id, full_name, contact_email, app_role, created_at").in("id", unique.slice(0, 200));
  if (error) throw schemaError(error);
  return data || [];
}

async function loadCommerce() {
  const [profiles, orders, websites] = await Promise.all([
    selectLimited("profiles", "id, full_name, contact_email, app_role, created_at", (q) => q, 1000),
    selectLimited(
      "merchandise_orders",
      "id, profile_id, product_slug, product_name, quantity, status, created_at, contact_name, contact_phone, contact_email, unit_price_paise, line_total_paise, campaign_line",
      (q) => q.order("created_at", { ascending: false }),
      1000,
    ),
    selectLimited(
      "websites",
      "id, user_id, website_name, status, payment_verified, created_at, updated_at, published_at",
      (q) => q.order("updated_at", { ascending: false }),
      1000,
    ),
  ]);
  return {
    profiles: profiles.rows,
    orders: orders.rows,
    websites: websites.rows,
    truncated: profiles.truncated || orders.truncated || websites.truncated,
  };
}

async function writeAudit(actor, targetId, outcome, detail) {
  try {
    const { error } = await db().from("admin_audit_logs").insert({
      admin_id: actor && isUuid(actor.id) ? actor.id : null,
      action: "update_user",
      target_type: "profile",
      target_id: String(targetId || "").slice(0, 80),
      outcome,
      detail: String(detail || "").slice(0, 400),
    });
    if (error) console.error(`audit log skipped: ${error.code || error.message}`);
  } catch (err) {
    console.error(`audit log skipped: ${err.message || err}`);
  }
}

function csvFor(report) {
  return toCsv(report.columns, report.rows);
}

module.exports = {
  createMemoryRepository,
  createSupabaseRepository,
  csvFor,
  schemaError,
};
