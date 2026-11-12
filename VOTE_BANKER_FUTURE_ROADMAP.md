# VOTE BANKER Future Implementation Roadmap

## Goal

Turn the current VOTE BANKER Flutter application and Node/Express backend into a reliable, production-ready platform for political profile management, campaign operations, content generation, websites, social integrations, volunteers, teams, merchandise, and voter-roll workflows.

## Current foundation

- Flutter web/mobile frontend in `VoteBanker_Frontend-main`.
- Node.js/Express backend in `VoteBanker_Backend-main`.
- Supabase Auth and PostgreSQL database.
- Demo WhatsApp OTP mode for client presentations.
- Profile-aware onboarding and phone-number-specific profile storage.
- Existing backend areas for websites, domains, letters, speech generation, VRM, social media, volunteers, teams, merchandise, and locations.

## Phase 0 — Stabilize the demo

**Priority: immediate**

- Keep `OTP_PROVIDER=demo` enabled only for local/client demonstrations.
- Test the complete flow with at least three different phone numbers:
  - New number → Profile Setup.
  - Save profile → dashboard or saved last route.
  - Different number → blank profile with only its own phone number.
  - Return to first number → first user’s saved name and data.
- Apply and verify the `demo_accounts` migration in Supabase.
- Confirm `.env` is ignored and no credentials are committed.
- Remove stale browser sessions before client demonstrations.
- Add a visible demo-mode label or internal demo configuration indicator.

**Acceptance criteria**

- No user sees another user’s name, phone number, photo, draft, or route.
- OTP verification never traps a valid user on the phone-entry page.
- Backend errors show a useful message and do not silently create incorrect data.

## Phase 1 — Authentication and account security

**Priority: highest before real users**

- Replace demo OTP with Twilio WhatsApp Verify after the sender and service are approved.
- Keep SMS disabled if WhatsApp-only authentication is required.
- Add OTP resend cooldown, attempt limits, abuse protection, and audit logging.
- Add sign-out and session-expiry handling across all protected screens.
- Test Google and Facebook OAuth with real provider credentials.
- Add a clear account deletion/data-export process.
- Rotate every credential previously exposed during development.
- Add production safeguards that refuse demo OTP mode when `NODE_ENV=production`.

**Acceptance criteria**

- Only verified phone numbers can create sessions.
- Expired, replayed, or excessive OTP attempts are rejected.
- A user cannot access another user’s Supabase records by changing request data.

## Phase 2 — Profile and onboarding

- Finish all profile fields and validation.
- Persist every onboarding step, not only the final profile.
- Add explicit onboarding status and current step to the database.
- Implement profile photo upload using Supabase Storage.
- Add image size/type validation and deletion.
- Add profile preview and edit mode.
- Add localization coverage for all user-facing strings.
- Add recovery when a user closes the browser halfway through onboarding.

**Acceptance criteria**

- A user can leave and resume onboarding from the last completed step.
- Profile data is correctly isolated by authenticated Supabase user ID.
- Blank fields do not erase previously saved values unintentionally.

## Phase 3 — Dashboard and campaign operations

- Replace the dashboard placeholder with real summaries:
  - Profile completion.
  - Website status.
  - Volunteer count.
  - Team count.
  - VRM/contact progress.
  - Recent activity.
- Add notifications for incomplete setup and failed background tasks.
- Add a consistent loading, empty, retry, and error state to every module.
- Add navigation guards for unauthenticated users.

## Phase 4 — Website builder and domains

- Complete website draft persistence and restore.
- Add server-side validation for generated content and custom domains.
- Connect domain search to production Openprovider credentials.
- Add payment gateway integration.
- Verify payment server-to-server before allowing publish.
- Implement domain purchase/order status tracking.
- Add publish, unpublish, preview, and deployment status screens.
- Store website assets securely and apply upload limits.

**Acceptance criteria**

- A website cannot be published without verified payment.
- Users can edit and recover drafts without losing content.
- Domain orders have an auditable status and failure reason.

## Phase 5 — AI letters, speeches, and content

- Configure a production AI provider with server-only keys.
- Add request limits, usage tracking, and cost controls.
- Validate prompts and user-provided content.
- Add saved drafts, regeneration, edit, export, and delete actions.
- Add clear fallback behavior when the AI provider is unavailable.
- Review generated political content for misleading or unsafe claims.

## Phase 6 — Social media integrations

- Complete OAuth setup for each supported provider.
- Store tokens encrypted server-side.
- Implement token refresh and revoked-token handling.
- Add connection status, disconnect, and reconnect controls.
- Add post scheduling, previews, publishing, and provider error handling.
- Never expose provider access tokens to Flutter logs or client storage.

## Phase 7 — Volunteers and teams

- Complete volunteer CRUD and profile management.
- Add role-based access for administrators, campaign managers, and volunteers.
- Add team invitations and membership approval.
- Add tasks, assignment, status, due dates, and activity history.
- Add duplicate-phone/email detection and import validation.
- Add pagination and search for large campaigns.

## Phase 8 — VRM and voter data

- Define the legal source and permitted use of voter-roll data.
- Add secure import, validation, deduplication, and rollback.
- Move OCR/import work to a background job for large files.
- Add permissions and audit logs for sensitive voter data.
- Add contact status, notes, and assignment workflows.
- Add retention and deletion policies.

## Phase 9 — Merchandise and payments

- Connect product catalog to persistent database records.
- Add cart/order state, inventory, fulfillment, and cancellation handling.
- Integrate a payment gateway using server-side verification.
- Add webhook signature verification and idempotent order updates.
- Ensure prices and order totals are calculated on the server.

## Phase 10 — Production quality and operations

- Add automated backend unit and integration tests for every route.
- Add Flutter widget and integration tests for login, onboarding, dashboard, and recovery.
- Add a staging Supabase project separate from production.
- Add database migrations to CI/CD.
- Add structured logs, request IDs, error monitoring, and uptime monitoring.
- Add rate limits per route and secure CORS configuration.
- Add backups and a tested restore procedure.
- Add privacy policy, terms, consent, and data-retention documentation.
- Run a security review before launch.

## Recommended testing matrix

### Authentication

- New number, existing number, invalid number, wrong OTP, expired OTP, resend, refresh, sign-out.
- Google and Facebook success, denial, callback failure, duplicate account.

### Account isolation

- Two phone numbers in one browser.
- Two browsers with different users.
- Refresh during every onboarding step.
- Profile, photo, website, volunteer, and team access with the wrong token.

### Reliability

- Backend unavailable.
- Supabase unavailable.
- Rate limit response.
- Slow AI/provider response.
- Invalid provider callback.
- Interrupted upload or payment webhook retry.

## Deployment checklist

1. Create separate development, staging, and production Supabase projects.
2. Apply migrations through a repeatable deployment process.
3. Configure production secrets only in Railway/Vercel secret stores.
4. Disable demo OTP in production.
5. Configure WhatsApp Verify and OAuth redirect URLs.
6. Configure CORS to allow only the production frontend.
7. Deploy backend and verify `/api/health`.
8. Deploy frontend with the production API URL.
9. Run the authentication and account-isolation test matrix.
10. Monitor logs and errors during the first client rollout.

## Suggested order of work

1. Finish and demonstrate Phase 0.
2. Harden authentication and account isolation.
3. Complete profile persistence and photo storage.
4. Build the real dashboard.
5. Finish website and payment workflows.
6. Complete AI, social, volunteer, team, VRM, and merchandise modules one at a time.
7. Add full automated testing and production operations before public launch.

## Definition of “ready for clients”

- Demo mode is stable and clearly separated from production mode.
- Login, OTP, profile creation, profile recovery, and sign-out work reliably.
- Every visible module has working loading, empty, success, and error states.
- No secrets are in source code, browser storage, logs, or chat.
- Database access is authenticated, authorized, backed up, and tested.
- Client-facing flows have been tested on the target browsers and devices.
