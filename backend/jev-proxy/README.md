# jev-proxy (prototype)

Local server behind the extension's **Experimental: Jev feed classifier**
toggle. It holds the TypeSafe key (never ship it in the extension) and asks Jev
three narrow questions per feed post; code turns the answers into a verdict.

```bash
node --env-file=../typesafe_jev/.env backend/jev-proxy/server.mjs   # any file with TYPESAFE_API_KEY
```

Listens on `127.0.0.1:8787` only. Each classification is logged to stdout as
JSON (site, scores, verdict, latency, tokens) — no post text.

| Question | Asks |
|---|---|
| `label` | Header carries a paid-promotion label, even garbled ("S p o n s o r e d") |
| `promo` | Text mainly promotes a product, service, app or offer |
| `cta`   | Buttons include a commercial call to action |

Verdict: `label ≥ 0.8` → ad; `promo ≥ 0.8 and cta ≥ 0.8` → likely ad; else content.
These thresholds are starting points, not tuned.

**Privacy:** in this mode, feed post text leaves the browser (to this proxy,
then to TypeSafe). That is why the toggle is off by default. It is a prototype
to measure whether Jev can do the job, not the shipping design.

Measured so far (2026-09-19): mock feed 6/6 correct including a scrambled
label; ~1.2 s per request from India; ~650 input tokens per post (~$0.00003).
