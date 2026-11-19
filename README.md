# Xingchi API proxy for Vercel

An authenticated reverse proxy for Xingchi's API. It forwards the common Anthropic Messages route and OpenAI-compatible Chat Completions/Responses routes to the fixed origin `https://api.xingchiapi.com`. The Xingchi key stays on the server; callers use a separate proxy token.

## Deploy

1. Import this folder into a GitHub repository and import that repository into Vercel.
2. In Vercel Project Settings → Environment Variables, set `XINGCHI_API_KEY` to the API key from your Xingchi account.
3. Set `PROXY_ACCESS_TOKEN` to a random secret with at least 32 characters. Generate one locally: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. Set `UPSTREAM_AUTH_MODE` to `authorization` or `x-api-key`, according to Xingchi's current API/account instructions. Set `MAX_OUTPUT_TOKENS` to a preferred cap from 1 to 8192; default is 2048.
5. Redeploy and test before sharing the URL.

Never place `XINGCHI_API_KEY` in frontend code or a public GitHub repo. Do not publish `PROXY_ACCESS_TOKEN`: anyone who has it can use the shared Xingchi quota. This starter has shared-token access only; it does not provide per-user accounts, billing, or durable quotas. Add those before turning it into a public paid service.

## Client configuration

The Vercel function is mounted under `/api`:

- Anthropic-compatible clients: base URL `https://YOUR-DEPLOYMENT.vercel.app/api`
- OpenAI-compatible clients: base URL `https://YOUR-DEPLOYMENT.vercel.app/api/v1`

Supported requests: `GET /v1/models`, `POST /v1/messages`, `POST /v1/chat/completions`, `POST /v1/responses`. The proxy forwards streaming responses and the documented protocol headers. Requests without a requested output limit receive the configured default; larger limits are rejected.

Configure the client with `PROXY_ACCESS_TOKEN` as its API key. The proxy replaces caller credentials with `XINGCHI_API_KEY` upstream. Your target application must let you set a custom base URL and use the matching request protocol. This cannot turn an API key into a separate product login or make an incompatible protocol work automatically.

## Verify

Run `npm test` with Node.js 20 or newer. Deploy with the Vercel dashboard or Vercel CLI. Do not use an upstream API key in the test environment.
