# CodeFlow — Quick Start (run it locally with Docker)

Run the whole app (web UI + API + analysis worker + database + queue) on your machine.
No accounts or cloud setup — just Docker and a free Gemini API key.

## Prerequisites
- **Docker Desktop** installed and **running** (leave it open in the background).
- A **Gemini API key** (free): https://aistudio.google.com/apikey

## Run it (3 steps)

1. **Add your key.** In this folder, create a file named `codeflow.env` with one line:
   ```
   GEMINI_API_KEY=your-key-here
   ```

2. **Start it.**
   - macOS / Linux:  `./start.sh`
   - Windows:        double-click **start.bat** (or run it in a terminal)
   - Or directly:    `docker compose --env-file codeflow.env -f docker-compose.app.yml up -d --build`

   The first run builds the images (a few minutes). After that, starts are quick.

3. **Open** http://localhost:5173 and paste a public GitHub repo URL, e.g.
   `https://github.com/jamiebuilds/the-super-tiny-compiler`

## Handy commands
- Follow logs:  `docker compose -f docker-compose.app.yml logs -f`
- Stop:         `docker compose -f docker-compose.app.yml down`
- Stop + wipe the analyzed-repo database:  `docker compose -f docker-compose.app.yml down -v`

## Notes
- Everything runs locally; your key stays in `codeflow.env` on your machine (don't commit it).
- Embeddings use **Gemini** (one key powers both the AI summary and the Q&A index). Voyage's
  free tier rate-limits at 3 requests/min, so Gemini is the default here.
- Ports used: web **5173**, API **4000**, Mongo 27017, Redis 6379. Change the left-hand number
  in `docker-compose.app.yml` `ports:` if any are taken (also update `CORS_ORIGINS` / `API_BASE_URL`).
