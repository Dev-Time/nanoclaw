# Evaluate and Optimize Playbook Architect Skill

## Objective
Optimize the `playbook-architect` skill's description and instructions to ensure the agent reliably understands exactly **when** and **how** to trigger the skill. This addresses recent session behavior where the agent was confused and failed to activate the skill promptly.

## Key Files & Context
- **Skill File:** `container/skills/playbook-architect/SKILL.md`
- **Context:** The agent failed to activate the skill for several turns despite the user implicitly or explicitly wanting to save session memories, rules, or workflows. The goal is to make the triggering mechanism more robust and less ambiguous for the agent.

## Implementation Steps

### 1. Generate Trigger Eval Queries
- Use the `skill-creator` methodology to generate a set of 20 realistic evaluation queries (JSON format).
- **Should-Trigger Queries:** Include diverse scenarios like complex debugging sessions, declarative preference statements, or explicit requests to "extract rules" or "save this to memory."
- **Should-Not-Trigger Queries:** Include near-misses, such as simple questions about existing files, asking to read a document, or trivial tasks that don't warrant persistent memory extraction.

### 2. Review Eval Set
- Present the generated eval set to the user for review using the `eval_review.html` template.
- Allow the user to tweak the queries and confirm the expected triggering behavior.

### 3. Run Optimization Loop
- Execute the `skill-creator` description optimization loop (`python -m scripts.run_loop`) using the confirmed eval set.
- This will iteratively test the current description against the eval set and use Claude to propose and score improved descriptions.

### 4. Update SKILL.md
- Apply the best-scoring description to the YAML frontmatter of `container/skills/playbook-architect/SKILL.md`.
- Review the body of `SKILL.md` to ensure the internal instructions align with the new description and clearly articulate the *purpose* and *timing* of the skill to the agent, reducing any remaining confusion.

## Verification
- Confirm the new description accurately reflects the intent.
- Test the new triggering logic against a prompt similar to the one that previously caused the agent to stall or get confused.