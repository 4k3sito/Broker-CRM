# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | In Notion (`Estado` · `Etapa` · `Notas`)            | Meaning                                  |
| -------------------------- | --------------------------------------------------- | ---------------------------------------- |
| `needs-triage`             | Por hacer · Spec                                    | Maintainer needs to evaluate this issue  |
| `needs-info`               | Bloqueada · — · "falta info: <qué>"                 | Waiting on reporter for more information |
| `ready-for-agent`          | Por hacer · Implementación · "listo para agente"    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | Por hacer · Implementación · "requiere humano"      | Requires human implementation            |
| `wontfix`                  | Hecha · — · "no se hará: <por qué>"                 | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), set the Notion properties from this table.

