# Objective
Evaluate and improve the `flight-search` skill according to the `skill-creator` guidelines, then move it to the `telegram_main` session skills directory so it is automatically picked up by agents.

# Key Files & Context
- Source: `/home/whenke/nanoclaw/groups/telegram_main/flight-search/SKILL.md`
- Target Directory: `/home/whenke/nanoclaw/data/sessions/telegram_main/.claude/skills/flight-search`

# Implementation Steps
1. **Rewrite `SKILL.md`**: Update the `flight-search/SKILL.md` file to include proper YAML frontmatter with a "pushy" description, explicit instructions for filtering flights (including the exact `jq` command instead of vaguely referencing one), and improved imperative language.
2. **Move Directory**: Move the entire `flight-search` directory from `/home/whenke/nanoclaw/groups/telegram_main/` to the target directory `/home/whenke/nanoclaw/data/sessions/telegram_main/.claude/skills/`.

# Verification & Testing
- Ensure the `SKILL.md` file has valid YAML frontmatter.
- Verify the directory has been successfully moved to the target location.
- (Optional) Run a test prompt to ensure the skill triggers correctly (if supported in the current environment).