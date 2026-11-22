# Fleet user reference

Fleet uses DeepSeek Harness (DSH) workspaces and native sessions. Enable the plugin for a registered workspace, then open a chat in that workspace and send `/fleet help` for the commands and current plan schema.

## Draft, start, and follow a Ticket

1. Send `/fleet new YOUR_REQUEST` and let the planning agent prepare a draft. Include the expected files and how you will check them. Open the Fleet tab to review the draft, dependencies, node assignments, and approval gates.
2. Start the Ticket from Fleet, or send `/fleet start TICKET`. Starting freezes the plan for the run. Independent nodes can run concurrently within the scheduler's available slots. Review the status from the workspace Dashboard or use `/fleet list` and `/fleet show TICKET`.
3. Open the node's native conversation from its details, or use `/fleet thread TICKET NODE`. Each attempt has its own session and can work with files from the shared workspace. The node view shows its stage plan, expected outcomes, model, and planned tools, skills, and plugins.

## Review and collect the files

- A human gate waits for a decision from the Ticket. Open the materials, inspect their version, then approve or return them with reasons. An agent gate checks the configured inputs and checklist in its own session. Downstream nodes wait for their gates and dependencies.
- For a gate configured with rework, a return can rerun specified upstream nodes with the findings. Agent returns are subject to the configured rework budget. You can use `/fleet retry TICKET NODE reason` for a manual retry.
- Open the deliverables in the Ticket or send `/fleet deliverables TICKET` to see their current versions and review status. Fleet checks the plan's completion and delivery conditions before settling the Ticket. An explicit delivery override is available to the operator and records a reason.

## Schedule or recover work

- The Schedules tab shows one-time and recurring runs. Create a schedule from a template or Ticket, and check upcoming occurrences in month, week, or day view. Each occurrence has its own Ticket.
- Use `/fleet stop TICKET` to stop a run. After the Ticket is fully stopped, you can revise unfinished work and use `/fleet resume TICKET` to continue that Ticket.
- Use `/fleet health` if the workspace runtime is unavailable. Check the DSH version, that the plugin is enabled, and that the current session belongs to a registered workspace. `/fleet catalog` shows shared templates and the models and settings available to a plan.
