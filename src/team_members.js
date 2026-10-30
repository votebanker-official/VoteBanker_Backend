const express = require("express");

const ROLES = [
  "Campaign Manager",
  "Coordinator",
  "Field Lead",
  "Content Manager",
  "Data Analyst",
  "Member",
];

const PERMISSIONS = [
  "View dashboard",
  "Manage voters",
  "Manage volunteers",
  "Manage content",
  "Manage events",
  "Full access",
];

const STATUSES = ["active", "inactive", "pending"];

function createTeamMembersRouter(options = {}) {
  const router = express.Router();
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL || "";
  const secretKey = options.secretKey || process.env.SUPABASE_SECRET_KEY || "";
  const publishableKey = options.publishableKey || process.env.SUPABASE_PUBLISHABLE_KEY || "";
  const fetchImpl = options.fetchImpl || fetch;
  const configured = Boolean(supabaseUrl && secretKey);
  const memory = options.memoryStore || (configured ? null : { members: [] });

  async function requireUser(req, res) {
    const header = req.headers.authorization || "";
    const auth = await userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, header);
    if (!auth.userId) {
      // #region agent log
      try {
        require("node:fs").appendFileSync(
          "c:\\Users\\HP\\Desktop\\Vote Banker\\.cursor\\debug-afb56a.log",
          `${JSON.stringify({
            sessionId: "afb56a",
            location: "team_members.js",
            message: "team auth rejected",
            data: {
              hasHeader: header.startsWith("Bearer ") && header.trim().length > "Bearer ".length,
              upstreamStatus: auth.upstreamStatus,
            },
            timestamp: Date.now(),
            hypothesisId: "B",
          })}\n`,
        );
      } catch (_) {}
      // #endregion
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    return auth.userId;
  }

  function storeReady() {
    return configured || Boolean(memory);
  }

  router.get("/", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "team_members_not_ready" });
      return;
    }
    try {
      const all = await listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory);
      const members = filterMembers(all, req.query);
      res.json({ success: true, members, stats: statsFor(all) });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.get("/:id", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "team_members_not_ready" });
      return;
    }
    try {
      const member = await getMember(fetchImpl, supabaseUrl, secretKey, userId, req.params.id, memory);
      if (!member) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({ success: true, member });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.post("/", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "team_members_not_ready" });
      return;
    }
    const parsed = validateMemberInput(req.body, { creating: true });
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const existing = await listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory);
      if (existing.some((row) => row.mobile === parsed.value.mobile)) {
        res.status(409).json({ error: "duplicate_mobile" });
        return;
      }
      const member = await insertMember(fetchImpl, supabaseUrl, secretKey, userId, parsed.value, memory);
      const all = await listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory);
      res.status(201).json({ success: true, member, stats: statsFor(all) });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  router.patch("/:id", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "team_members_not_ready" });
      return;
    }
    const parsed = validateMemberInput(req.body, { creating: false });
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const current = await getMember(fetchImpl, supabaseUrl, secretKey, userId, req.params.id, memory);
      if (!current) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const existing = await listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory);
      if (existing.some((row) => row.id !== current.id && row.mobile === parsed.value.mobile)) {
        res.status(409).json({ error: "duplicate_mobile" });
        return;
      }
      const member = await updateMember(
        fetchImpl,
        supabaseUrl,
        secretKey,
        userId,
        current.id,
        parsed.value,
        memory,
      );
      const all = await listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory);
      res.json({ success: true, member, stats: statsFor(all) });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  router.delete("/:id", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "team_members_not_ready" });
      return;
    }
    try {
      const current = await getMember(fetchImpl, supabaseUrl, secretKey, userId, req.params.id, memory);
      if (!current) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await deleteMember(fetchImpl, supabaseUrl, secretKey, userId, current.id, memory);
      const all = await listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory);
      res.json({ success: true, stats: statsFor(all) });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "delete_failed" });
    }
  });

  return router;
}

function validateMemberInput(source, options = {}) {
  const body = source && typeof source === "object" ? source : {};
  const fullName = String(body.fullName || "").trim();
  const mobile = String(body.mobile || "").trim();
  const email = String(body.email || "").trim();
  const designation = String(body.designation || "").trim();
  const location = String(body.location || "").trim();
  const role = String(body.role || "").trim();
  const permissions = normalizePermissions(body.permissions);
  const status = options.creating ? "pending" : String(body.status || "pending").trim().toLowerCase();

  if (!fullName || fullName.length > 120) return { error: "invalid_name" };
  if (!isValidPhone(mobile)) return { error: "invalid_phone" };
  if (email && !isValidEmail(email)) return { error: "invalid_email" };
  if (designation.length > 80) return { error: "invalid_designation" };
  if (location.length > 120) return { error: "invalid_location" };
  if (!ROLES.includes(role)) return { error: "invalid_role" };
  if (!permissions) return { error: "invalid_permissions" };
  if (!STATUSES.includes(status)) return { error: "invalid_status" };

  return {
    value: {
      fullName,
      mobile,
      email: email || null,
      designation: designation || null,
      location: location || null,
      role,
      permissions,
      status,
    },
  };
}

function normalizePermissions(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const unique = [];
  for (const item of raw) {
    const name = String(item || "").trim();
    if (!PERMISSIONS.includes(name)) return null;
    if (!unique.includes(name)) unique.push(name);
  }
  return unique;
}

function isValidPhone(value) {
  return /^\+?[0-9][0-9\s-]{6,18}$/.test(String(value || "").trim());
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()) && String(value).length <= 160;
}

function statsFor(members) {
  return {
    total: members.length,
    active: members.filter((row) => row.status === "active").length,
    pending: members.filter((row) => row.status === "pending").length,
    inactive: members.filter((row) => row.status === "inactive").length,
  };
}

function filterMembers(members, query) {
  const q = String((query && query.q) || "").trim().toLowerCase();
  const status = String((query && query.status) || "").trim().toLowerCase();
  const role = String((query && query.role) || "").trim();
  return members.filter((row) => {
    if (status && STATUSES.includes(status) && row.status !== status) return false;
    if (role && row.role !== role) return false;
    if (!q) return true;
    const blob = [row.fullName, row.mobile, row.email, row.designation, row.role, row.location]
      .join(" ")
      .toLowerCase();
    return blob.includes(q);
  });
}

function parsePermissions(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapMember(row) {
  if (!row) return null;
  const permissions = parsePermissions(row.permissions);
  return {
    id: row.id,
    fullName: row.full_name,
    mobile: row.mobile,
    email: row.email || "",
    designation: row.designation || "",
    location: row.location || "",
    role: row.role,
    permissions,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

async function listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory) {
  if (memory) {
    return memory.members
      .filter((row) => row.owner_user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(mapMember);
  }
  const path =
    `/rest/v1/team_members?select=id,full_name,mobile,email,designation,location,role,permissions,status,created_at,updated_at` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`;
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, path);
  if (!response.ok) throw new Error("team_members_load_failed");
  const rows = Array.isArray(response.body) ? response.body : [];
  return rows.map(mapMember);
}

async function getMember(fetchImpl, supabaseUrl, secretKey, userId, id, memory) {
  const members = await listMembers(fetchImpl, supabaseUrl, secretKey, userId, memory);
  return members.find((row) => row.id === id) || null;
}

async function insertMember(fetchImpl, supabaseUrl, secretKey, userId, value, memory) {
  const now = new Date().toISOString();
  if (memory) {
    const row = {
      id: `member-${memory.members.length + 1}`,
      owner_user_id: userId,
      full_name: value.fullName,
      mobile: value.mobile,
      email: value.email,
      designation: value.designation,
      location: value.location,
      role: value.role,
      permissions: value.permissions,
      status: value.status,
      created_at: now,
      updated_at: now,
    };
    memory.members.push(row);
    return mapMember(row);
  }
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/team_members", {
    method: "POST",
    prefer: "return=representation",
    body: {
      owner_user_id: userId,
      full_name: value.fullName,
      mobile: value.mobile,
      email: value.email,
      designation: value.designation,
      location: value.location,
      role: value.role,
      permissions: value.permissions,
      status: value.status,
    },
  });
  if (!response.ok) throw new Error("team_member_insert_failed");
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  return mapMember(row);
}

async function updateMember(fetchImpl, supabaseUrl, secretKey, userId, id, value, memory) {
  const now = new Date().toISOString();
  if (memory) {
    const row = memory.members.find((item) => item.id === id && item.owner_user_id === userId);
    if (!row) return null;
    row.full_name = value.fullName;
    row.mobile = value.mobile;
    row.email = value.email;
    row.designation = value.designation;
    row.location = value.location;
    row.role = value.role;
    row.permissions = value.permissions;
    row.status = value.status;
    row.updated_at = now;
    return mapMember(row);
  }
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/team_members?id=eq.${encodeURIComponent(id)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        full_name: value.fullName,
        mobile: value.mobile,
        email: value.email,
        designation: value.designation,
        location: value.location,
        role: value.role,
        permissions: value.permissions,
        status: value.status,
        updated_at: now,
      },
    },
  );
  if (!response.ok) throw new Error("team_member_update_failed");
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  return mapMember(row);
}

async function deleteMember(fetchImpl, supabaseUrl, secretKey, userId, id, memory) {
  if (memory) {
    memory.members = memory.members.filter((row) => !(row.id === id && row.owner_user_id === userId));
    return;
  }
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/team_members?id=eq.${encodeURIComponent(id)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("team_member_delete_failed");
}

async function userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, header) {
  if (!header || !header.startsWith("Bearer ")) return { userId: null, upstreamStatus: 0 };
  const token = header.slice("Bearer ".length).trim();
  if (!token) return { userId: null, upstreamStatus: 0 };
  if (!supabaseUrl || !publishableKey) {
    return { userId: "local-user", upstreamStatus: 0 };
  }
  try {
    const response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return { userId: null, upstreamStatus: response.status };
    const body = await response.json();
    return {
      userId: typeof body.id === "string" ? body.id : null,
      upstreamStatus: response.status,
    };
  } catch {
    return { userId: null, upstreamStatus: 0 };
  }
}

async function supabaseFetch(fetchImpl, supabaseUrl, secretKey, path, options = {}) {
  try {
    const response = await fetchImpl(`${supabaseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

function createMemoryStore() {
  return { members: [] };
}

module.exports = {
  ROLES,
  PERMISSIONS,
  STATUSES,
  createTeamMembersRouter,
  createMemoryStore,
  validateMemberInput,
  statsFor,
};
