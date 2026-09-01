# InfoVision Intelligence — Frontend

React + Vite UI for the Projects API.

## Prerequisites
- Node.js 18+
- The FastAPI backend running (default `http://localhost:8000`)

## Setup

```bash
cd frontend
npm install
cp .env.example .env   # adjust VITE_API_BASE_URL if your backend isn't on :8000
npm run dev
```

The app opens at http://localhost:5173.

## Backend

The backend must be running and reachable. Start it from the repo root, e.g.:

```bash
uvicorn main:app --reload --port 8000
```

CORS is already enabled in `main.py` for local development.

## What it does
- **Projects screen** — lists projects from `GET /projects` as cards (loading skeleton, empty, and error states).
- **Add New Project** — button + dashed add-card open a modal that `POST`s to `/projects`, then prepends the new project.
- **Delete** — hover a card and click the trash icon (`DELETE /projects/{id}`, optimistic with rollback).
- **Theme** — light/dark toggle in the top bar (persisted to `localStorage`).

## Config
- `VITE_API_BASE_URL` — base URL of the backend API (default `http://localhost:8000`).

## Project structure
```
src/
  api/projects.js          # fetch wrappers for the CRUD endpoints
  components/
    Icons.jsx              # inline SVG icons + pastel tile palette
    ProjectCard.jsx        # one project card
    AddProjectModal.jsx    # create-project dialog
  App.jsx                  # projects screen + state
  index.css               # all styles (light/dark via [data-theme])
```
