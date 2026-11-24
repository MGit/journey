# Brief: reader feedback per page (not started)

Status: parked (2026-11-24). Most likely route: a small Cloudflare service.

## Goal
Readers of the locked reader's copy (`read/index.html`, see `tools/lock-book.mjs`) can leave a short note on any page. The notes reach the author's Reflections Studio (AgenticBook) and sit next to the page they are about, the same way the author's own feedback does.

## Constraints
- The site is static on GitHub Pages (`zencreation.org`), so it can't store anything. The notes need a service somewhere else.
- Everyone shares one code, so readers are anonymous. Add an optional "your name" field.
- The service URL ends up in the public page, so anyone could post to it. It needs basic protection against spam and abuse (see below).

## Chosen direction: a Cloudflare Worker with storage (free tier)
1. **Reader side** (`tools/reader-template.html`): a "Leave a note" button at the foot of each page opens a small form (note, optional name). It sends `{ entry, page, section, note, name }` to the Worker.
   - Prerequisite: `dayPage()` in `tools/lock-book.mjs` must add the page's file id (`data-entry="MM-DD"`, `d.id` in the export) to each `<article>`. Page numbers change when the book is reordered, but the file id doesn't.
2. **Worker**: accepts POST from `https://zencreation.org` only (CORS). Checks length (e.g. 2,000 characters at most) and rate-limits by IP. Stores each note in Cloudflare D1 or KV.
   - Possible guard: a token sent with each request and kept inside the encrypted part of the book, so only people who have the code can post.
   - Optional: Cloudflare Turnstile for bots.
3. **Pull into the Studio**: a script in AgenticBook (e.g. `npm run reader-notes`) downloads new notes through an authenticated Worker endpoint. It writes each one as a Studio feedback file, then marks it as fetched:
   - `book/feedback/open/<ISO timestamp>_<MM-DD>.md`
   - Front matter: `target: "MM-DD"`, `created: "<ISO>"`, `status: "open"`, plus a `from: "reader"` / `name` field so reader notes are distinguishable from the author's own (the Studio may need a small change to show this).

## Open questions for the author
- Should notes go straight into `feedback/open/`, or into a separate "reader notes" inbox the author reviews first? A separate inbox is probably better, since `/process-feedback` acts on open notes.
- Should notes be possible on front and back matter, or only on the numbered pages?
- Should readers get a "thanks" confirmation only, or see their own past notes (kept in the browser)?

## Simpler fallbacks, if needed
- An email link per page, with "Page N · Section" pre-filled in the subject.
- A form service (Formspree, Google Forms) with the page number pre-filled. Free plans are usually limited to about 50 notes a month.
