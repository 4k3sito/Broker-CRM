# Issue tracker: Notion

Issues for this repo live in the Notion database **Tareas — OfficeLab**:
https://app.notion.com/p/35a7775c44ee467d99402b87361da28b
(data source `collection://be24b8df-34d2-44e5-8c10-d2cf6b399dc0`). Fetch the database
before writing to use the exact property names.

## Conventions

- One page per ticket. Properties: `Tarea` (title), `Estado`, `Prioridad`, `Tipo`,
  `Etapa`, `Fecha límite`, `Estimación (h)`, `PR / Commit`, `Notas`.
- State lives in `Estado` (Por hacer, En curso, En revisión, Bloqueada, Hecha) and
  `Etapa` (Spec, Implementación, Revisión, Deploy). See `triage-labels.md` for how the
  triage roles map onto them.
- Long specs go to `docs/specs/<slug>.md`, linked from the ticket's `Notas`.
- Comments and conversation go in the page body or as Notion comments.

## When a skill says "publish to the issue tracker"

Create a page in the database above.

## When a skill says "fetch the relevant ticket"

Fetch the Notion page the user references (URL or title search in the database).

`PENDIENTES.md` is a technical log of what was deployed and measured, not a task list.
