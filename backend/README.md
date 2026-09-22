# backend (not started)

Planned scope. Nothing here sees users' browsing — no page traffic passes
through it.

- Accounts, licence tokens, payment webhooks (merchant of record)
- The uniblock list: versioned, published as static files behind a CDN
- Report intake: opt-in "this is an ad" reports from the extension
- Jev pipeline: scheduled job that classifies reports into list entries.
  The TypeSafe API key lives here only, never in the extension.
