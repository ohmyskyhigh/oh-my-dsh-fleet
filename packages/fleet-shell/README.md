# oh-my-dsh-fleet

**Run your DSH like a company.** Fleet turns a request in DeepSeek Harness (DSH) into a Ticket with an executable SOP. Define roles, dependencies, handoffs, review gates, and deliverables, then follow each stage in its native DSH session.

## Compatibility

This bundle is `@dsh-fleet/shell` version `0.9.8` for DeepSeek Harness `0.2.2-rc.5`. DSH supplies workspaces, sessions, and the model catalog.

## First run

1. Enable Fleet for a registered DSH workspace from the Fleet sidebar.
2. Open a workspace chat and send `/fleet new YOUR_REQUEST`. Inspect the draft in the Fleet tab, then start it when the plan is ready.
3. Track the steps from the Ticket, open node conversations for details, and use the review gates and deliverables to inspect the results.

Send `/fleet help` in a workspace chat for available commands and the plan format.

Fleet is available under the [MIT License](LICENSE). See the [third-party notices](THIRD-PARTY-NOTICES.txt) for attribution.
