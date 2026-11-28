const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");

const {
  createPasswordResetOtpHandlers,
  createPasswordResetRouter,
} = require("../src/routes/auth");

const userId = "11111111-1111-4111-8111-111111111111";
const phone = "+919876543210";
const resetToken = "a".repeat(64);

function fakeAdmin(initialAccount) {
  let account = { ...initialAccount };
  const updates = [];
  const authUpdates = [];

  function matches(filters, greaterThan) {
    if (!account) return false;
    for (const [column, value] of Object.entries(filters)) {
      if (account[column] !== value) return false;
    }
    for (const [column, value] of Object.entries(greaterThan)) {
      if (!(new Date(account[column]) > new Date(value))) return false;
    }
    return true;
  }

  function from() {
    let action = "select";
    let patch = null;
    const filters = {};
    const greaterThan = {};
    const builder = {
      select() {
        return builder;
      },
      update(value) {
        action = "update";
        patch = value;
        return builder;
      },
      eq(column, value) {
        filters[column] = value;
        return builder;
      },
      gt(column, value) {
        greaterThan[column] = value;
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(execute());
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };

    function execute() {
      if (!matches(filters, greaterThan)) {
        return { data: null, error: null };
      }
      if (action === "update") {
        account = { ...account, ...patch };
        updates.push({ ...patch });
      }
      return { data: { ...account }, error: null };
    }

    return builder;
  }

  return {
    get account() {
      return account;
    },
    updates,
    authUpdates,
    from,
    auth: {
      admin: {
        async updateUserById(id, payload) {
          authUpdates.push({ id, ...payload });
          return { error: null };
        },
      },
    },
  };
}

function fakeVerifyService(status = "approved") {
  const calls = { sends: [], checks: [] };
  return {
    calls,
    verifications: {
      async create(value) {
        calls.sends.push(value);
        return { status: "pending" };
      },
    },
    verificationChecks: {
      async create(value) {
        calls.checks.push(value);
        return { status };
      },
    },
  };
}

function appWithHandlers({
  admin,
  verify,
  now = () => Date.now(),
  isSmsConfigured = () => true,
}) {
  const app = express();
  app.use(express.json());
  const handlers = createPasswordResetOtpHandlers({
    getAdmin: () => admin,
    getVerifyService: () => verify,
    isSmsConfigured,
    now,
    createToken: () => resetToken,
  });
  app.post("/api/auth/otp/send", handlers.send);
  app.post("/api/auth/otp/verify", handlers.verify);
  app.use(
    "/api/auth/password-reset",
    createPasswordResetRouter({
      getAdmin: () => admin,
      getPublic: () => ({ auth: {} }),
      now,
      passwordHasher: () => "scrypt$secure-hash",
    }),
  );
  return app;
}

async function post(app, path, body) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("phone recovery sends only a real SMS to a registered account", async () => {
  const admin = fakeAdmin({ id: userId, mobile: phone });
  const verify = fakeVerifyService();
  const app = appWithHandlers({ admin, verify });

  const result = await post(app, "/api/auth/otp/send", {
    phone: "9876543210",
    channel: "sms",
    purpose: "password_reset",
  });

  assert.equal(result.status, 200);
  assert.deepEqual(verify.calls.sends, [{ to: phone, channel: "sms" }]);
});

test("phone recovery does not send to an unregistered number", async () => {
  const admin = fakeAdmin({
    id: userId,
    mobile: "+919999999999",
  });
  const verify = fakeVerifyService();
  const app = appWithHandlers({ admin, verify });

  const result = await post(app, "/api/auth/otp/send", {
    phone,
    channel: "sms",
    purpose: "password_reset",
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "sent", channel: "sms" });
  assert.deepEqual(verify.calls.sends, []);
});

test("phone recovery fails rather than falling back to demo OTP", async () => {
  const admin = fakeAdmin({ id: userId, mobile: phone });
  const verify = fakeVerifyService();
  const app = appWithHandlers({
    admin,
    verify,
    isSmsConfigured: () => false,
  });

  const result = await post(app, "/api/auth/otp/send", {
    phone,
    channel: "sms",
    purpose: "password_reset",
  });

  assert.equal(result.status, 503);
  assert.equal(result.body.error, "password_reset_sms_unavailable");
  assert.deepEqual(verify.calls.sends, []);
});

test("phone recovery rejects an incorrect OTP without issuing a reset token", async () => {
  const admin = fakeAdmin({ id: userId, mobile: phone });
  const verify = fakeVerifyService("pending");
  const app = appWithHandlers({ admin, verify });

  const result = await post(app, "/api/auth/otp/verify", {
    phone,
    code: "123456",
    purpose: "password_reset",
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error, "incorrect_code");
  assert.equal(admin.account.password_reset_token_hash, undefined);
});

test("phone recovery verifies the OTP and stores only a hashed, expiring token", async () => {
  const admin = fakeAdmin({ id: userId, mobile: phone });
  const verify = fakeVerifyService();
  const now = () => 1_000;
  const app = appWithHandlers({ admin, verify, now });

  const result = await post(app, "/api/auth/otp/verify", {
    phone,
    code: "123456",
    purpose: "password_reset",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "verified");
  assert.equal(result.body.reset_token, resetToken);
  assert.deepEqual(verify.calls.checks, [{ to: phone, code: "123456" }]);
  assert.equal(
    admin.account.password_reset_token_hash,
    crypto.createHash("sha256").update(resetToken).digest("hex"),
  );
  assert.equal(
    admin.account.password_reset_expires_at,
    "1970-01-01T00:10:01.000Z",
  );
});

test("phone reset updates both password stores and consumes the token once", async () => {
  const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  const admin = fakeAdmin({
    id: userId,
    mobile: phone,
    hashed_password: "scrypt$old",
    password_reset_token_hash: tokenHash,
    password_reset_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const app = appWithHandlers({
    admin,
    verify: fakeVerifyService(),
  });

  const body = {
    reset_token: resetToken,
    password: "SecurePass123",
    confirm_password: "SecurePass123",
  };
  const result = await post(app, "/api/auth/password-reset/complete", body);

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "reset");
  assert.equal(admin.account.hashed_password, "scrypt$secure-hash");
  assert.equal(admin.account.password_reset_token_hash, null);
  assert.equal(admin.account.password_reset_expires_at, null);
  assert.deepEqual(admin.authUpdates, [
    { id: userId, password: "SecurePass123" },
  ]);

  const replay = await post(app, "/api/auth/password-reset/complete", body);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, "invalid_reset_link");
});

test("phone reset rejects expired reset tokens", async () => {
  const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  const admin = fakeAdmin({
    id: userId,
    mobile: phone,
    hashed_password: "scrypt$old",
    password_reset_token_hash: tokenHash,
    password_reset_expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  const app = appWithHandlers({
    admin,
    verify: fakeVerifyService(),
  });

  const result = await post(app, "/api/auth/password-reset/complete", {
    reset_token: resetToken,
    password: "SecurePass123",
    confirm_password: "SecurePass123",
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error, "invalid_reset_link");
  assert.equal(admin.authUpdates.length, 0);
});
