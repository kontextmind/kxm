# Antigravity provider (vendored)

Provider-only subset of `pi-antigravity`, built into the kxm plugin.

- Upstream: [Rahularya01/pi-antigravity](https://github.com/Rahularya01/pi-antigravity)
- KontextMind fork: [kontextmind/pi-antigravity](https://github.com/kontextmind/pi-antigravity)
- Fork commit: `86f76ab08f16784be5bfc281dda9c645651a433b`
- License: MIT, Copyright (c) 2026 Rahul Arya — see `LICENSE`

The Pi provider id remains `antigravity` so existing credentials in Pi's auth
store (`/login antigravity`) carry over. This slice vendors Google OAuth
(PKCE, `localhost:51121` callback + paste-URL fallback), Cloud Code Assist
streaming, dynamic model catalog with last-known-good cache and static
fallback, thinking-variant mapping, and quota surfaces used by the model list.

Not vendored here: image generation, `/antigravity.image`, and extra slash
commands (`/antigravity.models`, `/antigravity.doctor`). `usage.ts` is a dead
slash-command surface kept because quota parsing shares client types; it is not
registered. No `@earendil-works/pi-ai` import.
