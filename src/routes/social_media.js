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

module.exports = {
  createSocialMediaRouter: () => router,
};
