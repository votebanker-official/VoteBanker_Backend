const express = require("express");

const { requireUser } = require("./vrm");
const { groupSocialContacts, listVoterRecords } = require("../vrm/records");

const router = express.Router();

/**
 * Saved WhatsApp, Instagram, and Facebook values from VRM voter records
 * the signed-in user is allowed to read. Owner id comes from the token.
 */
router.get("/contacts", requireUser, async (req, res, next) => {
  try {
    const records = await listVoterRecords(req.user.id);
    const grouped = groupSocialContacts(records, req.query.q);
    res.json({ success: true, ...grouped });
  } catch (err) {
    next(err);
  }
});

/**
 * Page publishing is separate from voter contact lists and from Facebook or
 * Instagram sign-in. No page token, WhatsApp business account, caption model,
 * or post store is configured, so this never reports a connection.
 */
function integrationStatus() {
  return {
    success: true,
    accounts: {
      facebook: { connected: false, pageCount: 0, status: "setup_required" },
      instagram: { connected: false, accountCount: 0, status: "setup_required" },
      whatsapp: { connected: false, businessReady: false, status: "setup_required" },
    },
    capabilities: {
      drafts: false,
      scheduling: false,
      publishing: false,
      captions: false,
      mediaStorage: false,
    },
  };
}

router.get("/integrations", requireUser, (_req, res) => {
  res.json(integrationStatus());
});

router.post("/posts", requireUser, (req, res) => {
  const action = req.body && req.body.action;
  const capability =
    action === "schedule" ? "scheduling" : action === "publish" ? "publishing" : "drafts";
  res.status(501).json({
    success: false,
    error: "publishing_not_configured",
    capability,
  });
});

router.post("/captions", requireUser, (_req, res) => {
  res.status(501).json({ success: false, error: "caption_ai_not_configured" });
});

module.exports = {
  createSocialMediaRouter: () => router,
  integrationStatus,
};
