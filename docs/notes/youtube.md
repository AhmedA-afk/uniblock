# YouTube: how ads reach the player, and where to cut them

Own notes, 2026-09-19. Sources: our DevTools sessions, plus reading how an
installed third-party extension approaches it (ideas only — no code or list
entries copied; see docs/LICENSING.md).

## What we observed ourselves

- The watch page embeds the player config as `ytInitialPlayerResponse`. Its
  ad schedule lives in `adPlacements`, `playerAds` and `adSlots`. Later
  videos (in-app navigation, autoplay) get the same shape from a
  `/youtubei/v1/player` request.
- During an ad the player element has class `ad-showing`.
- Seeking an ad video to its end ends it, but YouTube then shows a card with
  no video (duration 0) and a Skip button for ~7 s.
- The Skip button (`.ytp-skip-ad-button`) ignores script-dispatched clicks:
  ~30 `.click()` calls had no effect. Script events have `isTrusted: false`.

## Approaches, cheapest to most robust

1. **Skip after the fact** (what we had): mute, seek to end, press Skip.
   Leaves a visible flash and the card; Skip needs a trusted-looking event.
2. **Make our Skip press count**: YouTube's handlers check `isTrusted`.
   Wrapping `addEventListener` in the page's own JS world, before YouTube
   registers its handlers, lets us hand those handlers a view of the event
   that reports `isTrusted: true` — scoped to the Skip button only.
3. **Remove the ad schedule before the player reads it**: in the page's JS
   world at document start, strip the three ad fields from the embedded
   response and from player responses parsed later. No schedule → no ad.
   Most effective, and the most likely to be noticed by YouTube.

We run 3 first, keep 1+2 as the fallback for anything that leaks through.

## Requirements this puts on the extension

- Must run in the MAIN world at `document_start`; the isolated content-script
  world can't see or wrap the page's own objects.
- MAIN-world scripts can't read extension storage, so the per-site pause is
  applied by registering/unregistering the script from the background.
- Wrappers should be Proxies over the originals so they still look native.

## Update: what YouTube actually reacts to (measured, 2026-09-19)

`test/youtube-diagnose.mjs` loads the same videos with and without uniblock.

1. **Blocked health checks.** EasyList/EasyPrivacy block requests YouTube uses
   to confirm ads *could* load (`ad_status.js`, which sets `google_ad_status`,
   `pagead/id`, QoE / ptracking / generate_204 stats). With those blocked,
   first frame went from ~2-3 s to 11 s, 18 s, never. Fix: exceptions in our
   built-in list for youtube.com only.
2. **Removing the ad schedule stalls server-driven streams.** Almost every
   video now streams with `serverAbrStreamingUrl`; the server plans the ads.
   Deleting `adPlacements` client-side left first frame at 6-26 s even with
   nothing blocked. With the schedule left alone: ~2-3 s.
3. **Asking for an ad-free context in the request doesn't work.** The player
   request body is gzip-compressed JSON; once the marker actually reached
   it, YouTube answered `UNPLAYABLE — "This content isn't available"`. The
   server recognises the trick. Dropped.
4. **Skipping an ad saves no time on server-driven streams.** The server
   withholds the real video until the ad's running time has passed: seeking
   a 20 s pre-roll to its end left ~16 s of spinner.
5. **What works: stop and reload through the player's API when the ad
   starts.** `stopVideo()` then `loadVideoById(id, t)` the instant the
   player gets `ad-showing` plays the video instead. Doing it earlier (when
   the player first holds the video) raced the player's own load and lost
   about half the time; on ad start it went 8 of 8, first frame 3.5-4.0 s
   (the same scenario was ~20 s with the ad). Once per video, so a reload
   whose response still lists ads can't loop.

Current results (`node test/youtube-diagnose.mjs 1 without,with 2`): page
loads 2.2-3.4 s vs 1.8-3.4 s without uniblock; in-app hops 0.4-0.9 s; no
error or "interruptions" notice; `google_ad_status` = 1.

Client-decided (older) streams still get the schedule removed from the
response; that path never stalled.
