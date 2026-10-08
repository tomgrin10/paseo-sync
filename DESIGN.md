# Sync interface

This surface inherits Paseo's existing native plugin design system. Operate mode: the task is a verified workspace transfer.

Use host theme tokens for backgrounds, borders, foreground, muted foreground, accent, accent foreground, success, warning, and error. Body text uses the platform UI font at 14px with 21px line height. The page title uses 26px / 700; preview title uses 18px / 600. Inputs and buttons are at least 44px high, with 6px corners and 1px theme borders. Content is at most 760px wide, centered with 28px desktop padding or 16px compact padding. Groups have 24px separation and related controls use 8–12px gaps.

Order follows the task: direction, host, workspace, destination, copy/move, preview, transfer, result. Optional connection fields wrap into a column on compact layouts. Workspace choices form one bounded scrolling list; full titles remain readable and filesystem paths truncate separately. Action labels name their result. A theme accent identifies selected controls and the primary action. Errors and transfer progress stay inline.

No independent header chrome, decorative imagery, chart, hero metrics, or identity layer is added. Screenshot fixtures use a representative dark Paseo palette; production receives its colors from the host.
