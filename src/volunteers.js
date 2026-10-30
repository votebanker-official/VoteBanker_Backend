const express = require("express");

const ROLES = [
  "General Volunteer",
  "Field Volunteer",
  "Team Coordinator",
  "Event Volunteer",
  "Content & Social Media Volunteer",
  "Data Entry Volunteer",
  "Technical Support Volunteer",
];

const VOLUNTEER_STATUSES = ["active", "inactive", "pending"];
const APPLICATION_STATUSES = ["pending", "approved", "rejected"];
const TASK_PRIORITIES = ["low", "medium", "high"];
const TASK_STATUSES = ["pending", "in_progress", "completed"];

const DEFAULT_TEAMS = [
  { name: "Field Outreach", description: "Door-to-door and booth outreach." },
  { name: "Events", description: "Rallies, meetings, and public programs." },
  { name: "Digital Media", description: "Content, social posts, and messaging." },
  { name: "Data Entry", description: "Forms, records, and list updates." },
];

function createVolunteersRouter(options = {}) {
  const router = express.Router();
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL || "";
  const secretKey = options.secretKey || process.env.SUPABASE_SECRET_KEY || "";
  const publishableKey = options.publishableKey || process.env.SUPABASE_PUBLISHABLE_KEY || "";
  const fetchImpl = options.fetchImpl || fetch;
  const memory = options.memoryStore || null;

  async function requireUser(req, res) {
    const userId = await userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, req.headers.authorization);
    if (!userId) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    return userId;
  }

  function storeReady() {
    return Boolean(supabaseUrl && secretKey) || Boolean(memory);
  }

  router.get("/stats", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      const stats = await getStats(fetchImpl, supabaseUrl, secretKey, userId, memory);
      res.json({ success: true, stats, storageReady: !memory || Boolean(supabaseUrl && secretKey) });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.get("/overview", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      await ensureDefaultTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
      const [stats, recentVolunteers, recentActivity, teams] = await Promise.all([
        getStats(fetchImpl, supabaseUrl, secretKey, userId, memory),
        listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, { limit: 5, memory }),
        listActivity(fetchImpl, supabaseUrl, secretKey, userId, { limit: 8, memory }),
        listTeams(fetchImpl, supabaseUrl, secretKey, userId, memory),
      ]);
      res.json({
        success: true,
        stats,
        recentVolunteers: recentVolunteers.volunteers,
        recentActivity,
        teams,
      });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.get("/teams", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      await ensureDefaultTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
      const teams = await listTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
      res.json({ success: true, teams });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.get("/volunteers", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      const result = await listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, {
        q: req.query.q,
        role: req.query.role,
        teamId: req.query.teamId,
        status: req.query.status,
        location: req.query.location,
        page: req.query.page,
        pageSize: req.query.pageSize,
        memory,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.get("/volunteers/:id", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      const volunteer = await getVolunteer(fetchImpl, supabaseUrl, secretKey, userId, req.params.id, memory);
      if (!volunteer) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const [tasks, activity] = await Promise.all([
        listTasks(fetchImpl, supabaseUrl, secretKey, userId, { volunteerId: volunteer.id, memory }),
        listActivity(fetchImpl, supabaseUrl, secretKey, userId, { volunteerId: volunteer.id, limit: 20, memory }),
      ]);
      res.json({ success: true, volunteer, tasks: tasks.tasks, activity });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.post("/volunteers", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    const parsed = validateVolunteerInput(req.body, { requireStatus: true });
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      await ensureDefaultTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
      if (parsed.value.teamId) {
        const teamOk = await teamOwnedBy(fetchImpl, supabaseUrl, secretKey, userId, parsed.value.teamId, memory);
        if (!teamOk) {
          res.status(400).json({ error: "invalid_team" });
          return;
        }
      }
      const created = await createVolunteer(fetchImpl, supabaseUrl, secretKey, userId, parsed.value, memory);
      if (created.error) {
        res.status(created.status || 400).json({ error: created.error });
        return;
      }
      await writeActivity(fetchImpl, supabaseUrl, secretKey, userId, {
        volunteerId: created.volunteer.id,
        action: "volunteer_created",
        detail: created.volunteer.fullName,
      }, memory);
      res.status(201).json({ success: true, volunteer: created.volunteer });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  router.patch("/volunteers/:id", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    const parsed = validateVolunteerInput(req.body, { partial: true });
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      if (parsed.value.teamId) {
        const teamOk = await teamOwnedBy(fetchImpl, supabaseUrl, secretKey, userId, parsed.value.teamId, memory);
        if (!teamOk) {
          res.status(400).json({ error: "invalid_team" });
          return;
        }
      }
      const updated = await updateVolunteer(
        fetchImpl,
        supabaseUrl,
        secretKey,
        userId,
        req.params.id,
        parsed.value,
        memory,
      );
      if (updated.error) {
        res.status(updated.status || 400).json({ error: updated.error });
        return;
      }
      await writeActivity(fetchImpl, supabaseUrl, secretKey, userId, {
        volunteerId: updated.volunteer.id,
        action: "volunteer_updated",
        detail: updated.volunteer.fullName,
      }, memory);
      res.json({ success: true, volunteer: updated.volunteer });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  router.delete("/volunteers/:id", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      const existing = await getVolunteer(fetchImpl, supabaseUrl, secretKey, userId, req.params.id, memory);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const deleted = await deleteVolunteer(fetchImpl, supabaseUrl, secretKey, userId, req.params.id, memory);
      if (!deleted) {
        res.status(502).json({ error: "delete_failed" });
        return;
      }
      await writeActivity(fetchImpl, supabaseUrl, secretKey, userId, {
        volunteerId: null,
        action: "volunteer_deleted",
        detail: existing.fullName,
      }, memory);
      res.json({ success: true });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "delete_failed" });
    }
  });

  router.get("/tasks", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      const result = await listTasks(fetchImpl, supabaseUrl, secretKey, userId, {
        status: req.query.status,
        memory,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.post("/tasks", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    const parsed = validateTaskInput(req.body);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      if (parsed.value.volunteerId) {
        const volunteer = await getVolunteer(
          fetchImpl,
          supabaseUrl,
          secretKey,
          userId,
          parsed.value.volunteerId,
          memory,
        );
        if (!volunteer) {
          res.status(400).json({ error: "invalid_volunteer" });
          return;
        }
      }
      if (parsed.value.teamId) {
        const teamOk = await teamOwnedBy(fetchImpl, supabaseUrl, secretKey, userId, parsed.value.teamId, memory);
        if (!teamOk) {
          res.status(400).json({ error: "invalid_team" });
          return;
        }
      }
      const created = await createTask(fetchImpl, supabaseUrl, secretKey, userId, parsed.value, memory);
      if (created.error) {
        res.status(created.status || 400).json({ error: created.error });
        return;
      }
      await writeActivity(fetchImpl, supabaseUrl, secretKey, userId, {
        volunteerId: created.task.volunteerId,
        action: "task_created",
        detail: created.task.title,
      }, memory);
      res.status(201).json({ success: true, task: created.task });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  router.patch("/tasks/:id", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    const parsed = validateTaskInput(req.body, { partial: true });
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const updated = await updateTask(
        fetchImpl,
        supabaseUrl,
        secretKey,
        userId,
        req.params.id,
        parsed.value,
        memory,
      );
      if (updated.error) {
        res.status(updated.status || 400).json({ error: updated.error });
        return;
      }
      await writeActivity(fetchImpl, supabaseUrl, secretKey, userId, {
        volunteerId: updated.task.volunteerId,
        action: "task_updated",
        detail: updated.task.title,
      }, memory);
      res.json({ success: true, task: updated.task });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  router.get("/applications", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    try {
      const result = await listApplications(fetchImpl, supabaseUrl, secretKey, userId, {
        status: req.query.status,
        memory,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "load_failed" });
    }
  });

  router.post("/applications", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    const parsed = validateApplicationInput(req.body);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const created = await createApplication(fetchImpl, supabaseUrl, secretKey, userId, parsed.value, memory);
      if (created.error) {
        res.status(created.status || 400).json({ error: created.error });
        return;
      }
      await writeActivity(fetchImpl, supabaseUrl, secretKey, userId, {
        volunteerId: null,
        action: "application_received",
        detail: created.application.fullName,
      }, memory);
      res.status(201).json({ success: true, application: created.application });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  router.post("/applications/:id/review", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!storeReady()) {
      res.status(503).json({ error: "volunteers_not_ready" });
      return;
    }
    const decision = String((req.body && req.body.status) || "").trim().toLowerCase();
    if (decision !== "approved" && decision !== "rejected") {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    try {
      const reviewed = await reviewApplication(
        fetchImpl,
        supabaseUrl,
        secretKey,
        userId,
        req.params.id,
        decision,
        memory,
      );
      if (reviewed.error) {
        res.status(reviewed.status || 400).json({ error: reviewed.error });
        return;
      }
      await writeActivity(fetchImpl, supabaseUrl, secretKey, userId, {
        volunteerId: reviewed.volunteer ? reviewed.volunteer.id : null,
        action: decision === "approved" ? "application_approved" : "application_rejected",
        detail: reviewed.application.fullName,
      }, memory);
      res.json({
        success: true,
        application: reviewed.application,
        volunteer: reviewed.volunteer || null,
      });
    } catch (err) {
      console.error(err.message);
      res.status(502).json({ error: "save_failed" });
    }
  });

  return router;
}

function validateVolunteerInput(body, options = {}) {
  const source = body && typeof body === "object" ? body : {};
  const partial = Boolean(options.partial);
  const value = {};

  if (!partial || source.fullName != null) {
    const fullName = String(source.fullName || "").trim();
    if (!fullName || fullName.length > 120) return { error: "invalid_name" };
    value.fullName = fullName;
  }

  if (!partial || source.mobile != null) {
    const mobile = String(source.mobile || "").trim();
    if (!mobile) {
      value.mobile = null;
    } else if (!isValidPhone(mobile)) {
      return { error: "invalid_phone" };
    } else {
      value.mobile = mobile;
    }
  }

  if (!partial || source.email != null) {
    const email = String(source.email || "").trim();
    if (email && !isValidEmail(email)) return { error: "invalid_email" };
    value.email = email || null;
  }

  if (!partial || source.role != null) {
    const role = String(source.role || "").trim();
    if (!ROLES.includes(role)) return { error: "invalid_role" };
    value.role = role;
  }

  if (source.skills != null || !partial) {
    value.skills = String(source.skills || "").trim().slice(0, 800) || null;
  }
  if (source.availability != null || !partial) {
    value.availability = String(source.availability || "").trim().slice(0, 400) || null;
  }
  if (source.notes != null || !partial) {
    value.notes = String(source.notes || "").trim().slice(0, 800) || null;
  }
  if (source.location != null || !partial) {
    value.location = String(source.location || "").trim().slice(0, 160) || null;
  }
  if (source.photoUrl != null || Object.prototype.hasOwnProperty.call(source, "photoUrl")) {
    value.photoUrl = String(source.photoUrl || "").trim().slice(0, 500) || null;
  }

  if (source.teamId != null || Object.prototype.hasOwnProperty.call(source, "teamId")) {
    const teamId = source.teamId == null || source.teamId === "" ? null : String(source.teamId);
    value.teamId = teamId;
  }

  if (options.requireStatus || source.status != null) {
    const status = String(source.status || "active").trim().toLowerCase();
    if (!VOLUNTEER_STATUSES.includes(status)) return { error: "invalid_status" };
    value.status = status;
  }

  if (partial && Object.keys(value).length === 0) {
    return { error: "empty_update" };
  }
  return { value };
}

function validateApplicationInput(body) {
  const source = body && typeof body === "object" ? body : {};
  const fullName = String(source.fullName || "").trim();
  if (!fullName || fullName.length > 120) return { error: "invalid_name" };
  const mobile = String(source.mobile || "").trim();
  if (!isValidPhone(mobile)) return { error: "invalid_phone" };
  const email = String(source.email || "").trim();
  if (email && !isValidEmail(email)) return { error: "invalid_email" };
  const role = String(source.role || "").trim();
  if (!ROLES.includes(role)) return { error: "invalid_role" };
  return {
    value: {
      fullName,
      mobile,
      email: email || null,
      role,
      skills: String(source.skills || "").trim().slice(0, 800) || null,
      availability: String(source.availability || "").trim().slice(0, 400) || null,
      notes: String(source.notes || "").trim().slice(0, 800) || null,
      status: "pending",
    },
  };
}

function validateTaskInput(body, options = {}) {
  const source = body && typeof body === "object" ? body : {};
  const partial = Boolean(options.partial);
  const value = {};

  if (!partial || source.title != null) {
    const title = String(source.title || "").trim();
    if (!title || title.length > 160) return { error: "invalid_title" };
    value.title = title;
  }
  if (source.description != null || !partial) {
    value.description = String(source.description || "").trim().slice(0, 2000) || null;
  }
  if (source.volunteerId != null || Object.prototype.hasOwnProperty.call(source, "volunteerId")) {
    value.volunteerId = source.volunteerId ? String(source.volunteerId) : null;
  }
  if (source.teamId != null || Object.prototype.hasOwnProperty.call(source, "teamId")) {
    value.teamId = source.teamId ? String(source.teamId) : null;
  }
  if (source.dueDate != null || !partial) {
    const dueDate = String(source.dueDate || "").trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: "invalid_due_date" };
    value.dueDate = dueDate || null;
  }
  if (!partial || source.priority != null) {
    const priority = String(source.priority || "medium").trim().toLowerCase();
    if (!TASK_PRIORITIES.includes(priority)) return { error: "invalid_priority" };
    value.priority = priority;
  }
  if (!partial || source.status != null) {
    const status = String(source.status || "pending").trim().toLowerCase();
    if (!TASK_STATUSES.includes(status)) return { error: "invalid_status" };
    value.status = status;
  }
  if (partial && Object.keys(value).length === 0) return { error: "empty_update" };
  return { value };
}

function isValidPhone(value) {
  return /^\+?[0-9][0-9\s-]{6,18}$/.test(String(value || "").trim());
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()) && String(value).length <= 160;
}

async function userIdFromAuth(fetchImpl, supabaseUrl, publishableKey, header) {
  if (!supabaseUrl || !publishableKey || !header || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    const response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
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

function mapVolunteer(row, teamsById = {}) {
  if (!row) return null;
  const team = row.team_id ? teamsById[row.team_id] : null;
  return {
    id: row.id,
    volunteerCode: row.volunteer_code,
    fullName: row.full_name,
    mobile: row.mobile,
    email: row.email || null,
    role: row.role,
    teamId: row.team_id || null,
    teamName: team ? team.name : row.team_name || null,
    location: row.location || null,
    photoUrl: row.photo_url || null,
    skills: row.skills || null,
    availability: row.availability || null,
    status: row.status,
    notes: row.notes || null,
    registeredAt: row.registered_at || row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function mapTeam(row, memberCount = 0) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    memberCount,
    createdAt: row.created_at,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    volunteerId: row.volunteer_id || null,
    volunteerName: row.volunteer_name || null,
    teamId: row.team_id || null,
    teamName: row.team_name || null,
    dueDate: row.due_date || null,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function mapApplication(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    mobile: row.mobile,
    email: row.email || null,
    role: row.role,
    skills: row.skills || null,
    availability: row.availability || null,
    notes: row.notes || null,
    status: row.status,
    volunteerId: row.volunteer_id || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function mapActivity(row) {
  return {
    id: row.id,
    volunteerId: row.volunteer_id || null,
    action: row.action,
    detail: row.detail || null,
    createdAt: row.created_at,
  };
}

function createMemoryStore() {
  return {
    teams: [],
    volunteers: [],
    applications: [],
    tasks: [],
    activity: [],
  };
}

async function ensureDefaultTeams(fetchImpl, supabaseUrl, secretKey, userId, memory) {
  const existing = await listTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
  if (existing.length > 0) return existing;
  if (memory) {
    for (const team of DEFAULT_TEAMS) {
      memory.teams.push({
        id: `team-${memory.teams.length + 1}`,
        owner_user_id: userId,
        name: team.name,
        description: team.description,
        created_at: new Date().toISOString(),
      });
    }
    return listTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
  }
  await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/volunteer_teams", {
    method: "POST",
    prefer: "return=minimal",
    body: DEFAULT_TEAMS.map((team) => ({
      owner_user_id: userId,
      name: team.name,
      description: team.description,
    })),
  });
  return listTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
}

async function listTeams(fetchImpl, supabaseUrl, secretKey, userId, memory) {
  if (memory) {
    const teams = memory.teams.filter((row) => row.owner_user_id === userId);
    return teams.map((row) =>
      mapTeam(
        row,
        memory.volunteers.filter((v) => v.owner_user_id === userId && v.team_id === row.id).length,
      ),
    );
  }
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/volunteer_teams?select=id,name,description,created_at&owner_user_id=eq.${encodeURIComponent(userId)}&order=name.asc`,
  );
  if (!response.ok) {
    if (response.status === 404 || (response.body && (response.body.code === "PGRST205" || response.body.code === "42P01"))) {
      const err = new Error("volunteers_not_ready");
      err.code = "volunteers_not_ready";
      throw err;
    }
    throw new Error("teams_load_failed");
  }
  const rows = Array.isArray(response.body) ? response.body : [];
  const counts = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/volunteers?select=team_id&owner_user_id=eq.${encodeURIComponent(userId)}&team_id=not.is.null`,
  );
  const byTeam = {};
  if (counts.ok && Array.isArray(counts.body)) {
    for (const row of counts.body) {
      if (!row.team_id) continue;
      byTeam[row.team_id] = (byTeam[row.team_id] || 0) + 1;
    }
  }
  return rows.map((row) => mapTeam(row, byTeam[row.id] || 0));
}

async function teamOwnedBy(fetchImpl, supabaseUrl, secretKey, userId, teamId, memory) {
  const teams = await listTeams(fetchImpl, supabaseUrl, secretKey, userId, memory);
  return teams.some((team) => team.id === teamId);
}

async function getStats(fetchImpl, supabaseUrl, secretKey, userId, memory) {
  const volunteers = await listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, {
    page: 1,
    pageSize: 1000,
    memory,
  });
  const applications = await listApplications(fetchImpl, supabaseUrl, secretKey, userId, {
    status: "pending",
    memory,
  });
  const all = volunteers.volunteers;
  return {
    totalVolunteers: all.length,
    activeVolunteers: all.filter((row) => row.status === "active").length,
    pendingApplications: applications.applications.length,
    unassignedVolunteers: all.filter((row) => row.status === "active" && !row.teamId).length,
  };
}

function teamNameFor(row, teamsById) {
  if (!row || !row.team_id || !teamsById) return "";
  const team = teamsById[row.team_id];
  if (!team) return String(row.team_name || "");
  return String(team.name || "");
}

function matchesVolunteerQuery(row, q, teamsById) {
  if (!q) return true;
  const blob = [row.full_name, row.mobile, row.email, row.location, row.volunteer_code, teamNameFor(row, teamsById)]
    .map((part) => String(part || "").toLowerCase())
    .join("\n");
  return blob.includes(q);
}

function distinctLocations(rows) {
  const names = new Set();
  for (const row of rows) {
    const location = String((row && row.location) || "").trim();
    if (location) names.add(location);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

async function listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, options = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || 20));
  const q = String(options.q || "").trim().toLowerCase();
  const role = String(options.role || "").trim();
  const teamId = String(options.teamId || "").trim();
  const status = String(options.status || "").trim().toLowerCase();
  const location = String(options.location || "").trim().toLowerCase();
  const memory = options.memory;

  let rows;
  let teamsById;
  if (memory) {
    rows = memory.volunteers.filter((row) => row.owner_user_id === userId);
    teamsById = Object.fromEntries(
      memory.teams.filter((team) => team.owner_user_id === userId).map((team) => [team.id, team]),
    );
  } else {
    const path =
      `/rest/v1/volunteers?select=id,volunteer_code,full_name,mobile,email,role,team_id,location,photo_url,skills,availability,status,notes,registered_at,created_at,updated_at` +
      `&owner_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`;
    const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, path);
    if (!response.ok) throw new Error("volunteers_load_failed");
    rows = Array.isArray(response.body) ? response.body : [];
    const teams = await listTeams(fetchImpl, supabaseUrl, secretKey, userId, null);
    teamsById = Object.fromEntries(teams.map((team) => [team.id, team]));
  }

  const locations = distinctLocations(rows);
  if (role) rows = rows.filter((row) => row.role === role);
  if (teamId === "unassigned") rows = rows.filter((row) => !row.team_id);
  else if (teamId) rows = rows.filter((row) => row.team_id === teamId);
  if (status && VOLUNTEER_STATUSES.includes(status)) rows = rows.filter((row) => row.status === status);
  if (location) {
    rows = rows.filter((row) => String(row.location || "").trim().toLowerCase() === location);
  }
  if (q) rows = rows.filter((row) => matchesVolunteerQuery(row, q, teamsById));
  if (memory) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const total = rows.length;
  const start = (page - 1) * pageSize;
  return {
    volunteers: rows.slice(start, start + pageSize).map((row) => mapVolunteer(row, teamsById)),
    page,
    pageSize,
    total,
    locations,
  };
}

async function getVolunteer(fetchImpl, supabaseUrl, secretKey, userId, id, memory) {
  const result = await listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, {
    page: 1,
    pageSize: 1000,
    memory,
  });
  return result.volunteers.find((row) => row.id === id) || null;
}

async function nextVolunteerCode(fetchImpl, supabaseUrl, secretKey, userId, memory) {
  const listed = await listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, {
    page: 1,
    pageSize: 1000,
    memory,
  });
  const next = listed.total + 1;
  return `VOL-${String(next).padStart(4, "0")}`;
}

async function createVolunteer(fetchImpl, supabaseUrl, secretKey, userId, value, memory) {
  const code = await nextVolunteerCode(fetchImpl, supabaseUrl, secretKey, userId, memory);
  const now = new Date().toISOString();
  if (memory) {
    if (value.mobile && memory.volunteers.some((row) => row.owner_user_id === userId && row.mobile === value.mobile)) {
      return { error: "duplicate_mobile", status: 409 };
    }
    const row = {
      id: `vol-${memory.volunteers.length + 1}`,
      owner_user_id: userId,
      volunteer_code: code,
      full_name: value.fullName,
      mobile: value.mobile,
      email: value.email,
      role: value.role,
      team_id: value.teamId || null,
      location: value.location || null,
      photo_url: value.photoUrl || null,
      skills: value.skills,
      availability: value.availability,
      status: value.status || "active",
      notes: value.notes,
      registered_at: now,
      created_at: now,
      updated_at: now,
    };
    memory.volunteers.push(row);
    return { volunteer: mapVolunteer(row, Object.fromEntries(memory.teams.map((team) => [team.id, team]))) };
  }

  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/volunteers", {
    method: "POST",
    prefer: "return=representation",
    body: {
      owner_user_id: userId,
      volunteer_code: code,
      full_name: value.fullName,
      mobile: value.mobile,
      email: value.email,
      role: value.role,
      team_id: value.teamId || null,
      location: value.location || null,
      photo_url: value.photoUrl || null,
      skills: value.skills,
      availability: value.availability,
      status: value.status || "active",
      notes: value.notes,
      registered_at: now,
    },
  });
  if (!response.ok) {
    const codeName = response.body && response.body.code;
    // #region agent log
    fetch('http://127.0.0.1:7337/ingest/75959716-472f-4d0f-8b88-2b7d19c8618c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'89cc1e'},body:JSON.stringify({sessionId:'89cc1e',hypothesisId:'H3',location:'volunteers.js:createVolunteer',message:'insert failed',data:{status:response.status,code:codeName||null,runId:'post-fix'},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (codeName === "23505") return { error: "duplicate_mobile", status: 409 };
    return { error: "save_failed", status: 502 };
  }
  // #region agent log
  fetch('http://127.0.0.1:7337/ingest/75959716-472f-4d0f-8b88-2b7d19c8618c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'89cc1e'},body:JSON.stringify({sessionId:'89cc1e',hypothesisId:'H3',location:'volunteers.js:createVolunteer',message:'insert succeeded',data:{status:response.status,runId:'post-fix'},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  const teams = await listTeams(fetchImpl, supabaseUrl, secretKey, userId, null);
  const teamsById = Object.fromEntries(teams.map((team) => [team.id, team]));
  return { volunteer: mapVolunteer(row, teamsById) };
}

async function updateVolunteer(fetchImpl, supabaseUrl, secretKey, userId, id, value, memory) {
  if (memory) {
    const row = memory.volunteers.find((entry) => entry.id === id && entry.owner_user_id === userId);
    if (!row) return { error: "not_found", status: 404 };
    if (value.mobile && memory.volunteers.some((entry) => entry.owner_user_id === userId && entry.mobile === value.mobile && entry.id !== id)) {
      return { error: "duplicate_mobile", status: 409 };
    }
    if (value.fullName != null) row.full_name = value.fullName;
    if (value.mobile != null) row.mobile = value.mobile;
    if (value.email !== undefined) row.email = value.email;
    if (value.role != null) row.role = value.role;
    if (value.teamId !== undefined) row.team_id = value.teamId;
    if (value.location !== undefined) row.location = value.location;
    if (value.photoUrl !== undefined) row.photo_url = value.photoUrl;
    if (value.skills !== undefined) row.skills = value.skills;
    if (value.availability !== undefined) row.availability = value.availability;
    if (value.status != null) row.status = value.status;
    if (value.notes !== undefined) row.notes = value.notes;
    row.updated_at = new Date().toISOString();
    return { volunteer: mapVolunteer(row, Object.fromEntries(memory.teams.map((team) => [team.id, team]))) };
  }

  const patch = { updated_at: new Date().toISOString() };
  if (value.fullName != null) patch.full_name = value.fullName;
  if (value.mobile != null) patch.mobile = value.mobile;
  if (value.email !== undefined) patch.email = value.email;
  if (value.role != null) patch.role = value.role;
  if (value.teamId !== undefined) patch.team_id = value.teamId;
  if (value.location !== undefined) patch.location = value.location;
  if (value.photoUrl !== undefined) patch.photo_url = value.photoUrl;
  if (value.skills !== undefined) patch.skills = value.skills;
  if (value.availability !== undefined) patch.availability = value.availability;
  if (value.status != null) patch.status = value.status;
  if (value.notes !== undefined) patch.notes = value.notes;

  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/volunteers?id=eq.${encodeURIComponent(id)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    { method: "PATCH", prefer: "return=representation", body: patch },
  );
  if (!response.ok) {
    const codeName = response.body && response.body.code;
    if (codeName === "23505") return { error: "duplicate_mobile", status: 409 };
    return { error: "save_failed", status: 502 };
  }
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  if (!row) return { error: "not_found", status: 404 };
  const teams = await listTeams(fetchImpl, supabaseUrl, secretKey, userId, null);
  return { volunteer: mapVolunteer(row, Object.fromEntries(teams.map((team) => [team.id, team]))) };
}

async function deleteVolunteer(fetchImpl, supabaseUrl, secretKey, userId, id, memory) {
  if (memory) {
    const before = memory.volunteers.length;
    memory.volunteers = memory.volunteers.filter((row) => !(row.id === id && row.owner_user_id === userId));
    return memory.volunteers.length < before;
  }
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/volunteers?id=eq.${encodeURIComponent(id)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    { method: "DELETE", prefer: "return=minimal" },
  );
  return response.ok;
}

async function listTasks(fetchImpl, supabaseUrl, secretKey, userId, options = {}) {
  const memory = options.memory;
  const status = String(options.status || "").trim().toLowerCase();
  const volunteerId = options.volunteerId ? String(options.volunteerId) : "";

  if (memory) {
    let rows = memory.tasks.filter((row) => row.owner_user_id === userId);
    if (status) rows = rows.filter((row) => row.status === status);
    if (volunteerId) rows = rows.filter((row) => row.volunteer_id === volunteerId);
    const volunteersById = Object.fromEntries(
      memory.volunteers.filter((row) => row.owner_user_id === userId).map((row) => [row.id, row]),
    );
    const teamsById = Object.fromEntries(
      memory.teams.filter((row) => row.owner_user_id === userId).map((row) => [row.id, row]),
    );
    return {
      tasks: rows
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((row) =>
          mapTask({
            ...row,
            volunteer_name: row.volunteer_id && volunteersById[row.volunteer_id]
              ? volunteersById[row.volunteer_id].full_name
              : null,
            team_name: row.team_id && teamsById[row.team_id] ? teamsById[row.team_id].name : null,
          }),
        ),
    };
  }

  let path =
    `/rest/v1/volunteer_tasks?select=id,title,description,volunteer_id,team_id,due_date,priority,status,created_at,updated_at` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`;
  if (status && TASK_STATUSES.includes(status)) path += `&status=eq.${encodeURIComponent(status)}`;
  if (volunteerId) path += `&volunteer_id=eq.${encodeURIComponent(volunteerId)}`;
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, path);
  if (!response.ok) throw new Error("tasks_load_failed");
  const rows = Array.isArray(response.body) ? response.body : [];
  const volunteers = await listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, { pageSize: 1000 });
  const teams = await listTeams(fetchImpl, supabaseUrl, secretKey, userId, null);
  const volunteersById = Object.fromEntries(volunteers.volunteers.map((row) => [row.id, row]));
  const teamsById = Object.fromEntries(teams.map((row) => [row.id, row]));
  return {
    tasks: rows.map((row) =>
      mapTask({
        ...row,
        volunteer_name: row.volunteer_id && volunteersById[row.volunteer_id]
          ? volunteersById[row.volunteer_id].fullName
          : null,
        team_name: row.team_id && teamsById[row.team_id] ? teamsById[row.team_id].name : null,
      }),
    ),
  };
}

async function createTask(fetchImpl, supabaseUrl, secretKey, userId, value, memory) {
  const now = new Date().toISOString();
  if (memory) {
    const row = {
      id: `task-${memory.tasks.length + 1}`,
      owner_user_id: userId,
      title: value.title,
      description: value.description,
      volunteer_id: value.volunteerId || null,
      team_id: value.teamId || null,
      due_date: value.dueDate,
      priority: value.priority || "medium",
      status: value.status || "pending",
      created_at: now,
      updated_at: now,
    };
    memory.tasks.push(row);
    return { task: mapTask(row) };
  }
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/volunteer_tasks", {
    method: "POST",
    prefer: "return=representation",
    body: {
      owner_user_id: userId,
      title: value.title,
      description: value.description,
      volunteer_id: value.volunteerId || null,
      team_id: value.teamId || null,
      due_date: value.dueDate,
      priority: value.priority || "medium",
      status: value.status || "pending",
    },
  });
  if (!response.ok) return { error: "save_failed", status: 502 };
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  return { task: mapTask(row) };
}

async function updateTask(fetchImpl, supabaseUrl, secretKey, userId, id, value, memory) {
  if (memory) {
    const row = memory.tasks.find((entry) => entry.id === id && entry.owner_user_id === userId);
    if (!row) return { error: "not_found", status: 404 };
    if (value.title != null) row.title = value.title;
    if (value.description !== undefined) row.description = value.description;
    if (value.volunteerId !== undefined) row.volunteer_id = value.volunteerId;
    if (value.teamId !== undefined) row.team_id = value.teamId;
    if (value.dueDate !== undefined) row.due_date = value.dueDate;
    if (value.priority != null) row.priority = value.priority;
    if (value.status != null) row.status = value.status;
    row.updated_at = new Date().toISOString();
    return { task: mapTask(row) };
  }
  const patch = { updated_at: new Date().toISOString() };
  if (value.title != null) patch.title = value.title;
  if (value.description !== undefined) patch.description = value.description;
  if (value.volunteerId !== undefined) patch.volunteer_id = value.volunteerId;
  if (value.teamId !== undefined) patch.team_id = value.teamId;
  if (value.dueDate !== undefined) patch.due_date = value.dueDate;
  if (value.priority != null) patch.priority = value.priority;
  if (value.status != null) patch.status = value.status;
  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/volunteer_tasks?id=eq.${encodeURIComponent(id)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    { method: "PATCH", prefer: "return=representation", body: patch },
  );
  if (!response.ok) return { error: "save_failed", status: 502 };
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  if (!row) return { error: "not_found", status: 404 };
  return { task: mapTask(row) };
}

async function listApplications(fetchImpl, supabaseUrl, secretKey, userId, options = {}) {
  const memory = options.memory;
  const status = String(options.status || "").trim().toLowerCase();
  if (memory) {
    let rows = memory.applications.filter((row) => row.owner_user_id === userId);
    if (status) rows = rows.filter((row) => row.status === status);
    return {
      applications: rows
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map(mapApplication),
    };
  }
  let path =
    `/rest/v1/volunteer_applications?select=*` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`;
  if (status && APPLICATION_STATUSES.includes(status)) path += `&status=eq.${encodeURIComponent(status)}`;
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, path);
  if (!response.ok) throw new Error("applications_load_failed");
  const rows = Array.isArray(response.body) ? response.body : [];
  return { applications: rows.map(mapApplication) };
}

async function createApplication(fetchImpl, supabaseUrl, secretKey, userId, value, memory) {
  const now = new Date().toISOString();
  if (memory) {
    const row = {
      id: `app-${memory.applications.length + 1}`,
      owner_user_id: userId,
      full_name: value.fullName,
      mobile: value.mobile,
      email: value.email,
      role: value.role,
      skills: value.skills,
      availability: value.availability,
      notes: value.notes,
      status: "pending",
      volunteer_id: null,
      reviewed_at: null,
      created_at: now,
      updated_at: now,
    };
    memory.applications.push(row);
    return { application: mapApplication(row) };
  }
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/volunteer_applications", {
    method: "POST",
    prefer: "return=representation",
    body: {
      owner_user_id: userId,
      full_name: value.fullName,
      mobile: value.mobile,
      email: value.email,
      role: value.role,
      skills: value.skills,
      availability: value.availability,
      notes: value.notes,
      status: "pending",
    },
  });
  if (!response.ok) return { error: "save_failed", status: 502 };
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  return { application: mapApplication(row) };
}

async function reviewApplication(fetchImpl, supabaseUrl, secretKey, userId, id, decision, memory) {
  const listed = await listApplications(fetchImpl, supabaseUrl, secretKey, userId, { memory });
  const current = listed.applications.find((row) => row.id === id);
  if (!current) return { error: "not_found", status: 404 };
  if (current.status !== "pending") return { error: "already_reviewed", status: 409 };

  let volunteer = null;
  if (decision === "approved") {
    const existing = await listVolunteers(fetchImpl, supabaseUrl, secretKey, userId, {
      pageSize: 1000,
      memory,
    });
    volunteer = existing.volunteers.find((row) => row.mobile === current.mobile) || null;
    if (volunteer) {
      const activated = await updateVolunteer(
        fetchImpl,
        supabaseUrl,
        secretKey,
        userId,
        volunteer.id,
        {
          fullName: current.fullName,
          email: current.email,
          role: current.role,
          skills: current.skills,
          availability: current.availability,
          notes: current.notes,
          status: "active",
        },
        memory,
      );
      if (activated.error) return activated;
      volunteer = activated.volunteer;
    } else {
      const created = await createVolunteer(
        fetchImpl,
        supabaseUrl,
        secretKey,
        userId,
        {
          fullName: current.fullName,
          mobile: current.mobile,
          email: current.email,
          role: current.role,
          skills: current.skills,
          availability: current.availability,
          notes: current.notes,
          teamId: null,
          status: "active",
        },
        memory,
      );
      if (created.error) return created;
      volunteer = created.volunteer;
    }
  }

  const now = new Date().toISOString();
  if (memory) {
    const row = memory.applications.find((entry) => entry.id === id && entry.owner_user_id === userId);
    row.status = decision;
    row.reviewed_at = now;
    row.updated_at = now;
    row.volunteer_id = volunteer ? volunteer.id : null;
    return { application: mapApplication(row), volunteer };
  }

  const response = await supabaseFetch(
    fetchImpl,
    supabaseUrl,
    secretKey,
    `/rest/v1/volunteer_applications?id=eq.${encodeURIComponent(id)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        status: decision,
        reviewed_at: now,
        updated_at: now,
        volunteer_id: volunteer ? volunteer.id : null,
      },
    },
  );
  if (!response.ok) return { error: "save_failed", status: 502 };
  const row = Array.isArray(response.body) ? response.body[0] : response.body;
  return { application: mapApplication(row), volunteer };
}

async function listActivity(fetchImpl, supabaseUrl, secretKey, userId, options = {}) {
  const memory = options.memory;
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 10));
  const volunteerId = options.volunteerId ? String(options.volunteerId) : "";
  if (memory) {
    let rows = memory.activity.filter((row) => row.owner_user_id === userId);
    if (volunteerId) rows = rows.filter((row) => row.volunteer_id === volunteerId);
    return rows
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
      .map(mapActivity);
  }
  let path =
    `/rest/v1/volunteer_activity?select=id,volunteer_id,action,detail,created_at` +
    `&owner_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=${limit}`;
  if (volunteerId) path += `&volunteer_id=eq.${encodeURIComponent(volunteerId)}`;
  const response = await supabaseFetch(fetchImpl, supabaseUrl, secretKey, path);
  if (!response.ok) return [];
  const rows = Array.isArray(response.body) ? response.body : [];
  return rows.map(mapActivity);
}

async function writeActivity(fetchImpl, supabaseUrl, secretKey, userId, value, memory) {
  const now = new Date().toISOString();
  if (memory) {
    memory.activity.unshift({
      id: `act-${memory.activity.length + 1}`,
      owner_user_id: userId,
      volunteer_id: value.volunteerId || null,
      action: value.action,
      detail: value.detail || null,
      created_at: now,
    });
    return;
  }
  await supabaseFetch(fetchImpl, supabaseUrl, secretKey, "/rest/v1/volunteer_activity", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      owner_user_id: userId,
      volunteer_id: value.volunteerId || null,
      action: value.action,
      detail: value.detail || null,
    },
  });
}

module.exports = {
  ROLES,
  VOLUNTEER_STATUSES,
  APPLICATION_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  createVolunteersRouter,
  createMemoryStore,
  validateVolunteerInput,
  validateApplicationInput,
  validateTaskInput,
};
