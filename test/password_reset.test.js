const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { createPasswordResetRouter } = require("../src/routes/auth");

const userId = "11111111-1111-4111-8111-111111111111";

function fakeAdmin(account) {
  const updates = [];
  return {
    updates,
    from() {
      let action = "select";
      let lookup = null;
      let patch = null;
      const builder = {
        select() {
          action = "select";
          return builder;
        },
        ilike(_column, value) {
          lookup = value;
          return builder;
        },
        eq(_column, value) {
          if (action === "update") {
            updates.push({ ...patch, id: value });
            return Promise.resolve({ error: null });
          }
          lookup = value;
          return builder;
        },
        maybeSingle() {
          const matches =
            action === "select" &&
            (lookup === account?.email || lookup === account?.id);
          return Promise.resolve({
            data: matches ? account : null,
            error: null,
          });
        },
        update(value) {
          action = "update";
          patch = value;
          return builder;
        },
      };
      return builder;
    },
  };
}

function fakePublic() {
  const calls = { email: null, password: null, signOut: false };
  return {
    calls,
    auth: {
      async resetPasswordForEmail(email, options) {
        calls.email = { email, ...options };
        return { error: null };
      },
      async setSession() {
        return { data: { user: { id: userId } }, error: null };
      },
      async updateUser({ password }) {
        calls.password = password;
        return { error: null };
      },
      async signOut(options) {
        calls.signOut = options.scope === "global";
        return { error: null };
      },
    },
  };
}

function appWithResetRouter(dependencies) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth/password-reset",
    createPasswordResetRouter(dependencies),
  );
  return app;
}

async function post(app, path, body, origin) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/auth/password-reset/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: await response.json(),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jwtWithExpiry(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `header.${payload}.signature`;
}

test("password reset rejects invalid email addresses", async () => {
  const result = await post(
    appWithResetRouter(),
    "request",
    { email: "not-an-email" },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_email");
});

test("password reset sends through Supabase and uses the requesting app origin", async () => {
  const admin = fakeAdmin({
    id: userId,
    email: "member@example.com",
    hashed_password: "scrypt$old",
  });
  const auth = fakePublic();
  const result = await post(
    appWithResetRouter({
      getAdmin: () => admin,
      getPublic: () => auth,
    }),
    "request",
    { email: " Member@Example.com " },
    "http://localhost:50485",
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "requested");
  assert.deepEqual(auth.calls.email, {
    email: "member@example.com",
    redirectTo: "http://localhost:50485/forgot-password/new",
  });
});

test("unknown email receives the same response without sending mail", async () => {
  const auth = fakePublic();
  const result = await post(
    appWithResetRouter({
      getAdmin: () => fakeAdmin(null),
      getPublic: () => auth,
    }),
    "request",
    { email: "unknown@example.com" },
    "http://localhost:50485",
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "requested");
  assert.equal(auth.calls.email, null);
});

test("expired recovery tokens cannot reset passwords", async () => {
  const auth = fakePublic();
  const result = await post(
    appWithResetRouter({ getPublic: () => auth }),
    "complete",
    {
      access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) - 1),
      refresh_token: "refresh-token",
      password: "SecurePass123",
      confirm_password: "SecurePass123",
    },
  );

  assert.equal(result.status, 401);
  assert.equal(result.body.error, "reset_link_expired");
  assert.equal(auth.calls.password, null);
});

test("password reset rejects mismatched confirmation", async () => {
  const auth = fakePublic();
  const result = await post(
    appWithResetRouter({ getPublic: () => auth }),
    "complete",
    {
      access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) + 600),
      refresh_token: "refresh-token",
      password: "SecurePass123",
      confirm_password: "DifferentPass123",
    },
  );

  assert.equal(result.status, 400);
  assert.equal(result.body.error, "password_mismatch");
  assert.equal(auth.calls.password, null);
});

test("password reset updates both password stores and revokes sessions", async () => {
  const admin = fakeAdmin({
    id: userId,
    email: "member@example.com",
    hashed_password: "scrypt$old",
  });
  const auth = fakePublic();
  const result = await post(
    appWithResetRouter({
      getAdmin: () => admin,
      getPublic: () => auth,
    }),
    "complete",
    {
      access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) + 600),
      refresh_token: "refresh-token",
      password: "SecurePass123",
      confirm_password: "SecurePass123",
    },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "reset");
  assert.equal(auth.calls.password, "SecurePass123");
  assert.equal(auth.calls.signOut, true);
  assert.equal(admin.updates.length, 1);
  assert.match(admin.updates[0].hashed_password, /^scrypt\$/);
  assert.notEqual(admin.updates[0].hashed_password, "SecurePass123");
});
