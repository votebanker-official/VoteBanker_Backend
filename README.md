# VOTE BANKER backend

This is the Node.js API starter. It does not send messages, store data, or connect to AWS yet.

## Run it

```bash
cd backend
npm install
npm run dev
```

Then open http://127.0.0.1:5000/api/health

You should see:

```json
{
  "status": "ok",
  "service": "VOTE BANKER backend"
}
```

## Settings

Copy `.env.example` to `.env` only on your own computer when you need settings. Leave the example values empty. Never commit `.env` or real passwords, API keys, or Twilio credentials.
