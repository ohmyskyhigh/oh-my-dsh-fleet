# Fleet user reference

Fleet uses DeepSeek Harness (DSH) workspaces and native sessions. Enable the plugin for a registered workspace, then open a chat in that workspace and send `/fleet help` for the commands and current plan schema.

## Draft, start, and follow a Ticket

1. Send `/fleet new YOUR_REQUEST` and let the planning agent prepare a draft. Include the expected files and how you will check them. Open the Fleet tab to review the draft, dependencies, node assignments, and approval gates.
2. Start the Ticket from Fleet, or send `/fleet start TICKET`. Starting freezes the plan for the run. Independent nodes can run concurrently within the scheduler's available slots. Review the status from the workspace Dashboard or use `/fleet list` and `/fleet show TICKET`.
3. Open the node's native conversation from its details, or use `/fleet thread TICKET NODE`. Each attempt has its own session and can work with files from the shared workspace. The node view shows its stage plan, expected outcomes, model, and planned tools, skills, and plugins.

## Coordinate Tickets and route work

1. In **Edit draft → Upstream dependencies and conditional routes**, select **Upstream Tickets** under **Entire Ticket** or an individual step. Choose Tickets from the same Workspace, then save. An entire Ticket waits for all selected upstream Tickets to deliver. A step waits for its own upstream Tickets while independent steps can run.
2. To start the whole Ticket automatically, choose **Enable start after upstream delivery** on the saved Ticket. You can withdraw authorization with **Disable automatic start** while it is waiting. For a recurring workflow, choose **Match upstream series per occurrence**. To have the upstream series trigger the downstream series, use **Follow upstream series** on the downstream draft.
3. Under **Logic gates**, choose **Add logic gate**, select the handoff source step, and add routes with the steps to run on a match. In the source task, ask the agent to submit the fields as structured `fleet_submit` handoff data. For example, enter `signals` and `change` on separate lines as the handoff path, select `<`, and enter `0` as the comparison value. Every matching route runs. The Ticket details show the recorded route outcomes.
4. Under **Deliverable requirements**, select a producing step for any deliverable that is only required when that step runs. Leave **Always required** selected for deliverables required on every run.

## Review and collect the files

- A human gate waits for a decision from the Ticket. Open the materials, inspect their version, then approve or return them with reasons. An agent gate checks the configured inputs and checklist in its own session. Downstream nodes wait for their gates and dependencies.
- For a gate configured with rework, a return can rerun specified upstream nodes with the findings. Agent returns are subject to the configured rework budget. You can use `/fleet retry TICKET NODE reason` for a manual retry.
- Open the deliverables in the Ticket or send `/fleet deliverables TICKET` to see their current versions and review status. Fleet checks the plan's completion and delivery conditions before settling the Ticket. An explicit delivery override is available to the operator and records a reason.

## Schedule or recover work

- In the chat that created a runnable Ticket, ask Fleet to schedule it. For example, “Schedule this Ticket every Monday at 09:00 Europe/London.” You can also specify a single date and time or a daily time. Fleet returns the series ID and next run. The agent uses `fleet_schedule` directly, so you can keep working in your current window.
- The Schedules tab shows one-time and recurring runs. Create a schedule from a template or Ticket, and check upcoming occurrences in month, week, or day view. Each occurrence has its own Ticket.
- Use `/fleet stop TICKET` to stop a run. After the Ticket is fully stopped, you can revise unfinished work and use `/fleet resume TICKET` to continue that Ticket.
- Use `/fleet health` if the workspace runtime is unavailable. Check the DSH version, that the plugin is enabled, and that the current session belongs to a registered workspace. `/fleet catalog` shows shared templates and the models and settings available to a plan.
