---
name: example-skill
description: Template showing the expected SKILL.md format for auto-ingested skills.
---

# Example Skill

Drop any `*.md` file (optionally nested in a subfolder) under `skills/` and it's
automatically indexed into the VDB at boot (source="skill") and summarized in
the system prompt's "Available Skills" section — the same ingestion pattern
Memograph snapshots use.

- Frontmatter `name`/`description` are optional. If omitted, the name falls
  back to the containing folder name (or filename), and the description falls
  back to the first non-heading line of the body.
- Full content is retrievable via `memory_recall` (filter `source: "skill"`)
  or by reading the file path shown in the system prompt.
- Delete this file once you've added real skills.
